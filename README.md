# mView Sentinel — The Ultimate Linux NVR Server

<div align="center">
  <img src="https://raw.githubusercontent.com/merlinthedev848/mview/main/docs/logo.png" alt="mView Sentinel Logo" width="600"/>
  <br/>
  <strong>Professional-grade, open-source Video Management System with Hardware AI.</strong>
</div>

---

## Install

Clone the repository and run `install.sh` from that checkout. The script fast-forwards `main` and starts Compose. It does not reset the worktree or apply the update manifest.

A later run rebuilds the API image only when files under `api/`, `web/dist/`, or `docker/entrypoint-api.sh` changed, and rebuilds the detector image only when files under `detector/` changed. When those inputs and the local images are unchanged, it does not run `docker compose build`. Set `SENTINEL_REBUILD=1` to build both images anyway. The first run after this change still builds once so the stamp matches the images; a warm Docker cache reuses the PyTorch and OpenVINO layers.

```bash
git clone https://github.com/merlinthedev848/MSuite-Sentinel.git /opt/mview-sentinel
cd /opt/mview-sentinel
bash install.sh
```

The dashboard is served by the API at `http://127.0.0.1:8000` and signs in with an HTTP-only cookie. The first admin password is random and is written to the secrets volume. `admin` / `admin` does not sign in. The mobile app still uses the bearer token returned by login.

Postgres, MQTT, and go2rtc bind to `127.0.0.1`. The API uses host networking so ONVIF discovery can see cameras, and it requires a login.

---

## What the default install actually does

- Live view plays go2rtc MPEG-TS/fMP4 or MJPEG through the API proxy.
- Recording is ffmpeg, started by the API, writing MP4 segments. The default codec is `copy`.
- Object detection is Ultralytics YOLO on CPU. It rotates across adopted cameras. `docker-compose.gpu.yml` requests an NVIDIA device, and the published detector image is still the CPU build.
- Event search matches stored object labels. CLIP, InsightFace, and ALPR are not installed, and the server does not invent embeddings, faces, or plates.
- Local scene text is a keyword table. Gemini or OpenAI run only when a key is configured.
- Home Assistant MQTT discovery is published for enabled cameras when the broker is up. It does not include stream passwords.
- The database is PostgreSQL with the pgvector extension available. TimescaleDB is not part of this stack.
- Cold storage is off until `COLD_STORAGE_PATH` is set. Retention deletes expired files from both the hot directory and that cold directory.

---

## Architecture

1. **Frontend:** React, Vite, and TypeScript, built into `web/dist` and served by the API.
2. **API:** Python FastAPI. Sessions are JWTs signed with a generated secret and revoked when the password changes.
3. **Database:** PostgreSQL and pgvector.
4. **Recording:** ffmpeg segments managed by the API.
5. **Detection:** Python Ultralytics YOLO.
6. **Streams:** go2rtc on localhost, reached by the browser through the API.

## 📸 Screenshots

*(Mock screenshots of the visually stunning React UI go here)*

## 📄 License
MIT License. 100% Free and Open Source. No camera fees. No cloud subscriptions.
