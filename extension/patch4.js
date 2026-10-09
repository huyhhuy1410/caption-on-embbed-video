const fs = require('fs');
const path = '../sidecar/app/streaming.py';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(`@dataclass(frozen=True)
def _strip_punc(s: str) -> str:
    return s.translate(str.maketrans('', '', string.punctuation)).strip().casefold()

class Scope:`, `def _strip_punc(s: str) -> str:
    return s.translate(str.maketrans('', '', string.punctuation)).strip().casefold()

@dataclass(frozen=True)
class Scope:`);

fs.writeFileSync(path, code);
