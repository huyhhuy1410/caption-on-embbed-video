"""Static server cho trang test — CÓ hỗ trợ HTTP Range.

⚠️ Vì sao không dùng `python -m http.server`: bản đó KHÔNG trả
`Accept-Ranges`, nên trình duyệt coi video như không seek được. Thao tác tua
trong `<video>` bị từ chối, và ta mất đúng cái phải test (tua → replay).

Browser chỉ cho seek video khi server trả `206 Partial Content` cho yêu cầu
`Range: bytes=a-b`. Video từ nguồn ở xa (Sintel, archive.org) có sẵn nên vẫn
tua được; chỉ video local mới hỏng — dễ gây tưởng nhầm là lỗi extension.

Dùng: python test/serve.py [port]   (mặc định 5173)
"""

import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# `bytes=1234-` | `bytes=1234-5678` — thiếu `Accept-Ranges` thì browser mất seek.
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        # Cache dài hạn đủ để tua lại không phải tải lại từ đầu.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        """Chặn `SimpleHTTPRequestHandler` xử lý 206, ta tự làm."""
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        match = RANGE_RE.match(range_header.strip())
        path = self.translate_path(self.path)
        if match is None or os.path.isdir(path):
            return super().send_head()

        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(handle.fileno()).st_size
        first_text, last_text = match.groups()
        if first_text:
            first = int(first_text)
            last = int(last_text) if last_text else size - 1
        else:
            # `bytes=-N`: N byte CUỐI, tính từ đuôi file.
            if not last_text:
                handle.close()
                self.send_error(400, "Invalid Range")
                return None
            suffix = int(last_text)
            if suffix == 0:
                handle.close()
                self.send_error(416, "Unsatisfiable Range")
                return None
            first = max(0, size - suffix)
            last = size - 1

        # Ngoài file ⇒ 416, KHÔNG phải 200 — browser cần biết là hỏng Range.
        if first >= size or first > last:
            handle.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        last = min(last, size - 1)
        handle.seek(first)

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.send_header("Content-Length", str(last - first + 1))
        self.end_headers()
        return _BoundedReader(handle, last - first + 1)

    def copyfile(self, source, outputfile):  # noqa: N802 - tên của thư viện chuẩn
        # `send_head` đã giới hạn số byte bằng `_BoundedReader`; nếu không,
        # `SimpleHTTPRequestHandler` copy hết file ⇒ sai Content-Length.
        if isinstance(source, _BoundedReader):
            source.copy_to(outputfile)
            return
        super().copyfile(source, outputfile)

    def log_message(self, fmt, *args):  # noqa: N802 - tên của thư viện chuẩn
        # Chỉ log range — log mỗi request làm nhiễu khi xem log test.
        if self.headers.get("Range"):
            super().log_message(fmt, *args)
            
    def handle(self):
        try:
            super().handle()
        except ConnectionResetError:
            # Browser frequently aborts Range requests when scrubbing/seeking.
            pass


class _BoundedReader:
    """Đọc tối đa `remaining` byte rồi tự đóng file."""

    def __init__(self, handle, remaining: int) -> None:
        self._handle = handle
        self._remaining = remaining

    def close(self) -> None:
        self._handle.close()

    def copy_to(self, outputfile) -> None:
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
                except BrokenPipeError:
                    break
                self._remaining -= len(chunk)
        finally:
            self._handle.close()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = ThreadingHTTPServer(("127.0.0.1", port), RangeRequestHandler)
    print(f"Serving {os.getcwd()} with Range support on http://127.0.0.1:{port}")
    print("  -> http://127.0.0.1:%d/multi-video.html" % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
