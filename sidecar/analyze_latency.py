"""Đọc log độ trễ của sidecar (`LAT`) và của overlay (`LAG`) rồi tóm tắt.

Cách dùng:
    python sidecar/analyze_latency.py <đường-dẫn-log> [<đường-dẫn-log> ...]

Hai loại dòng, phục vụ hai câu hỏi khác nhau:

1. `LAT` — in bởi `log_latency()` trong `app/main.py`, mỗi dòng một lượt
   transcribe, cả hai mode:
       LAT mode=windowed windowStart=12.345 sent=12.901 lagSec=6.42 ... kind=steady
       LAT mode=streaming windowStart=12.345 sent=12.901 lagSec=1.42 ... kind=steady revision=18
   Đo phía sidecar: decode mất bao lâu, cửa sổ dài bao nhiêu. Ở streaming,
   `revision` cho biết mốc đã chốt tới đâu để đối chiếu với `LAG`.

2. `LAG stage=first|finalized` — in bởi overlay sau khi từ đã thực sự được vẽ
   ra màn hình:
       LAG stage=first wordId=abc-w12 lagMs=1830.4 provisional=true
   Đo phía người dùng: từ được thu đến lúc hiện lên mất bao lâu. Đây mới là
   con số quyết định streaming đủ nhanh hay không — `LAT` bỏ qua thời gian
   chờ socket, translate và rAF.

Cố ý tách khỏi test: đây là công cụ đọc log của phiên chạy thật, còn các
`test_*.py` là test hàm thuần. Test không sinh ra log này.

Điều script này trả lời được (và log thô không trả lời thẳng):
- độ trễ trung vị / trung bình của nhịp ổn định, tách riêng nhịp "catchup"
  sau khi tua — trộn hai loại sẽ ra số vô nghĩa;
- độ trễ do chờ whisper và do độ dài window, chiếm bao nhiêu mỗi phần;
- nhịp xuất hiện caption (giây) và xem có đều không;
- p50/p90 của `LAG stage=first` (từ hiện lần đầu, kể cả provisional) và
  `stage=finalized` (lần đầu từ đó được chốt) — đây là acceptance gate.
"""

import re
import sys
import statistics

# Console Windows mặc định là cp1252, in tiếng Việt có dấu sẽ ném
# UnicodeEncodeError. Ép về UTF-8 và bật lỗi thay ra thay vì thay thế im lặng —
# thay thế im lặng khiến số liệu sai mà không ai thấy.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass  # stdout bị redirect (không còn console) thì không cần reconfigure.

# mode windowStart sent lagSec whisperSec windowSec videoTime source kind
# [revision] [flush] — `revision` chỉ có ở streaming.
LINE = re.compile(
    r"LAT\s+mode=(?P<mode>windowed|streaming)"
    r"\s+windowStart=(?P<windowStart>[\d.]+)"
    r"\s+sent=(?P<sent>[\d.]+)"
    r"\s+lagSec=(?P<lagSec>[\d.]+)"
    r"\s+whisperSec=(?P<whisperSec>[\d.]+)"
    r"\s+windowSec=(?P<windowSec>[\d.]+)"
    r"\s+videoTime=(?P<videoTime>[\d.-]+)"
    r"\s+source=(?P<source>\S+)"
    r"\s+kind=(?P<kind>\S+)"
    r"(?:\s+revision=(?P<revision>\d+))?"
    r"(?:\s+flush=(?P<flush>\S+))?"
)

# stage=first|finalized wordId=<id> lagMs=<số> [provisional=true|false]
RENDERED = re.compile(
    r"LAG\s+stage=(?P<stage>first|finalized)"
    r"\s+wordId=(?P<wordId>\S+)"
    r"\s+lagMs=(?P<lagMs>[\d.]+)"
    r"(?:\s+provisional=(?P<provisional>true|false))?"
)


def parse(paths):
    rows = []
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                match = LINE.search(line)
                if not match:
                    continue
                row = {k: v for k, v in match.groupdict().items() if v is not None}
                for key in ("windowStart", "sent", "lagSec", "whisperSec", "windowSec", "videoTime"):
                    row[key] = float(row[key])
                if "revision" in row:
                    row["revision"] = int(row["revision"])
                # Vắng mặt nghĩa là không phải lượt flush — giữ bool thay vì None
                # để người đọc log không phải phân biệt hai kiểu thiếu khác nhau.
                row["flush"] = row.get("flush", "0") == "1"
                rows.append(row)
    return rows


def parse_rendered(paths):
    """Dòng LAG của overlay. Mỗi (từ, stage) chỉ giữ lần đo đầu tiên."""
    # Một từ có hai mốc độc lập: hiện lần đầu, và lần đầu được chốt. Gộp theo
    # stage, không theo từ — nếu không thì mốc `finalized` của từ đã đo `first`
    # sẽ bị coi là trùng và mất đúng mẫu đo đáng giá nhất.
    first_seen = {}
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                match = RENDERED.search(line)
                if not match:
                    continue
                stage = match.group("stage")
                word_id = match.group("wordId")
                if (word_id, stage) in first_seen:
                    continue
                first_seen[(word_id, stage)] = {
                    "wordId": word_id,
                    "stage": stage,
                    "lagMs": float(match.group("lagMs")),
                    "provisional": match.group("provisional") == "true",
                }
    return list(first_seen.values())


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
            # Kỳ vọng khác nhau theo mode: windowed lặp theo WINDOW-OVERLAP,
            # còn streaming có nhịp không cố định — nếu vượt 1.5s thì decode
            # nghẽn, đó mới là thứ cần sửa chứ không phải số liệu kỳ vọng.
            pace = (f"WINDOW - OVERLAP = {window[0]:.1f} - 1.5 = {window[0] - 1.5:.1f}s"
                    if rows[0].get("mode") == "windowed" else "streaming: nên bám nhịp frame 1s")
            print(f"  nhịp xuất hiện     trung vị {statistics.median(gaps):5.2f}s   ({pace})")


def summarize_rendered(rows):
    """Số đo người dùng thấy: p50/p90 của từ đã vẽ lên màn hình."""
    if not rows:
        return False
    print(f"\n=== từ đã render ({len(rows)} từ) ===")
    for stage, label in (("first", "lần đầu (kể cả provisional)"),
                         ("finalized", "lần đầu được chốt")):
        values = [r["lagMs"] for r in rows if r["stage"] == stage]
        if not values:
            continue
        print(f"  stage={stage:<9} {label}")
        print(f"    trung vị {pct(values, 0.5) / 1000:5.2f}s   "
              f"p90 {pct(values, 0.9) / 1000:5.2f}s   "
              f"min {min(values) / 1000:5.2f}s   max {max(values) / 1000:5.2f}s")
    provisional = [r for r in rows if r["stage"] == "first" and r["provisional"]]
    print(f"  tỷ lệ hiện provisional lần đầu: "
          f"{len(provisional)}/{len([r for r in rows if r['stage'] == 'first'])}")
    return True


def main():
    paths = sys.argv[1:]
    if not paths:
        print(__doc__)
        raise SystemExit(1)

    rows = parse(paths)
    rendered = parse_rendered(paths)
    if not rows and not rendered:
        print("Không tìm thấy dòng `LAT` hay `LAG` nào.")
        print("Kiểm tra: sidecar đã restart từ lần thêm log chưa,")
        print("và video có thực sự phát (không phát thì không có lượt nào).")
        print("Dòng `LAG` nằm trong DevTools của tab đang xem video, không phải log sidecar.")
        raise SystemExit(1)

    if rows:
        print(f"Đọc {len(rows)} dòng LAT từ {len(paths)} file.")
        for mode in ("windowed", "streaming"):
            subset = [r for r in rows if r.get("mode") == mode]
            if not subset:
                continue
            summarize(f"{mode} — nhịp ổn định", [r for r in subset if r["kind"] == "steady"])
            summarize(f"{mode} — sau khi tua (catchup)", [r for r in subset if r["kind"] == "catchup"])
    if not summarize_rendered(rendered):
        print("\nChưa có dòng `LAG` nào: overlay chưa đo được từ nào đã render.")
        print("Mở DevTools của tab video và copy console sang cùng file log.")

    # Cảnh báo bất biến window. Không cảnh báo ở tầng hằng số vì
    # `test_window_size.py` đã chặn; ở đây để dữ liệu đo lộ ra vấn đề ngay
    # cả khi ai đó chỉnh cấu hình rồi đo mà quên chạy test.
    windows = {r["windowSec"] for r in rows if r.get("mode") == "windowed"}
    for w in sorted(windows):
        if w <= 3.0:  # 2 x OVERLAP_SIZE
            print(f"\nCẢNH BÁO: window {w}s <= 2 x OVERLAP(1.5s).")
            print("  Phần overlap chiếm quá nhiều tỉ lệ, hai lượt liên tiếp")
            print("  trùng lặp nhiều mà không thu được ngữ cảnh nào mới.")
            print("  Có thể chấp nhận nếu độ trễ rất quan trọng, nhưng cần")
            print("  đánh giá độ chính xác bằng tai — không có test tự động nào bắt.")

    sources = sorted({r["source"] for r in rows})
    print(f"\nnguồn: {', '.join(str(s) for s in sources)}")


if __name__ == "__main__":
    main()
