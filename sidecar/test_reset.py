# unit test cho nhánh reset (Issue 5.21)
from app.main import is_reset_command

CASES = [
    ({"type": "reset"}, True),
    ({"type": "audio", "seq": 1, "videoTimeAtCapture": 17.7}, False),
    (None, False),
    ({}, False),
    ({"seq": 1}, False),
    # Gói metadata thật của chunk audio cũng có khoá "type" — phải không khớp.
    ({"type": "video-clock", "videoTime": 3.0}, False),
]

failed = 0
for metadata, expected in CASES:
    got = is_reset_command(metadata)
    status = "PASS" if got == expected else "FAIL"
    if got != expected:
        failed += 1
    print(f"{status}  {metadata!r} -> {got} (expected {expected})")

if failed:
    print(f"FAIL: {failed} test cases failed")
    exit(1)

print(f"PASSED: {len(CASES)} test cases passed")
