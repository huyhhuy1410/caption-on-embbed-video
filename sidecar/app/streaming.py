from dataclasses import dataclass
import math
import string
from typing import Any
from uuid import uuid4

import numpy as np

from .model_runtime import DecodeResult
from .segmenter import caption_boundary
from .settings import SAMPLE_RATE


def _strip_punc(s: str) -> str:
    return s.translate(str.maketrans('', '', string.punctuation)).strip().casefold()

@dataclass(frozen=True)
class Scope:
    sessionId: str = "legacy"
    generation: int = 0
    sourceId: str | None = None

    @classmethod
    def parse(cls, metadata: dict[str, Any], previous: "Scope") -> "Scope":
        generation = metadata.get("generation", previous.generation)
        if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
            raise ValueError("Invalid generation")
        session = metadata.get("sessionId", previous.sessionId)
        source = metadata.get("sourceId", previous.sourceId)
        if not isinstance(session, str) or not session or (source is not None and not isinstance(source, str)):
            raise ValueError("Invalid capture scope")
        return cls(session, generation, source)

    def wire(self) -> dict[str, Any]:
        return {"sessionId": self.sessionId, "generation": self.generation, "sourceId": self.sourceId}


@dataclass(frozen=True)
class FrameAnchor:
    start: int
    end: int
    video: float
    epoch: float | None


@dataclass(frozen=True)
class Snapshot:
    audio: np.ndarray
    start: int
    anchors: tuple[FrameAnchor, ...]

    def locate(self, sample: int) -> tuple[float, float | None]:
        anchor = next((a for a in self.anchors if a.start <= sample < a.end), self.anchors[-1])
        offset = (sample - anchor.start) / SAMPLE_RATE
        return anchor.video + offset, None if anchor.epoch is None else anchor.epoch + offset * 1000


class RollingAudio:
    def __init__(self, limit: int = 12 * SAMPLE_RATE):
        self.limit = limit
        self.audio = np.empty(0, dtype=np.float32)
        self.start = 0
        self.end = 0
        self.anchors: list[FrameAnchor] = []

    def append(self, audio: np.ndarray, metadata: dict[str, Any]) -> None:
        video = metadata.get("frameStartVideoTime")
        if not isinstance(video, (int, float)) or not math.isfinite(video):
            raise ValueError("Streaming requires finite frameStartVideoTime")
        epoch = metadata.get("capturedAtEpochMs")
        if epoch is not None and (not isinstance(epoch, (int, float)) or not math.isfinite(epoch)):
            raise ValueError("Invalid capturedAtEpochMs")
        self.anchors.append(FrameAnchor(self.end, self.end + len(audio), float(video), epoch))
        self.end += len(audio)
        self.audio = np.concatenate((self.audio, audio))
        self.trim(max(self.start, self.end - self.limit))

    def trim(self, before: int) -> None:
        before = min(max(before, self.start), self.end)
        self.audio = self.audio[before - self.start:]
        self.start = before
        self.anchors = [a for a in self.anchors if a.end > before]

    def snapshot(self) -> Snapshot:
        return Snapshot(self.audio.copy(), self.start, tuple(self.anchors))


class StreamingTranscript:
    def __init__(self, scope: Scope, max_words: int = 16):
        self.scope = scope
        self.max_words = max_words
        self.revision = 0
        self.prefix = uuid4().hex
        self.next_word = 0
        self.next_caption = 0
        self.committed_end = -1
        self.previous: list[dict[str, Any]] = []
        self.open_words: list[dict[str, Any]] = []
        self.visible: dict[str, dict[str, Any]] = {}
        self.captions: dict[str, dict[str, Any]] = {}

    def _word_id(self) -> str:
        self.next_word += 1
        return f"{self.prefix}-w{self.next_word}"

    def _caption_id(self) -> str:
        self.next_caption += 1
        return f"{self.prefix}-c{self.next_caption}"

    def update(self, result: DecodeResult, snapshot: Snapshot, flush: bool = False) -> dict[str, Any]:
        hypothesis = []
        for raw in result.words:
            start = snapshot.start + round(raw["s"] * SAMPLE_RATE)
            end = snapshot.start + round(raw["e"] * SAMPLE_RATE)
            if end <= self.committed_end or start < self.committed_end:
                continue
            if start < snapshot.start or end > snapshot.start + len(snapshot.audio) + 1600:
                continue
            video_start, epoch = snapshot.locate(start)
            video_end, _ = snapshot.locate(end)
            hypothesis.append({**raw, "sampleStart": start, "sampleEnd": end,
                               "videoStart": round(video_start, 3), "videoEnd": round(video_end, 3),
                               "capturedAtEpochMs": epoch, "sourceId": self.scope.sourceId})

        agreed = 0
        for old, new in zip(self.previous, hypothesis):
            if (_strip_punc(old["w"]) != _strip_punc(new["w"]) or
                    abs(old["sampleStart"] - new["sampleStart"]) > 16000 or
                    abs(old["sampleEnd"] - new["sampleEnd"]) > 16000):
                break
            agreed += 1
        if flush:
            # Pause/end chạy thêm decode hữu hạn; phần đuôi cuối lấy từ decode mới, không từ tuổi từ.
            agreed = len(hypothesis)
        for index, word in enumerate(hypothesis):
            word["wordId"] = self.previous[index]["wordId"] if index < len(self.previous) else self._word_id()
            if index < len(self.previous) and "captionId" in self.previous[index]:
                word["captionId"] = self.previous[index]["captionId"]
            word["provisional"] = index >= agreed
            if index < agreed:
                # Agreement đóng băng cả timestamp; suffix decode không được kéo prefix đã commit.
                word = {**self.previous[index], "provisional": False} if not flush else word
                hypothesis[index] = word
        self.open_words.extend(hypothesis[:agreed])
        if agreed:
            self.committed_end = hypothesis[agreed - 1]["sampleEnd"]
        self.previous = hypothesis[agreed:]
        all_words = self.open_words + self.previous

        groups: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        for index, word in enumerate(all_words):
            current.append(word)
            following = all_words[index + 1] if index + 1 < len(all_words) else None
            if caption_boundary(word, following, len(current), self.max_words):
                groups.append(current)
                current = []
        if current:
            groups.append(current)

        new_words: dict[str, dict[str, Any]] = {}
        new_captions: dict[str, dict[str, Any]] = {}
        used_captions: set[str] = set()
        finalized_ids: set[str] = set()
        finalized_words: set[str] = set()
        retained_open: list[dict[str, Any]] = []
        for index, group in enumerate(groups):
            caption_id = group[0].get("captionId")
            if caption_id is None or caption_id in used_captions:
                caption_id = self._caption_id()
            used_captions.add(caption_id)
            start = group[0]["videoStart"]
            boundary = index < len(groups) - 1 or caption_boundary(group[-1], None, len(group), self.max_words)
            finalized = all(not word["provisional"] for word in group) and (boundary or flush)
            for word in group:
                word["captionId"] = caption_id
                word["captionStart"] = start
                public = {key: value for key, value in word.items()
                          if key not in {"sampleStart", "sampleEnd", "segmentEnd"} and value is not None}
                new_words[word["wordId"]] = public
                if finalized:
                    finalized_words.add(word["wordId"])
                elif not word["provisional"]:
                    retained_open.append(word)
            new_captions[caption_id] = {"captionId": caption_id, "captionStart": start,
                                       "wordIds": [word["wordId"] for word in group], "finalized": finalized}
            if finalized:
                finalized_ids.add(caption_id)
        self.revision += 1
        message = {"type": "words", "mode": "streaming", **self.scope.wire(),
                   "revision": self.revision,
                   "words": [word for key, word in new_words.items() if self.visible.get(key) != word],
                   "removedWordIds": [key for key in self.visible if key not in new_words],
                   "captions": [caption for key, caption in new_captions.items() if self.captions.get(key) != caption],
                   "removedCaptionIds": [key for key in self.captions if key not in new_captions],
                   "language": result.language, "languageProbability": result.language_probability,
                   "voiced": result.voiced}
        # Lịch sử finalized thuộc backend; sidecar chỉ giữ suffix đang sửa để RAM không tăng theo video.
        self.visible = {key: value for key, value in new_words.items() if key not in finalized_words}
        self.captions = {key: value for key, value in new_captions.items() if key not in finalized_ids}
        self.open_words = retained_open
        return message
