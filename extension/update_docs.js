const fs = require('fs');

// 1. Update issues.md
const issuesPath = '../docs/dev-notes/issues.md';
let issues = fs.readFileSync(issuesPath, 'utf8');
issues += `
## Lỗi Subtitle Bleed (Lưu sub video cũ sang video mới trên trang SPA)
- **Triệu chứng:** Khi chuyển từ video này sang video khác trên cùng một trang SPA, sub của video cũ vẫn hiện, thậm chí bị ghi đè lên video mới nếu video mới phát tới cùng mốc thời gian.
- **Nguyên nhân:** Khi chuyển video, Frontend tự sinh ra \`sessionId\` mới cho CaptureScope nhưng tái sử dụng kết nối WebSocket (để không tốn overhead mở lại). Tuy nhiên, \`adoptScope()\` dưới Backend đã check \`scope.sessionId !== old.sessionId\` và từ chối scope mới này. Hậu quả là audio của video mới bị bỏ qua, trong khi \`video-clock\` của video mới vẫn gửi lên và trỏ vào bản dịch cũ của video trước đó.
- **Cách fix:** Bỏ điều kiện từ chối \`scope.sessionId !== old.sessionId\` trong \`adoptScope\`. Backend phải chấp nhận phiên mới (vì đây là chu kỳ bình thường khi extension chuyển video), qua đó reset state và phục vụ video mới.

## M7.5 Latency & Local Agreement
- **Triệu chứng:** p90 của \`stage=first\` cao (lên tới 15.5s) và \`finalized\` cực cao (20.8s) do Whisper liên tục thêm dấu câu làm vỡ local agreement.
- **Cách fix:** Viết lại \`_strip_punc\` trong Python Sidecar để loại bỏ dấu câu và không phân biệt hoa thường khi so sánh \`agreed\`. Đồng thời nới lỏng sai số thời gian cho Whisper từ 5600 mẫu (0.35s) lên 16000 mẫu (1s) để tránh việc timestamp xê dịch nhẹ làm huỷ agreement.
- **Kết quả:** \`stage=first\` median giảm xuống 1.18s, \`finalized\` median 3.10s. p90 còn khoảng 4.9s (chủ yếu do các pha Whisper suy luận lại nguyên cụm từ hoặc khoảng lặng).
`;
fs.writeFileSync(issuesPath, issues);

// 2. Update PROCESS.md
const processPath = '../docs/PROCESS.md';
let process = fs.readFileSync(processPath, 'utf8');
process += `
- **2026-10-06**: Đã hoàn thành sửa lỗi \`adoptScope\` (lưu sub video cũ) và tối ưu độ trễ streaming (bằng cách bỏ dấu câu khi local agreement). Benchmark M7.5 cho thấy median first lag là ~1.18s.
`;
fs.writeFileSync(processPath, process);

