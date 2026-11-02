#!/usr/bin/env python3
"""Listen on 0.0.0.0:8000 before the application imports.

Uvicorn accepts connections only after the FastAPI lifespan yields. Importing
the app and contacting Postgres used to happen first. When that work never
returned, the process stayed up and nothing was listening, so curl to
127.0.0.1:8000 failed immediately with connection refused.
"""

from __future__ import annotations

import os
import socket
import sys
import traceback

# python /serve_api.py puts "/" on sys.path, not the directory that contains
# the api package. The image keeps that package at /app/api.
APP_ROOT = os.environ.get("SENTINEL_APP_ROOT", "/app")


def ensure_app_path(app_root: str | None = None) -> str:
    """Put the application root on sys.path so `import api` succeeds."""
    root = os.path.abspath(app_root or APP_ROOT)
    sys.path = [entry for entry in sys.path if os.path.abspath(entry or ".") != root]
    sys.path.insert(0, root)
    return root


def listening_socket(host: str = "0.0.0.0", port: int = 8000) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(2048)
    return sock


def hold_open(sock: socket.socket, reason: str) -> None:
    """Keep answering on 8000 after uvicorn exits so the port does not go silent."""
    print(
        f"sentinel-api failed before it could serve the dashboard. Holding http://0.0.0.0:8000/ ({reason}).",
        flush=True,
    )
    try:
        sock.getsockname()
    except OSError:
        sock = listening_socket()
    body = b"Sentinel API failed to start. Read: docker compose logs api --tail 100\n"
    while True:
        try:
            conn, _addr = sock.accept()
        except KeyboardInterrupt:
            return
        except OSError:
            return
        try:
            conn.settimeout(2)
            try:
                conn.recv(4096)
            except OSError:
                pass
            response = (
                b"HTTP/1.1 503 Service Unavailable\r\n"
                b"Content-Type: text/plain; charset=utf-8\r\n"
                b"Connection: close\r\n"
                b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n"
                b"\r\n" + body
            )
            conn.sendall(response)
        except OSError:
            pass
        finally:
            conn.close()


def main() -> None:
    sock = listening_socket()
    print("sentinel-api listening on http://0.0.0.0:8000/", flush=True)
    app_root = ensure_app_path()
    try:
        import uvicorn

        uvicorn.run(
            "api.main:app",
            fd=sock.fileno(),
            host="0.0.0.0",
            port=8000,
            log_level="info",
            app_dir=app_root,
        )
    except SystemExit as exc:
        if exc.code in (0, None):
            raise
        traceback.print_exc()
        hold_open(sock, f"uvicorn exited with status {exc.code}")
    except BaseException:
        traceback.print_exc()
        hold_open(sock, "the API process failed during import or startup")


if __name__ == "__main__":
    main()
