# unit test cho nhánh đổi nguồn (Issue 5.20)
#
# Tách khỏi `test_reset.py` vì hai lệnh có NGỮ NGHĨA khác nhau, dù trùng kiểu
# dữ liệu: reset xoá bộ đệm vì user TUA (vẫn cùng một video), còn source-switch
# xoá bộ đệm vì ĐỔI VIDEO. Nhầm hai cái là hỏng một trong hai đường.
from app.main import is_source_switch

CASES = [
    # Đúng là đổi nguồn.
    ({"type": "source-switch", "sourceId": "v2"}, True),
    # Đổi nguồn mà không kèm id vẫn phải nhận ra — nhánh xử lý sẽ tự gán None
    # thay vì im lặng giữ bộ đệm cũ.
    ({"type": "source-switch"}, True),
    # Reset là lệnh KHÁC, dù backend gửi cùng cửa sổ.
    ({"type": "reset"}, False),
    # Gói metadata thật của chunk audio cũng có khoá "type" — phải không khớp.
    ({"type": "audio", "seq": 1, "videoTimeAtCapture": 17.7}, False),
    ({"type": "video-clock", "videoTime": 3.0}, False),
    # sourceId rỗng là dữ liệu, KHÔNG phải lệnh.
    ({"sourceId": "v2"}, False),
    (None, False),
    ({}, False),
]

failed = 0
for metadata, expected in CASES:
    got = is_source_switch(metadata)
    status = "PASS" if got == expected else "FAIL"
    if got != expected:
        failed += 1
    print(f"{status}  {metadata!r} -> {got} (expected {expected})")

print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
raise SystemExit(1 if failed else 0)
