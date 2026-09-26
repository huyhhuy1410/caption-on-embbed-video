# unit test cho cỡ window bắt kịp (Issue 5.22)
# Nhãn ASCII: console Windows mặc định là cp1252, in tiếng Việt sẽ UnicodeEncodeError.
from app.main import (
    CATCHUP_WINDOW_SIZE,
    OVERLAP_SIZE,
    SAMPLE_RATE,
    WINDOW_SIZE,
    resolve_window_size,
)

failed = 0


def check(label, got, expected):
    global failed
    ok = got == expected
    if not ok:
        failed += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}: {got} (expected {expected})")


# 1. Window size per turn.
check("first turn (stream start / after reset)", resolve_window_size(True), CATCHUP_WINDOW_SIZE)
check("later turns", resolve_window_size(False), WINDOW_SIZE)

# 2. The whole point: catch-up must be FASTER than the standard size, otherwise
#    a smaller window buys nothing and only costs whisper context.
check("catchup faster than standard", CATCHUP_WINDOW_SIZE < WINDOW_SIZE, True)

# 3. CATCHUP must be LARGER than OVERLAP: after the catch-up turn the buffer
#    keeps `[-OVERLAP_SIZE:]` and compute_video_time subtracts exactly 1.5s for
#    it. If CATCHUP <= OVERLAP the kept tail IS the whole transcribed window, so
#    the subtraction is meaningless and timestamps drift.
check("catchup larger than overlap", CATCHUP_WINDOW_SIZE > OVERLAP_SIZE, True)

# 4. Steady-state step between later windows stays 4.5s — this patch must not
#    change the normal cadence.
check("steady-state step unchanged", (WINDOW_SIZE - OVERLAP_SIZE) / SAMPLE_RATE, 4.5)

if failed:
    print(f"FAIL: {failed} test cases failed")
    exit(1)

print("PASSED: 5 test cases passed")
