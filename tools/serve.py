#!/usr/bin/env python3
"""Local preview that behaves like GitHub Pages.

  /store/kaimana  -> store/kaimana.html
  /store          -> store/index.html (after a redirect to /store/)
  unknown paths   -> 404.html with status 404

Serves the repo root. With --prefix /kawikalopez-site it also mirrors the staging subpath.

Run: python3 tools/serve.py [port] [--prefix /kawikalopez-site]
"""

import http.server
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREFIX = ""


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if "--quiet" not in sys.argv:
            super().log_message(fmt, *args)

    def send_head(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if PREFIX and path.startswith(PREFIX):
            path = path[len(PREFIX):] or "/"
            self.path = path
        fs = ROOT / path.lstrip("/")
        if path.endswith("/") and (fs / "index.html").exists():
            return super().send_head()
        if fs.is_dir() and (fs / "index.html").exists():
            self.send_response(301)
            self.send_header("Location", (PREFIX + path + "/"))
            self.end_headers()
            return None
        if fs.is_file():
            return super().send_head()
        html = Path(str(fs) + ".html")
        if html.is_file():
            self.path = path + ".html"
            return super().send_head()
        body = (ROOT / "404.html").read_bytes()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return None


def main():
    global PREFIX
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--prefix" in sys.argv:
        PREFIX = sys.argv[sys.argv.index("--prefix") + 1].rstrip("/")
        args = [a for a in args if a != PREFIX and a != PREFIX + "/"]
    port = int(args[0]) if args else 8779
    os.chdir(ROOT)
    print(f"serving {ROOT} at http://localhost:{port}{PREFIX}/")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
