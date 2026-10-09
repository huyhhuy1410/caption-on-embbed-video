const fs = require('fs');
const path = '../sidecar/app/streaming.py';
let code = fs.readFileSync(path, 'utf8');

const agreedRe = /abs\(old\["sampleStart"\] - new\["sampleStart"\]\) > 5600 or\n\s+abs\(old\["sampleEnd"\] - new\["sampleEnd"\]\) > 5600\):/;
code = code.replace(agreedRe, `abs(old["sampleStart"] - new["sampleStart"]) > 16000 or
                    abs(old["sampleEnd"] - new["sampleEnd"]) > 16000):`);

fs.writeFileSync(path, code);
