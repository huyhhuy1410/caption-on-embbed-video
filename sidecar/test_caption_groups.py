# unit test cho viec chia nhom caption (Issue 5.31)
# Nhan ASCII: console Windows mac dinh la cp1252, in tieng Viet se UnicodeEncodeError.
from app.main import MAX_WORDS_PER_CAPTION, assign_caption_groups


def w(text, video_start):
    return {"w": text, "videoStart": video_start}


def groups_of(words, max_words=MAX_WORDS_PER_CAPTION):
    """Chia nhom roi tra ve danh sach (captionStart, [tu...]) theo thu tu."""
    assign_caption_groups(words, max_words)
    out = []
    for word in words:
        if not out or out[-1][0] != word["captionStart"]:
            out.append((word["captionStart"], []))
        out[-1][1].append(word["w"])
    return out


failed = 0
total = 0


def check(label, got, expected):
    global failed, total
    total += 1
    if got != expected:
        failed += 1
    print(f"{'PASS' if got == expected else 'FAIL'}  {label}")
    if got != expected:
        print(f"      got:      {got}")
        print(f"      expected: {expected}")


# 1. Cau co dau cham: tach TAI dau cham, dung theo cau chu khong phai so tu.
# Phai co dau cham that — cau khong co dau cham thi ca 6 tu vao MOT nhom
# (vi con so tu 16), va do la hanh vi dung. Test truoc do quen dau cham va
# viet nham ky vong, khong phai code sai.
words = [w("Hello", 1.0), w("there", 1.4), w("friend.", 1.9), w("How", 2.5), w("are", 2.8), w("you?", 3.1)]
check(
    "split at sentence end, not at word count",
    groups_of(words),
    [(1.0, ["Hello", "there", "friend."]), (2.5, ["How", "are", "you?"])],
)

# 2. Mot nhom dung bao nhieu so tu — cau co dau cham chua toi han.
words = [w(f"w{i}", i * 0.4) for i in range(6)]
check("single group when no terminal punctuation", groups_of(words), [(0.0, [f"w{i}" for i in range(6)])])

# 3. Cau dai bi cat o NGUONG SO TU. Day la hanh vi gan nhat voi trieu chung
#    "cat dau": nhom sau mang phan CUOI cau ma khong co dau.
#    max_words=2: (w0,w1) | (w2,w3) | (w4,w5)
words = [w(f"w{i}", i * 0.4) for i in range(6)]
check(
    "long sentence splits at max_words",
    groups_of(words, max_words=2),
    [
        (0.0, ["w0", "w1"]),
        (0.8, ["w2", "w3"]),
        (1.6, ["w4", "w5"]),
    ],
)

# 4. captionStart LUON la videoStart cua tu DAU nhom (khong phai tu sau, khong None).
words = [w("one", 5.0), w("two", 5.3), w("three", 6.0)]
assign_caption_groups(words, max_words=2)
check(
    "captionStart is the first word of its group",
    [word["captionStart"] for word in words],
    [5.0, 5.0, 6.0],
)

# 5. Tu CHAM NGUNG SO TU van mang moc cua nhom do — gan captionStart TRUOC khi
#    kiem tra reset. Neu gan sau, tu nay nhan None va overlay khong ve duoc.
# Danh sach phai DUNG bang max_words. Ban dau test nay con 3 tu nen tu thu
#    ba thanh dau nhom moi va mang moc 2.0 — nham kiem tra thu khac.
words = [w("a", 1.0), w("b", 1.5)]
assign_caption_groups(words, max_words=2)
check(
    "word hitting the threshold keeps the old key",
    [word["captionStart"] for word in words],
    [1.0, 1.0],
)

# 5b. Tu KE TIEP sau nguong phai mang moc MOI.
words = [w("a", 1.0), w("b", 1.5), w("c", 2.0)]
assign_caption_groups(words, max_words=2)
check(
    "word after the threshold starts a new key",
    [word["captionStart"] for word in words],
    [1.0, 1.0, 2.0],
)

# 6. Dau cau tach nhom som hon ngung so tu.
words = [w("go.", 1.0), w("a", 1.4), w("b", 1.8), w("c", 2.2)]
check(
    "punctuation beats word count",
    groups_of(words, max_words=2),
    [(1.0, ["go."]), (1.4, ["a", "b"]), (2.2, ["c"])],
)

# 7. Hang so that cua M0 la 16 — kiem chinh bang CHINH test nay de khong
#    con test nao nao "chua" gi no ve hanh vi that.
check("MAX_WORDS_PER_CAPTION is 16", MAX_WORDS_PER_CAPTION, 16)

# 8. Ten co dau cham deu tach nhom (ke ca dau phay bi bo qua - chi ba dau ket thuc).
words = [w("one,", 1.0), w("two,", 1.4), w("three.", 1.9)]
check(
    "comma does not end a group, period does",
    groups_of(words),
    [(1.0, ["one,", "two,", "three."])],
)

# 9. Danh sach rong phai an toan (khong loi).
empty = []
assign_caption_groups(empty, max_words=8)
check("empty list is safe", empty, [])

if failed:
    print(f"FAIL: {failed} test cases failed")
    raise SystemExit(1)

print(f"PASSED: {total - failed} test cases passed "
      f"(MAX_WORDS_PER_CAPTION={MAX_WORDS_PER_CAPTION})")
