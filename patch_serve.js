const fs = require('fs');
const path = '../caption-on-embbed-video/test/serve.py';
let code = fs.readFileSync(path, 'utf8');

const boundedReaderRe = /class _BoundedReader:\n    """Đọc tối đa `remaining` byte rồi tự đóng file\."""\n\n    def __init__\(self, handle, remaining: int\) -> None:\n        self\._handle = handle\n        self\._remaining = remaining/;

code = code.replace(boundedReaderRe, `class _BoundedReader:
    """Đọc tối đa \`remaining\` byte rồi tự đóng file."""

    def __init__(self, handle, remaining: int) -> None:
        self._handle = handle
        self._remaining = remaining

    def close(self) -> None:
        self._handle.close()`);

fs.writeFileSync(path, code);
