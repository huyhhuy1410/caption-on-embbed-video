# unit test cho quy tac bo batch rong (Issue 5.40)
#
# Do 2026-10-02 tren log that: 728 batch rong so voi 73 batch co tu. Phan lon
# la doan im lang — VAD loc sach roi tra danh sach rong.
from app.main import should_emit_words

WORD = {"w": "hello", "s": 0.0, "e": 0.4, "videoStart": 1.0, "videoEnd": 1.4}

CASES = [
    # Co tu -> luon gui, ke ca window dau hay window thuong.
    ([WORD], True, True),
    ([WORD], False, True),
    # Window rong o giua stream: bo. Day la truong hop pho bien nhat.
    ([], False, False),
    ([], False, False),
    # Window DAU rong: van gui — mau chinh cho language detection (FR-8).
    ([], True, True),
]

failed = 0
for words, is_first_chunk, expected in CASES:
    got = should_emit_words(words, is_first_chunk)
    status = "PASS" if got == expected else "FAIL"
    if got != expected:
        failed += 1
    print(
        f"{status}  n={len(words)} is_first={is_first_chunk} -> {got} "
        f"(expected {expected})"
    )

if failed:
    print(f"FAIL: {failed} test cases failed")
    exit(1)

print(f"PASSED: {len(CASES)} test cases passed")