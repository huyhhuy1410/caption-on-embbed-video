import asyncio
import json
import threading
import time
from types import SimpleNamespace
import unittest

import numpy as np

import app.main as main
from app.main import windowed_payload
from app.model_runtime import DecodeResult, ModelRuntime
from app.session import CaptionSession
from app.settings import SAMPLE_RATE, Settings
from app.streaming import Scope


class FakeModel:
    def __init__(self):
        self.active = 0
        self.peak = 0
        self.calls = []
        self.thread_ids = []

    def transcribe(self, audio, **kwargs):
        def segments():
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.thread_ids.append(threading.get_ident())
            self.calls.append((len(audio), kwargs.get("language")))
            try:
                time.sleep(0.03)
                word = SimpleNamespace(word="Hello", start=0.0, end=0.2, probability=0.9)
                yield SimpleNamespace(words=[word], no_speech_prob=0.1)
            finally:
                self.active -= 1
        return segments(), SimpleNamespace(language="en", language_probability=0.95, duration_after_vad=1)


def metadata(generation=1, seq=1):
    return {"type": "audio", "sessionId": "s", "generation": generation, "sourceId": "v",
            "seq": seq, "sampleRate": SAMPLE_RATE, "frames": SAMPLE_RATE,
            "frameStartVideoTime": seq - 1, "videoTimeAtCapture": seq,
            "capturedAtEpochMs": seq * 1000}


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.model = FakeModel()
        self.runtime = ModelRuntime(Settings(mode="streaming"), lambda *args, **kwargs: self.model)
        self.runtime.start()
        await self.runtime.load_task
        self.messages = []
        async def send(message):
            self.messages.append(message)
        self.session = CaptionSession(self.runtime, send, windowed_payload)

    async def asyncTearDown(self):
        await self.session.close()
        await self.runtime.close()

    async def test_global_one_inference_even_after_cancel(self):
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        first = asyncio.create_task(self.runtime.decode(audio, None))
        await asyncio.sleep(0.01)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        await asyncio.gather(self.runtime.decode(audio, None), self.runtime.decode(audio, "vi"))
        self.assertEqual(self.model.peak, 1)
        self.assertTrue(all(t != threading.get_ident() for t in self.model.thread_ids))
        self.assertEqual(self.model.calls[-1][1], "vi")

    async def test_coalesce_and_bound_slow_pending(self):
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        self.session.audio(audio, metadata(seq=1))
        await asyncio.sleep(0.005)
        for seq in range(2, 21):
            self.session.audio(audio, metadata(seq=seq))
        self.assertEqual(len(self.session.rolling.audio), 12 * SAMPLE_RATE)
        self.assertEqual(len(self.session.pending.snapshot.audio), 12 * SAMPLE_RATE)
        await self.session.worker
        self.assertEqual(len(self.model.calls), 2)
        self.assertEqual(self.model.calls[-1][0], 12 * SAMPLE_RATE)

    async def test_waiting_connection_coalesces_before_global_gate(self):
        messages = []
        async def send(message):
            messages.append(message)
        other = CaptionSession(self.runtime, send, windowed_payload)
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        try:
            self.session.audio(audio, metadata())
            await asyncio.sleep(0.005)
            other.audio(audio, metadata())
            await asyncio.sleep(0.005)
            for seq in range(2, 8):
                other.audio(audio, metadata(seq=seq))
            await asyncio.gather(self.session.worker, other.worker)
            self.assertEqual(self.model.peak, 1)
            self.assertEqual(self.model.calls, [(SAMPLE_RATE, None), (7 * SAMPLE_RATE, None)])
            self.assertEqual(len(messages), 1)
        finally:
            await other.close()

    async def test_reset_during_decode_suppresses_old_result(self):
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        self.session.audio(audio, metadata())
        await asyncio.sleep(0.005)
        self.session.control({"type": "reset", **metadata(2)})
        await self.session.worker
        self.assertEqual(self.messages, [])
        self.session.audio(audio, metadata(1, 2))
        self.assertEqual(len(self.session.rolling.audio), 0)
        self.session.audio(audio, metadata(2, 3))
        await self.session.worker
        self.assertEqual(self.messages[0]["generation"], 2)
        self.assertEqual(self.messages[0]["revision"], 1)

    async def test_duplicate_scope_control_does_not_regress_revision(self):
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        self.session.audio(audio, metadata())
        await self.session.worker
        self.session.control({**metadata(), "type": "reset"})
        self.session.audio(audio, metadata(seq=2))
        await self.session.worker
        self.assertEqual([message["revision"] for message in self.messages], [1, 2])

    async def test_disconnect_suppresses_and_clears_pending(self):
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        self.session.audio(audio, metadata())
        await asyncio.sleep(0.005)
        self.session.audio(audio, metadata(seq=2))
        await self.session.close()
        await asyncio.sleep(0.04)
        self.assertEqual(self.messages, [])
        self.assertIsNone(self.session.pending)

    async def test_language_control_persists_and_applies_to_model(self):
        self.session.control({**metadata(), "type": "source-language", "language": "vi"})
        self.session.control({**metadata(2), "type": "reset"})
        self.session.audio(np.ones(SAMPLE_RATE, dtype=np.float32), metadata(2))
        await self.session.worker
        self.assertEqual(self.model.calls[0][1], "vi")

    async def test_pause_flush_finalizes_and_drops_audio_until_playing(self):
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        self.session.audio(audio, metadata())
        await self.session.worker
        self.session.control({**metadata(), "type": "playback", "state": "paused"})
        await self.session.worker
        self.assertTrue(self.messages[-1]["captions"][0]["finalized"])
        self.assertEqual(len(self.session.rolling.audio), 0)
        self.session.audio(audio, metadata(seq=2))
        self.assertEqual(len(self.session.rolling.audio), 0)
        self.session.control({**metadata(), "type": "playback", "state": "playing"})
        self.session.audio(audio, metadata(seq=3))
        await self.session.worker
        self.assertEqual(len(self.model.calls), 3)

    async def test_post_commit_trim_keeps_preroll_and_absolute_anchors(self):
        snapshots = []

        async def decode(audio, language):
            snapshot = self.session.rolling.snapshot()
            snapshots.append(snapshot)
            start = 2.2 - snapshot.start / SAMPLE_RATE
            end = 2.5 - snapshot.start / SAMPLE_RATE
            return DecodeResult([
                {"w": "Hello.", "s": start, "e": end, "c": 0.9, "segmentEnd": True},
            ], "en", 0.95, True)

        self.runtime.decode = decode
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        for seq in range(1, 4):
            self.session.audio(audio, metadata(seq=seq))
        await self.session.worker
        word_id = self.messages[-1]["words"][0]["wordId"]
        self.assertEqual(self.session.rolling.start, 0)

        self.session.audio(audio, metadata(seq=4))
        await self.session.worker
        committed = round(2.5 * SAMPLE_RATE)
        self.assertEqual(self.session.transcript.committed_end, committed)
        self.assertEqual(self.session.rolling.start, committed - SAMPLE_RATE)
        self.assertEqual(self.session.rolling.end, 4 * SAMPLE_RATE)
        self.assertEqual(len(self.session.rolling.audio), round(2.5 * SAMPLE_RATE))
        word = self.messages[-1]["words"][0]
        self.assertEqual(word["wordId"], word_id)
        self.assertFalse(word["provisional"])
        self.assertEqual((word["videoStart"], word["videoEnd"]), (2.2, 2.5))
        self.assertEqual(word["capturedAtEpochMs"], 3200)

        self.session.audio(audio, metadata(seq=5))
        await self.session.worker
        self.assertEqual(snapshots[-1].start, committed - SAMPLE_RATE)
        self.assertEqual(len(snapshots[-1].audio), round(3.5 * SAMPLE_RATE))
        video, epoch = snapshots[-1].locate(round(2.2 * SAMPLE_RATE))
        self.assertAlmostEqual(video, 2.2)
        self.assertAlmostEqual(epoch, 3200)
        self.assertEqual(self.messages[-1]["words"], [])
        self.assertEqual(self.messages[-1]["removedWordIds"], [])
        self.assertEqual(self.session.transcript.committed_end, committed)

    async def test_windowed_first_anchor_and_overlap_unchanged(self):
        self.runtime.settings = Settings(mode="windowed")
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        for seq in [1, 2]:
            self.session.audio(audio, {**metadata(seq=seq), "videoTimeAtCapture": 10 + seq})
        await self.session.worker
        self.assertEqual(self.messages[0]["words"][0]["videoStart"], 11)
        self.assertNotIn("mode", self.messages[0])
        for seq in [3, 4]:
            self.session.audio(audio, {**metadata(seq=seq), "videoTimeAtCapture": 10 + seq})
        await self.session.worker
        self.assertEqual(self.messages[1]["words"][0]["videoStart"], 11.5)

    async def test_websocket_control_boundary_and_stale_generation(self):
        import json
        audio = np.ones(SAMPLE_RATE, dtype=np.int16).tobytes()
        stale = metadata(1, 1)
        current = metadata(2, 2)
        class Socket:
            def __init__(self):
                self.messages = []
                self.events = iter([
                    {"text": json.dumps(stale)},
                    {"text": json.dumps({**current, "type": "reset"})},
                    {"bytes": audio},
                    {"text": json.dumps(stale)},
                    {"bytes": audio},
                    {"text": json.dumps(current)},
                    {"bytes": audio},
                    {"type": "websocket.disconnect"},
                ])
            async def accept(self):
                pass
            async def send_json(self, message):
                self.messages.append(message)
            async def receive(self):
                event = next(self.events)
                if event.get("type") == "websocket.disconnect":
                    await asyncio.sleep(0.1)
                return event
        original = main.runtime
        main.runtime = self.runtime
        try:
            socket = Socket()
            await main.websocket_endpoint(socket)
            words = [message for message in socket.messages if message["type"] == "words"]
            self.assertEqual(len(words), 1)
            self.assertEqual(words[0]["generation"], 2)
            self.assertEqual(len(self.model.calls), 1)
        finally:
            main.runtime = original

    async def test_streaming_decode_emits_latency_line_with_revision(self):
        """Streaming phải có `LAT` để đối chiếu độ trễ decode với `LAG` của overlay."""
        lines = []
        original_runtime = main.runtime
        main.runtime = self.runtime

        class Socket:
            def __init__(self):
                audio = np.ones(SAMPLE_RATE, dtype=np.int16).tobytes()
                self.events = iter([
                    {"text": json.dumps(metadata(1, 1))},
                    {"bytes": audio},
                    {"text": json.dumps(metadata(1, 2))},
                    {"bytes": audio},
                    {"type": "websocket.disconnect"},
                ])

            async def accept(self):
                pass

            async def send_json(self, message):
                pass

            async def receive(self):
                event = next(self.events)
                # Nhường event loop cho worker drain trước frame kế tiếp, nếu
                # không hai frame sẽ bị coalesce thành một lượt decode.
                await asyncio.sleep(0.1 if event.get("type") == "websocket.disconnect" else 0.05)
                return event

        original_log = main.log_latency
        main.log_latency = lambda record, whisper_seconds, started: lines.append(record)
        try:
            await main.websocket_endpoint(Socket())
        finally:
            main.log_latency = original_log
            main.runtime = original_runtime
        self.assertEqual(len(lines), 2)
        self.assertEqual([r["mode"] for r in lines], ["streaming", "streaming"])
        self.assertEqual([r["kind"] for r in lines], ["steady", "steady"])
        self.assertEqual([r["samples"] for r in lines], [SAMPLE_RATE, 2 * SAMPLE_RATE])
        self.assertEqual([r["revision"] for r in lines], [1, 2])
        self.assertEqual([r["source"] for r in lines], ["v", "v"])
        # Buffer rolling không lưu metadata frame đầu; mốc video là frame cuối.
        self.assertEqual([r["videoTime"] for r in lines], [0.0, 1.0])
        self.assertEqual([r["flush"] for r in lines], [False, False])

    async def test_windowed_decode_keeps_legacy_latency_fields(self):
        self.runtime.settings = Settings(mode="windowed")
        lines = []
        # Session của setUp không có `latency_log`; gắn logger riêng để test
        # đúng call site thật thay vì đo lời gọi không tồn tại.
        self.session.latency_log = lambda record, whisper_seconds, started: lines.append(record)
        audio = np.ones(SAMPLE_RATE, dtype=np.float32)
        # Windowed chỉ submit khi buffer đủ 2s (rồi 3s): cần 4 frame cho hai lượt.
        for seq in [1, 2, 3, 4]:
            self.session.audio(audio, {**metadata(seq=seq), "videoTimeAtCapture": 10 + seq})
            if seq % 2 == 0:
                await self.session.worker
                self.session.worker = None
        self.assertEqual([r["mode"] for r in lines], ["windowed", "windowed"])
        self.assertEqual([r["kind"] for r in lines], ["catchup", "steady"])
        self.assertEqual([r["videoTime"] for r in lines], [11, 13])
        self.assertIsNone(lines[0]["revision"])

    async def test_health_loading_error_ready_without_download(self):
        started = threading.Event()
        release = threading.Event()
        def factory(*args, **kwargs):
            started.set()
            release.wait(1)
            self.assertEqual(args[0], "small")
            self.assertEqual(kwargs["device"], "cpu")
            self.assertEqual(kwargs["compute_type"], "int8")
            return self.model
        runtime = ModelRuntime(Settings(model="small"), factory)
        runtime.start()
        await asyncio.to_thread(started.wait, 1)
        self.assertEqual(runtime.health()["status"], "loading")
        release.set()
        await runtime.load_task
        self.assertEqual(runtime.health()["status"], "ready")
        await runtime.close()
        def fail(*args, **kwargs):
            raise OSError("fake failure")
        failed = ModelRuntime(Settings(), fail)
        failed.start()
        await failed.load_task
        self.assertEqual(failed.health()["status"], "error")
        await failed.close()


if __name__ == "__main__":
    unittest.main()
