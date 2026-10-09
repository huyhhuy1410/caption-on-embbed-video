import os
from dataclasses import dataclass
from typing import Mapping

SAMPLE_RATE = 16000


@dataclass(frozen=True)
class Settings:
    model: str = "tiny"
    mode: str = "windowed"
    local_files_only: bool = False
    max_buffer_samples: int = 12 * SAMPLE_RATE
    max_words_per_caption: int = 16

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        values = os.environ if env is None else env
        model = values.get("WHISPER_MODEL", "tiny")
        mode = values.get("CAPTION_MODE", "windowed")
        if model not in {"tiny", "small", "medium"}:
            raise ValueError("WHISPER_MODEL must be tiny, small, or medium")
        if mode not in {"windowed", "streaming"}:
            raise ValueError("CAPTION_MODE must be windowed or streaming")
        return cls(model=model, mode=mode,
                   local_files_only=values.get("WHISPER_LOCAL_FILES_ONLY", "0") == "1")
