# Sentinel Active NVR - Changelog

All notable changes, fixes, security enhancements, and performance optimizations made to Sentinel NVR are documented in this file.

---

## Unreleased

### Security
- Validated webhook URLs and camera identifiers in automations at creation time to prevent SSRF and path manipulation.
- Encoded credentials in default RTSP camera paths and camera adoption streams with proper URI quoting.
- Bound rate-limiting failure tracking and transcode locks with periodic pruning to prevent memory exhaustion.
- Enforced bounded timeouts on hardware accelerator detection subprocesses to eliminate startup deadlocks on unresponsive GPU drivers.
- Protected event processor zone cooldowns with bounded eviction policies to prevent perpetual memory accumulation.
- Guarded administrative user updates against self-demotion when only one admin remains, preventing complete system lockout.
- Enforced a 25 MB payload limit on floorplan image uploads and guaranteed cleanup of partial uploads on network interruptions.
- Cascaded event deletions to remove orphan entries from the event reviews table upon single event and camera deletions.
- Required at least one action destination (webhook URL or MQTT topic) when creating automation rules.
- Retained the 10 most recent JSON database backups, automatically pruning older backup files to prevent disk exhaustion.
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

### Usability & UI/UX
- Unified application navigation and layout routing by integrating the full-screen Wallboard / NOC mode directly into the primary sidebar with dedicated icon and route handling.
- Enhanced Wallboard NOC display with a live digital clock, online camera status counter, responsive full-screen toggling, and explicit return-to-dashboard navigation fallback when no cameras are configured.
- Streamlined event-to-playback drilldowns across Dashboard and Events pages with URL query encoding and camera state synchronization, ensuring immediate playback seeking when navigating between events on the same camera.
- Hardened AI Operator agent tools with safe fallbacks against null timestamps and camera identifiers, ensuring uninterrupted conversational operation during database anomalies.

### Behavior
- Added `onTouchCancel` event handlers to physical PTZ camera controls to ensure continuous motor motion stops immediately when mobile touch gestures are interrupted.
- Protected snapshot blob downloads from race conditions by deferring `URL.revokeObjectURL` until after the browser download manager begins processing.
- Added active unmount guards to `Dashboard.tsx` and `Events.tsx` polling hooks to prevent state updates after component teardown.
- Eliminated synchronous `os.path.exists` filesystem queries within event listing comprehensions, resolving event loop stalls when retrieving large event batches.
- Applied atomic file replacement staging for map configuration persistence (`default.json`).
- Guarded ONVIF camera media profile queries against `IndexError` when physical cameras report uninitialized or empty media profiles.
- Added graceful return code recognition (SIGTERM/clean stop) in the recorder loop to eliminate false error logs on normal camera shutdown.
- Offloaded operations center health check storage scans (`_recording_dir_size`) to a worker thread via `asyncio.to_thread` to prevent multi-second event loop stalls.
- Hardened Paho MQTT client management in the detector node with explicit socket and loop termination (`loop_stop()`, `disconnect()`) to eliminate background thread leakage.
- Added defensive guards against null or zero-dimension video frames in motion gating pre-filtering and zone spatial calculations.
- Added graceful asynchronous shutdown hooks for notification and vision-language services during application lifecycle termination.
- Offloaded incident video export file inspections to worker threads, added 180s subprocess execution timeouts, and guaranteed cleanup of temporary concatenation files.
- Corrected request user state extraction in the AI assistant router (`api/routers/agent.py`) so admin role and settings permissions are properly recognized.
- Added automatic exponential backoff reconnection for real-time SSE event streaming (`/system/live`) in the frontend shell.
- Fixed Home Assistant MQTT discovery iteration to continue registering remaining cameras if one camera encounters a connection error.
- Made system configuration file persistence atomic via temporary file staging to prevent corruption during unexpected shutdowns.
- The API listens on `0.0.0.0:8000` before it talks to Postgres. A database connection that never returns no longer leaves the process up with the port closed.
- `python /serve_api.py` adds `/app` to the module path before importing `api.main`. The launcher script lives outside that directory, so without this the process holds port 8000 and cannot load the app.
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
