const fs = require('fs');
const path = 'extension/src/content/video-detector.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  'const url = video.currentSrc || video.src;',
  '// SPA (YouTube) có thể giữ nguyên blob: URL nhưng đổi video. Thêm page URL để tách.\n  const pageUrl = location.origin + location.pathname + location.search;\n  const url = (video.currentSrc || video.src) + "@" + pageUrl;'
);

fs.writeFileSync(path, code);
