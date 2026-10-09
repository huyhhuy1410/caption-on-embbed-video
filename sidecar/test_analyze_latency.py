# Unit test cho bộ đọc log độ trễ (M7.5 acceptance gate).
# Nhãn ASCII: console Windows mặc định là cp1252, in tiếng Việt sẽ UnicodeEncodeError.
import os
import tempfile

from analyze_latency import parse, parse_rendered, pct

failed = 0


def check(label, got, expected):
    global failed
    ok = got == expected
    if not ok:
        failed += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}: {got} (expected {expected})")


def write_log(lines):
    handle = tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8")
    handle.write("\n".join(lines) + "\n")
    handle.close()
    return handle.name


LAT_STEADY = ("LAT mode=windowed windowStart=12.345 sent=12.901 lagSec=6.42 whisperSec=0.42 "
              "windowSec=3.0 videoTime=10.00 source=v1 kind=steady")
LAT_CATCHUP = ("LAT mode=windowed windowStart=0.100 sent=1.200 lagSec=3.10 whisperSec=1.10 "
               "windowSec=2.0 videoTime=0.00 source=v1 kind=catchup")
LAT_STREAM = ("LAT mode=streaming windowStart=5.000 sent=5.410 lagSec=1.42 whisperSec=0.38 "
              "windowSec=1.0 videoTime=4.20 source=v2 kind=steady revision=18")
LAT_FLUSH = ("LAT mode=streaming windowStart=9.000 sent=9.330 lagSec=0.31 whisperSec=0.29 "
             "windowSec=0.0 videoTime=8.90 source=v2 kind=steady revision=31 flush=1")

path = write_log([
    LAT_STEADY,
    LAT_CATCHUP,
    "INFO: unrelated backend log line",
    LAT_STREAM,
    LAT_FLUSH,
    "LAG stage=first wordId=abc-w1 lagMs=1830.4 provisional=true",
    "LAG stage=finalized wordId=abc-w1 lagMs=2410.0",
    "LAG stage=first wordId=abc-w2 lagMs=1100.0 provisional=false",
])

rows = parse([path])
check("LAT đọc đúng 4 dòng", len(rows), 4)
check("LAT kind giữ nguyên", sorted(r["kind"] for r in rows), ["catchup", "steady", "steady", "steady"])
check("LAT mode đọc đúng", sorted(r["mode"] for r in rows), ["streaming", "streaming", "windowed", "windowed"])
check("LAT bỏ dòng không khớp", any("unrelated" in str(r) for r in rows), False)
# `revision`/`flush` chỉ có ở streaming; thiếu phải là None chứ không phải 0 —
# nếu mặc định 0 thì sẽ đọc ra một revision giả cho windowed.
check("windowed không có revision", [r.get("revision") for r in rows if r["mode"] == "windowed"], [None, None])
check("streaming đọc revision", [r["revision"] for r in rows if r["mode"] == "streaming"], [18, 31])
check("flush parse đúng", [r.get("flush") for r in rows if r["mode"] == "streaming"], [False, True])

rendered = parse_rendered([path])
check("LAG đọc đúng 3 dòng", len(rendered), 3)
# Khoá theo (từ, stage) như `parse_rendered`; khoá theo từ sẽ giấu mất stage
# cuối và làm assert đọc trúng nhầm bản ghi khác.
by_key = {(r["wordId"], r["stage"]): r for r in rendered}
check("wordId giữ nguyên", sorted({r["wordId"] for r in rendered}), ["abc-w1", "abc-w2"])

first = [r for r in rendered if r["stage"] == "first"]
final = [r for r in rendered if r["stage"] == "finalized"]
check("stage=first đủ 2 từ", len(first), 2)
check("stage=finalized đủ 1 từ", len(final), 1)
check("provisional đọc đúng", by_key[("abc-w1", "first")]["provisional"], True)
check("provisional thiếu mặc định False", by_key[("abc-w2", "first")]["provisional"], False)
check("lagMs parse được", by_key[("abc-w2", "first")]["lagMs"], 1100.0)

# Word đã đo rồi không được đo lại — console log có thể lặp dòng.
path_dup = write_log([
    "LAG stage=first wordId=w1 lagMs=1000.0 provisional=true",
    "LAG stage=first wordId=w1 lagMs=9999.0 provisional=true",
])
check("từ trùng chỉ tính một lần", len(parse_rendered([path_dup])), 1)
check("giữ lần đầu, không phải lần sau", parse_rendered([path_dup])[0]["lagMs"], 1000.0)

# `first` và `finalized` là hai mốc khác nhau của cùng một từ.
check("cùng từ hai stage thì giữ cả hai",
      sorted(r["stage"] for r in rendered if r["wordId"] == "abc-w1"), ["finalized", "first"])

check("pct của danh sách rỗng", pct([], 0.5), 0.0)
check("pct p90 lệch phải", pct([1.0, 2.0, 3.0, 4.0], 0.9), 4.0)

os.unlink(path)
os.unlink(path_dup)

print(f"\n{'PASSED' if not failed else 'FAILED'}: 24 test cases")
raise SystemExit(1 if failed else 0)
