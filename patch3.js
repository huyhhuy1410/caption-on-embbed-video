const fs = require('fs');
const path = 'extension/src/content/video-detector.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  'loadstart: () => reconcile(),',
  'loadstart: () => { sourceIds.delete(video); reconcile(); },'
);

fs.writeFileSync(path, code);
