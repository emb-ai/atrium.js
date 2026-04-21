#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        # Let the browser know range requests are supported
        path = self.translate_path(self.path)
        try:
            f = open(path, 'rb')
        except (IOError, IsADirectoryError):
            return super().send_head()

        import os, mimetypes
        fs = os.fstat(f.fileno())
        size = fs.st_size
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'

        range_header = self.headers.get('Range')
        if not range_header:
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(size))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            return f

        # Parse "bytes=start-end"
        ranges = range_header.strip().replace('bytes=', '')
        start, _, end = ranges.partition('-')
        start = int(start) if start else 0
        end = int(end) if end else size - 1
        end = min(end, size - 1)
        length = end - start + 1

        f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        return f

ThreadingHTTPServer(('', 8000), RangeHandler).serve_forever()
