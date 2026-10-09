#!/usr/bin/env bash
# Đo độ trễ từ thu đến lúc hiện trên màn hình (acceptance gate của M7.5).
#
# Bao nhiêu con số cũng không thay được một lần đo thật: `LAT` của sidecar chỉ
# đo phía decode, overlay mới đo phía người xem. Script này gom cả hai rồi
# in p50/p90 của từ đã thực sự được vẽ.
#
#   CAPTION_MODE=streaming ./measure_latency.sh
#
# Cần sidecar + backend chạy sẵn (dev.sh), extension đã build và Load unpacked.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$ROOT/sidecar/.venv/Scripts/python.exe"
[[ -x "$PY" ]] || PY="$ROOT/sidecar/.venv/bin/python"
SIDECAR_LOG="$ROOT/.tmp/logs/sidecar.log"
DURATION="${DURATION:-180}"
OUT="$ROOT/.tmp/logs/measure.log"

[[ -x "$PY" ]] || { echo "Chưa có sidecar/.venv — xem dev.sh" >&2; exit 1; }
[[ -f "$SIDECAR_LOG" ]] || { echo "Chưa có $SIDECAR_LOG — chạy ./dev.sh trước" >&2; exit 1; }

# Cắt đoạn log cũ: analyzer gộp theo wordId nên dữ lượt cũ sẽ làm p90 sai.
BEFORE="$(wc -l < "$SIDECAR_LOG")"

cat <<EOF
Đo trong ${DURATION}s. Không tua, không tạm dừng — tua làm lượt catchup lẫn vào
nhịp ổn định và số liệu thành vô nghĩa.

  1. Mở DevTools của tab đang xem video (không phải tab của extension).
  2. Bật "Preserve log".
  3. Bấm icon Caption AI để bắt đầu capture, rồi để clip chạy liên tục.
  4. Kết thúc: dừng capture, copy toàn bộ console sang $OUT
     (chỉ dòng bắt đầu bằng LAG là đủ, nhưng copy hết thì dễ kiểm tra hơn).
EOF

read -r -p "Bấm Enter sau khi đã bật capture và bắt đầu chạy clip... "
sleep "$DURATION"
cat <<EOF

Đủ ${DURATION}s. Bây giờ dừng capture và copy console của tab video vào $OUT
(dòng LAG chứa wordId + lagMs). Nhấn Enter sau khi copy xong.
EOF
read -r -p "Enter để phân tích... "

# Ghi phần log sidecar phát sinh trong lúc đo vào cuối file, để analyzer
# đọc được cả hai nguồn mà không cần bạn tự gộp.
{
  echo ""
  echo "===== sidecar (đoạn mới trong lúc chạy) ====="
  tail -n "+$((BEFORE + 1))" "$SIDECAR_LOG"
} >> "$OUT"

[[ -f "$OUT" ]] || { echo "Chưa có $OUT" >&2; exit 1; }

echo
"$PY" "$ROOT/sidecar/analyze_latency.py" "$OUT"
status=$?

cat <<'EOF'

--- Cách đọc ---
  stage=first     : từ hiện lần đầu, kể cả bản provisional (người xem thấy sớm nhất)
  stage=finalized : lần đầu từ đó được chốt, tức đã đúng và không còn sửa

Mục tiêu M7.5 là p90 của stage=first dưới 2s. Nếu vượt, đọc phần
"do chờ whisper" ở trên: phần lớn độ trễ là decode hay phần socket/translate.
EOF

exit $status
