"""Đọc log `LAT` của sidecar và tóm tắt độ trễ caption.

Cách dùng:
    python sidecar/analyze_latency.py <đường-dẫn-log> [<đường-dẫn-log> ...]

Log do `log_latency()` trong `app/main.py` in ra, mỗi dòng một lượt transcribe:
    LAT windowStart=12.345 sent=12.901 lagSec=6.42 whisperSec=0.42 ... kind=steady

Cố ý tách khỏi test: đây là công cụ đọc log của phiên chạy thật, còn các
`test_*.py` là test hàm thuần. Test không sinh ra log này.

Điều script này trả lời được (và log thô không trả lời thẳng):
- độ trễ trung vị / trung bình của nhịp ổn định, tách riêng nhịp "catchup"
  sau khi tua — trộn hai loại sẽ ra số vô nghĩa;
- độ trễ do chờ whisper và do độ dài window, chiếm bao nhiêu mỗi phần;
- nhịp xuất hiện caption (giây) và xem có đều không.
"""

import re
import sys
import statistics

# ⚠️ Console Windows mặc định là cp1252, in tiếng Việt có dấu sẽ ném
# UnicodeEncodeError. Ép về UTF-8 và bật lỗi thay ra thay vì thay thế im lặng —
# thay thế im lặng khiến số liệu sai mà không ai thấy.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass  # stdout bị redirect (không còn console) thì không cần reconfigure.

# windowStart / sent / lagSec / whisperSec / windowSec / videoTime / source / kind
LINE = re.compile(
    r"LAT\s+windowStart=(?P<windowStart>[\d.]+)"
    r"\s+sent=(?P<sent>[\d.]+)"
    r"\s+lagSec=(?P<lagSec>[\d.]+)"
    r"\s+whisperSec=(?P<whisperSec>[\d.]+)"
    r"\s+windowSec=(?P<windowSec>[\d.]+)"
    r"\s+videoTime=(?P<videoTime>[\d.-]+)"
    r"\s+source=(?P<source>\S+)"
    r"\s+kind=(?P<kind>\S+)"
)


def parse(paths):
    rows = []
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                match = LINE.search(line)
                if not match:
                    continue
                row = {k: float(v) if k not in ("source", "kind") else v
                       for k, v in match.groupdict().items()}
                rows.append(row)
    return rows


def pct(values, p):
    """Phân vị gần nhất — trung vị của một danh sách lệch sẽ dễ đọc hơn trung bình."""
    if not values:
        return 0.0
    ordered = sorted(values)
    index = round((len(ordered) - 1) * p)
    return ordered[index]


def summarize(label, rows):
    if not rows:
        return
    lags = [r["lagSec"] for r in rows]
    whisper = [r["whisperSec"] for r in rows]
    window = [r["windowSec"] for r in rows]
    print(f"\n=== {label} ({len(rows)} lượt) ===")
    print(f"  độ trễ (lagSec)   trung vị {pct(lags, 0.5):5.2f}"
          f"   p90 {pct(lags, 0.9):5.2f}   min {min(lags):5.2f}"
          f"   max {max(lags):5.2f}")
    print(f"  do chờ whisper    trung vị {pct(whisper, 0.5):5.2f}s")
    print(f"  do độ dài window  trung vị {pct(window, 0.5):5.2f}s")

    # Nhịp xuất hiện: hai lượt liên tiếp cách nhau bao nhiêu giây thật.
    steady = [r for r in rows if r["kind"] == "steady"]
    steady.sort(key=lambda r: r["windowStart"])
    if len(steady) > 1:
        gaps = [b["windowStart"] - a["windowStart"]
                for a, b in zip(steady, steady[1:])]
        gaps = [g for g in gaps if 0 < g < 30]  # bỏ gap do tua (nguồn đổi)
        if gaps:
            print(f"  nhịp xuất hiện     trung vị {statistics.median(gaps):5.2f}s"
                  f"   (WINDOW - OVERLAP = {window[0]:.1f} - 1.5"
                  f" = {window[0] - 1.5:.1f}s nếu whisper không nghẽn)")


def main():
    paths = sys.argv[1:]
    if not paths:
        print(__doc__)
        raise SystemExit(1)

    rows = parse(paths)
    if not rows:
        print("Không tìm thấy dòng `LAT` nào.")
        print("Kiểm tra: sidecar đã restart từ lần thêm log chưa,")
        print("và video có thực sự phát (không phát thì không có lượt nào).")
        raise SystemExit(1)

    print(f"Đọc {len(rows)} dòng LAT từ {len(paths)} file.")
    summarize("nhịp ổn định", [r for r in rows if r["kind"] == "steady"])
    summarize("sau khi tua (catchup)", [r for r in rows if r["kind"] == "catchup"])

    # Cảnh báo bất biến window. Không cảnh báo ở tầng hằng số vì
    # `test_window_size.py` đã chặn; ở đây để dữ liệu đo lộ ra vấn đề ngay
    # cả khi ai đó chỉnh cấu hình rồi đo mà quên chạy test.
    windows = {r["windowSec"] for r in rows}
    for w in sorted(windows):
        if w <= 3.0:  # 2 x OVERLAP_SIZE
            print(f"\n⚠️ CẢNH BÁO: window {w}s <= 2 x OVERLAP(1.5s).")
            print("  Phần overlap chiếm quá nhiều tỉ lệ, hai lượt liên tiếp")
            print("  trùng lặp nhiều mà không thu được ngữ cảnh nào mới.")
            print("  Có thể chấp nhận nếu độ trễ rất quan trọng, nhưng cần")
            print("  đánh giá độ chính xác bằng tai — không có test tự động nào bắt.")

    sources = sorted({r["source"] for r in rows})
    print(f"\nnguồn: {', '.join(str(s) for s in sources)}")


if __name__ == "__main__":
    main()
