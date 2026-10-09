from typing import Any


def caption_boundary(word: dict[str, Any], following: dict[str, Any] | None,
                     count: int, max_words: int) -> bool:
    if count >= max_words or word["w"].rstrip().endswith((".", "?", "!", "。", "！", "？")):
        return True
    return bool(word.get("segmentEnd") and following and
                following["sampleStart"] - word["sampleEnd"] >= 9600)
