# unit test cho cỡ window bắt kịp (Issue 5.22)
# Nhãn ASCII: console Windows mặc định là cp1252, in tiếng Việt sẽ UnicodeEncodeError.
from app.main import (
    CATCHUP_WINDOW_SIZE,
    MAX_BUFFER_SIZE,
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

# 4. Steady-state step between later windows. The arithmetic step is 1.5s at
#    WINDOW=3s, but the MEASURED cadence is 2.0s: audio arrives in 1s chunks
#    (CHUNK_SECONDS), so the real step rounds UP to the next whole chunk.
#    Do not treat the arithmetic number as the real cadence (gotcha #50).
check("steady-state step (arithmetic)", (WINDOW_SIZE - OVERLAP_SIZE) / SAMPLE_RATE, 1.5)

# 5. WINDOW must be LARGER than OVERLAP: same reason as #3 — after a turn the
#    buffer keeps [-OVERLAP_SIZE:] and compute_video_time subtracts exactly
#    1.5s for that tail. A window at or below the overlap makes the
#    subtraction meaningless, and every timestamp drifts.
check("window larger than overlap", WINDOW_SIZE > OVERLAP_SIZE, True)

# 6. WINDOW must be at least 2x OVERLAP. Below that the overlap takes up so
#    much of each window that consecutive turns mostly re-transcribe the same
#    audio without gaining context — cost without benefit. This is the guard
#    that stops a future "make latency even lower" change from quietly
#    degrading recognition quality.
check("window at least 2x overlap", WINDOW_SIZE >= 2 * OVERLAP_SIZE, True)

# 7. Watchdog must exceed WINDOW. If the buffer cap were below the window
#    size, the watchdog would trim the buffer while it is still filling for a
#    transcribe — the window could then never fill up.
check("watchdog larger than window", MAX_BUFFER_SIZE > WINDOW_SIZE, True)

if failed:
    print(f"FAIL: {failed} test cases failed")
    exit(1)

print(f"PASSED: 8 test cases passed (WINDOW={WINDOW_SIZE / SAMPLE_RATE:.1f}s, "
      f"OVERLAP={OVERLAP_SIZE / SAMPLE_RATE:.1f}s, "
      f"CATCHUP={CATCHUP_WINDOW_SIZE / SAMPLE_RATE:.1f}s)")
