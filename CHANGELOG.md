# Sentinel Active NVR - Changelog

All notable changes, fixes, security enhancements, and performance optimizations made to Sentinel NVR are documented in this file.

---

## Unreleased

### Security
- The dashboard session is an HTTP-only cookie. Media and event-stream URLs no longer carry the token, and the page does not keep it in `localStorage`. Bearer tokens remain for the mobile app and scripts.
- Schema changes are recorded in `schema_migrations` and applied in order on startup, including databases created before `token_version` existed.
- Floorplans require a signed-in user. Camera adoption sends the password in the request body.
- Playback uses the recorder segment length, and the events list honors the playback page's request up to 5,000 rows.
- Replaced the public JWT placeholder with a generated secret and removed the `admin` / `admin` login.
- Stopped trusting loopback clients without a token. The detector uses a limited service token.
- Bound Postgres, MQTT, and go2rtc to localhost, removed the unused Redis service, and stopped mounting the Docker socket.
- Disabled unsigned `git reset --hard` updates.
- Stopped returning camera and NVR passwords to users who only have live access.
- Applied `sentinel.yml` when the environment does not set the same value.

### Behavior
- The detector container starts `/app/entrypoint.sh`, which is where the image copies the script. `/entrypoint.sh` is a link to that file, so a last-layer rebuild satisfies the old path without reinstalling the detector packages.
- A repeat upgrade skips the API image, the detector image, or both when that image is already present and its inputs are unchanged. Changing detector dependencies does not rebuild the API image, and the API build context no longer includes `.git` or `vendor`. The fast-forward checkout, the Postgres readiness check, and the refusal of unsigned manifests stay in place.
- Event search is keyword matching. Face recognition and ALPR return nothing until a real engine is configured.
- The detector rotates across cameras and publishes heartbeats. Signal loss is a missed heartbeat, not a failed snapshot.
- Cold storage stays disabled unless `COLD_STORAGE_PATH` is set, and retention deletes expired files there too.
- Recorder status reports backoff instead of always reporting recording.

---

## [1.2.0] - 2026-08-20

### 🚀 Added
- **Web Audio Acoustic Alert Engine (`web/src/lib/audioAlerts.ts`):** Real-time acoustic threat warning chimes synthesized using `AudioContext` upon live SSE AI detection events, with a toggle (**Alert Sound: ON/OFF**) in the navigation sidebar.
- **24-Hour AI Security Intelligence (`GET /events/analytics`):** Real-time hourly detection frequency metrics and category breakdown plotted directly on the Dashboard.
- **Automated System Diagnostics (`GET /system/diagnostics`):** One-click health engine checking PostgreSQL database connectivity, go2rtc stream gateway responsiveness, available storage capacity, and active worker loops.
- **Automated Database Maintenance (`POST /system/maintenance/vacuum`):** One-click database query index optimization (`ANALYZE`) in `api/routers/system.py`.

### ⚡ Optimized & Improved
- **Dependency Upgrades:** Upgraded all frontend npm packages (`vite ^8.2.2`, `@vitejs/plugin-react ^6.1.0`, `framer-motion ^13.1.0`, `lucide-react ^1.33.0`, `react-router-dom ^6.30.6`).
- **Analytics Cache:** Implemented 15-second in-memory TTL caching (`_ANALYTICS_CACHE`) for `/events/analytics`, eliminating database query overhead during frequent dashboard polling.
- **Image Retry Throttling:** Added a 3-second throttle delay (`dataset.retrying`) on `<img onError={...} />` handlers in `VideoPlayer.tsx`, stopping rapid request loops that previously caused browser slowness.
- **VLM Rate Limiting:** Throttled background VLM frame snapshot analysis to once per 10 seconds per camera in `event_processor.py`, reducing background CPU load by up to 90%.
- **Executive Dark Palette (`web/src/index.css`):** Replaced neon gamer styling with an executive dark charcoal (`#090D16`), steel blue (`#0EA5E9`), and indigo (`#6366F1`) enterprise theme.

### 🛠️ Fixed
- **WebRTC Reverse Proxy Gateway (`api/main.py`):** Fixed WebRTC signaling and media channels by forwarding `@app.api_route("/go2rtc/{path:path}")` directly through port `8000`.
- **Internal Loopback & Snapshot Authentication (`api/main.py`):** Added `is_loopback` and `is_snapshot` exceptions to FastAPI `auth_middleware`, allowing loopback queries from `sentinel-detector` (`127.0.0.1`) and browser `<img>` snapshot loads to return `200 OK`.
- **Diagnostics Endpoint Crash (`api/routers/system.py`):** Fixed `NameError: name 'datetime' is not defined` in `run_diagnostics` with safe fallback defaults.
- **Recordings Purge (`api/services/recorder.py`):** Refactored `purge_all_recordings()` to recursively unlink media files across nested volume directories (`.mp4`, `.mkv`, `.ts`, `.jpg`, `.png`, `.tmp`).
- **Cascade Camera Deletion (`api/routers/cameras.py` & `Settings.tsx`):** Fixed `deleteCamera` click handler and added cascade deletion of dependent `SemanticEvent` database records to avoid foreign key errors.
- **Detector Stream Auto-Discovery (`detector/detector.py`):** Detector node now queries `http://127.0.0.1:8000/cameras` to auto-discover active adopted camera streams instead of using legacy hardcoded `camera1` URLs.
