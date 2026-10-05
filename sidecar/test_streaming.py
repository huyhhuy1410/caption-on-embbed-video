import unittest

import numpy as np

from app.model_runtime import DecodeResult, LanguageEvidence
from app.settings import SAMPLE_RATE, Settings
from app.streaming import RollingAudio, Scope, StreamingTranscript


def result(texts, start=0.0):
    return DecodeResult([{"w": text, "s": start + i * 0.2, "e": start + i * 0.2 + 0.15,
                          "c": 0.9, "segmentEnd": i == len(texts) - 1}
                         for i, text in enumerate(texts)], "en", 0.95, bool(texts))


class StreamingTests(unittest.TestCase):
    def setUp(self):
        self.audio = RollingAudio()
        for i in range(4):
            self.audio.append(np.ones(SAMPLE_RATE, dtype=np.float32),
                              {"frameStartVideoTime": 10 + i, "capturedAtEpochMs": 1000 + i * 1000})
        self.snapshot = self.audio.snapshot()
        self.transcript = StreamingTranscript(Scope("session", 2, "video"))

    def test_revise_shorten_remove_and_stable_ids(self):
        first = self.transcript.update(result(["Hello", "wrong", "tail"]), self.snapshot)
        second = self.transcript.update(result(["Hello", "world"]), self.snapshot)
        self.assertEqual(first["words"][0]["wordId"], second["words"][0]["wordId"])
        self.assertEqual(first["words"][1]["wordId"], second["words"][1]["wordId"])
        self.assertEqual(second["removedWordIds"], [first["words"][2]["wordId"]])
        self.assertFalse(second["words"][0]["provisional"])
        self.assertTrue(second["words"][1]["provisional"])
        self.assertEqual(second["revision"], 2)
        self.assertEqual(first["captions"][0]["captionId"], second["captions"][0]["captionId"])
        empty = self.transcript.update(result([]), self.snapshot)
        self.assertEqual(empty["removedWordIds"], [first["words"][1]["wordId"]])
        self.assertEqual(empty["captions"][0]["wordIds"], [first["words"][0]["wordId"]])

    def test_finalized_caption_immutable_and_not_removed(self):
        first = self.transcript.update(result(["Hello."]), self.snapshot)
        second = self.transcript.update(result(["Hello."]), self.snapshot)
        self.assertTrue(second["captions"][0]["finalized"])
        third = self.transcript.update(result(["Hello.", "Next"]), self.snapshot)
        self.assertNotIn(first["words"][0]["wordId"], [w["wordId"] for w in third["words"]])
        self.assertEqual(third["removedWordIds"], [])
        self.assertEqual(third["removedCaptionIds"], [])
        self.assertNotEqual(first["captions"][0]["captionId"], third["captions"][0]["captionId"])

    def test_timestamp_revision_above_half_second_preserves_identity(self):
        first = self.transcript.update(result(["Moving"], 0.0), self.snapshot)
        second = self.transcript.update(result(["Moving"], 1.1), self.snapshot)
        self.assertEqual(first["words"][0]["wordId"], second["words"][0]["wordId"])
        self.assertTrue(second["words"][0]["provisional"])
        self.assertAlmostEqual(second["words"][0]["videoStart"], 11.1)

    def test_true_repetition_is_not_text_deduped(self):
        first = self.transcript.update(result(["very", "very", "good."]), self.snapshot)
        second = self.transcript.update(result(["very", "very", "good."]), self.snapshot)
        self.assertEqual(len(second["words"]), 3)
        self.assertEqual(len(set(w["wordId"] for w in first["words"])), 3)
        self.assertTrue(second["captions"][0]["finalized"])

    def test_retract_empty_caption(self):
        first = self.transcript.update(result(["Noise"]), self.snapshot)
        empty = self.transcript.update(result([]), self.snapshot)
        self.assertEqual(empty["removedCaptionIds"], [first["captions"][0]["captionId"]])
        self.assertEqual(empty["removedWordIds"], [first["words"][0]["wordId"]])

    def test_flush_final_tail_uses_new_decode(self):
        first = self.transcript.update(result(["wrong"]), self.snapshot)
        flush = self.transcript.update(result(["right"]), self.snapshot, flush=True)
        self.assertEqual(flush["words"][0]["w"], "right")
        self.assertEqual(flush["words"][0]["wordId"], first["words"][0]["wordId"])
        self.assertTrue(flush["captions"][0]["finalized"])
        self.assertFalse(flush["words"][0]["provisional"])

    def test_separate_sample_anchors_after_rolling_trim(self):
        audio = RollingAudio(2 * SAMPLE_RATE)
        for i in range(3):
            audio.append(np.ones(SAMPLE_RATE, dtype=np.float32),
                         {"frameStartVideoTime": [50, 100, 101][i], "capturedAtEpochMs": 1000 + i * 1000})
        self.assertEqual(len(audio.audio), 2 * SAMPLE_RATE)
        self.assertEqual(len(audio.anchors), 2)
        update = self.transcript.update(result(["word"], 1.2), audio.snapshot())
        self.assertEqual(update["words"][0]["videoStart"], 101.2)
        self.assertEqual(update["words"][0]["capturedAtEpochMs"], 3200)
        self.assertEqual(update["words"][0]["s"], 1.2)

    def test_caption_safety_cap_and_segment_gap(self):
        transcript = StreamingTranscript(Scope(), max_words=2)
        first = transcript.update(result(["a", "b", "c"]), self.snapshot)
        update = transcript.update(result(["a", "b", "c"]), self.snapshot)
        self.assertTrue(update["captions"][0]["finalized"])
        self.assertFalse(first["captions"][1]["finalized"])
        self.assertEqual(len(transcript.captions), 1)

    def test_segment_gap_finalizes_only_after_agreement(self):
        decoded = DecodeResult([
            {"w": "First", "s": 0.0, "e": 0.2, "c": 0.9, "segmentEnd": True},
            {"w": "Second", "s": 1.0, "e": 1.2, "c": 0.9, "segmentEnd": True},
        ], "en", 0.9, True)
        first = self.transcript.update(decoded, self.snapshot)
        self.assertEqual(len(first["captions"]), 2)
        self.assertFalse(first["captions"][0]["finalized"])
        second = self.transcript.update(decoded, self.snapshot)
        self.assertTrue(second["captions"][0]["finalized"])
        self.assertEqual(first["captions"][0]["captionId"], second["captions"][0]["captionId"])

    def test_long_finalized_history_does_not_accumulate_in_sidecar(self):
        for index in range(100):
            audio = RollingAudio()
            audio.start = audio.end = index * SAMPLE_RATE
            audio.append(np.ones(SAMPLE_RATE, dtype=np.float32),
                         {"frameStartVideoTime": index, "capturedAtEpochMs": index * 1000})
            snapshot = audio.snapshot()
            self.transcript.update(result(["done."]), snapshot)
            update = self.transcript.update(result(["done."]), snapshot)
            self.assertTrue(update["captions"][0]["finalized"])
            self.assertEqual(len(self.transcript.visible), 0)
            self.assertEqual(len(self.transcript.captions), 0)
            self.assertEqual(len(self.transcript.open_words), 0)

    def test_settings_and_language_hysteresis(self):
        self.assertEqual(Settings.from_env({}).mode, "windowed")
        for model in ["tiny", "small", "medium"]:
            self.assertEqual(Settings.from_env({"WHISPER_MODEL": model}).model, model)
        with self.assertRaises(ValueError):
            Settings.from_env({"WHISPER_MODEL": "large"})
        evidence = LanguageEvidence()
        voiced = DecodeResult([], "vi", 0.9, True)
        evidence.observe(voiced)
        evidence.observe(DecodeResult([], "en", 1, False))
        self.assertIsNone(evidence.decode_language)
        evidence.observe(voiced)
        evidence.observe(voiced)
        self.assertEqual(evidence.decode_language, "vi")
        evidence.selected = "fr"
        evidence.reset()
        self.assertEqual(evidence.decode_language, "fr")


if __name__ == "__main__":
    unittest.main()
