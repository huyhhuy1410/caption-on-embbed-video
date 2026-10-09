const fs = require('fs');
const path = '../caption-on-embbed-video/test/serve.py';
let code = fs.readFileSync(path, 'utf8');

const copyToRe = /    def copy_to\(self, outputfile\) -> None:\n        try:\n            while self\._remaining > 0:\n                chunk = self\._handle\.read\(min\(65536, self\._remaining\)\)\n                if not chunk:\n                    break\n                outputfile\.write\(chunk\)\n                self\._remaining -= len\(chunk\)\n        finally:\n            self\._handle\.close\(\)/;

code = code.replace(copyToRe, `    def copy_to(self, outputfile) -> None:
        try:
            while self._remaining > 0:
                chunk = self._handle.read(min(65536, self._remaining))
                if not chunk:
                    break
                try:
                    outputfile.write(chunk)
                except ConnectionResetError:
                    # Browser frequently aborts Range requests when scrubbing/seeking.
                    # Ignore the reset instead of dumping a stack trace.
                    break
                self._remaining -= len(chunk)
        finally:
            self._handle.close()`);

fs.writeFileSync(path, code);
