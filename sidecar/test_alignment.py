# unit test
#
# ⚠️ Kỳ vọng suy ra TỪ `OVERLAP_SIZE`, không viết cứng 1.5 (Issue 5.30).
# Lý do: `compute_video_time` trừ đúng bằng độ dài gối đầu mà bộ đệm giữ
# lại, tức `OVERLAP_SIZE`. Viết cứng ở test cũ làm cả test lẫn hàm cùng dựa
# vào một con số không ai ràng buộc — đổi overlap là cả hai xanh trong khi
# timestamp thực đã lệch. Suy ra từ hằng số thì đổi overlap vẫn tự nhất quán,
# và `test_window_size.py` chặn phần còn lại (window > overlap).
from app.main import OVERLAP_SIZE, SAMPLE_RATE, compute_video_time

OVERLAP_SEC = OVERLAP_SIZE / SAMPLE_RATE

CASES = [
    # first chunk: buffer starts AT the anchor, nothing was carried in, so no
    # subtraction.
    (10.0, 2.0, True, 12.0),
    # later chunk: subtract the overlap tail.
    (10.0, 2.0, False, 10.0 - OVERLAP_SEC + 2.0),
    (6.0, 0.0, False, 6.0 - OVERLAP_SEC + 0.0),
]

failed = 0
for raw,word_time,first,expected in CASES:
    got = compute_video_time(raw,word_time,first)
    status = "PASS" if got == expected else "FAIL"
    if got != expected:
        failed += 1
    print(f"{status}  raw={raw} word={word_time} first={first} -> {got} (expected {expected})")
    
if failed:
    print(f"FAIL: {failed} test cases failed")
    exit(1)
    
print(f"PASSED: {len(CASES)} test cases passed")

