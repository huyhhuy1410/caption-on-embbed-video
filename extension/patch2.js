const fs = require('fs');
const path = '../sidecar/app/streaming.py';
let code = fs.readFileSync(path, 'utf8');

const importRe = /import math\nfrom typing import Any/;
code = code.replace(importRe, "import math\nimport string\nfrom typing import Any");

const functionRe = /class Scope:/;
code = code.replace(functionRe, `def _strip_punc(s: str) -> str:
    return s.translate(str.maketrans('', '', string.punctuation)).strip().casefold()

class Scope:`);

const agreedRe = /if \(old\["w"\]\.casefold\(\) != new\["w"\]\.casefold\(\) or/;
code = code.replace(agreedRe, `if (_strip_punc(old["w"]) != _strip_punc(new["w"]) or`);

fs.writeFileSync(path, code);
