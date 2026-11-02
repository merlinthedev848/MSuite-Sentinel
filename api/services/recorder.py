import asyncio
import logging
import os
import random
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
import httpx
from api.config import settings
from api.services.local_core import local_core

logger = logging.getLogger("mView-Recorder")

RECORDINGS_BASE = Path(settings.recordings_dir)
SEGMENT_DURATION = settings.segment_seconds
RECORD_SUBSTREAM_DEFAULT = settings.record_substream_default
RECORD_VIDEO_CODEC = settings.record_video_codec.lower()
RECORD_VIDEO_CRF = settings.record_video_crf
RECORD_VIDEO_PRESET = settings.record_video_preset


def mask_rtsp_url(url: str | None) -> str:
    """Mask credentials in RTSP URLs for secure logging and diagnostics."""
    if not url:
        return ""
    return re.sub(r'(rtsp(?:s)?://[^:\s/@]+:)([^@\s]+)(@)', r'\1*****\3', url)


class CameraRecorder:
    def __init__(self, camera_id: str, camera_name: str, rtsp_url: str):
        self.camera_id = camera_id
        self.camera_name = camera_name
        self.rtsp_url = rtsp_url
        self._task: asyncio.Task | None = None
        self._stop = False
        self.last_started_at: datetime | None = None
        self.last_error: str | None = None
        self.restart_count = 0

    def start(self):
        self._stop = False
        self._task = asyncio.create_task(self._run_loop(), name=f"recorder-{self.camera_id}")

    def stop(self):
        self._stop = True
        if self._task:
            self._task.cancel()
        self._task = None

    def state(self) -> str:
        """recording while ffmpeg is running, backoff after a failure, otherwise stopped."""
        if self._task is None or self._task.done():
            return "error" if self.last_error else "stopped"
        if self.last_error:
            return "backoff"
        return "recording"

    async def _run_loop(self):
        backoff = 5
        loop = asyncio.get_running_loop()
        while not self._stop:
            t0 = loop.time()
            try:
                self.last_started_at = datetime.now(timezone.utc)
                self.last_error = None
                await self._record_once()
                backoff = 5  # reset on clean exit
            except asyncio.CancelledError:
                logger.info(f"[{self.camera_name}] Recorder cancelled.")
                return
            except Exception as e:
                if loop.time() - t0 > 60:
                    backoff = 5  # it ran healthily for a while before failing
                self.restart_count += 1
                self.last_error = str(e)[-240:]
                await local_core.publish("recorder_error", {
                    "camera_id": self.camera_id,
                    "camera_name": self.camera_name,
                    "error": self.last_error,
                    "restart_count": self.restart_count,
                })
                logger.warning(f"[{self.camera_name}] Recorder error: {e}. Retrying in {backoff}s...")
            if not self._stop:
                await asyncio.sleep(backoff + random.uniform(0, backoff * 0.25))
                backoff = min(backoff * 2, 120)

    async def _record_once(self):
        output_dir = RECORDINGS_BASE / self.camera_id
        output_dir.mkdir(parents=True, exist_ok=True)

        # Output pattern: 2024-01-15_14-00-00.mp4
        output_pattern = str(output_dir / "%Y-%m-%d_%H-%M-%S.mp4")

        # Probe the stream dynamically to detect valid audio
        has_audio = False
        probe_proc = None
        try:
            probe_cmd = [
                "ffprobe",
                "-v", "error",
                "-rtsp_transport", "tcp",
                "-timeout", "8000000",
                "-show_entries", "stream=codec_type,codec_name",
                "-of", "json",
                self.rtsp_url
            ]
            probe_proc = await asyncio.create_subprocess_exec(
                *probe_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(probe_proc.communicate(), timeout=8.0)
            if probe_proc.returncode == 0:
                import json
                data = json.loads(stdout.decode() or "{}")
                for stream in data.get("streams", []):
                    if stream.get("codec_type") == "audio":
                        codec = stream.get("codec_name")
                        if codec and codec != "none":
                            has_audio = True
                            logger.info(f"[{self.camera_name}] Detected audio stream with codec: {codec}")
        except Exception as e:
            logger.warning(f"[{self.camera_name}] ffprobe stream analysis timed out or failed: {e}. Defaulting to video-only.")
        finally:
            if probe_proc is not None:
                await _terminate_process(probe_proc)

        cmd = [
            "ffmpeg",
            "-loglevel", "warning",
            "-analyzeduration", "10000000",
            "-probesize", "10000000",
            "-rtsp_transport", "tcp",
            "-timeout", "10000000",            # 10s socket I/O timeout -> exit on stalled feed
            "-i", self.rtsp_url,
            "-map", "0:v",                     # Always map the video stream
            "-c:v", "copy",                    # Copy video stream — zero transcoding, zero quality loss
        ]

        if RECORD_VIDEO_CODEC == "libx264":
            video_codec_index = cmd.index("-c:v")
            cmd[video_codec_index:video_codec_index + 2] = [
                "-c:v", "libx264",
                "-preset", RECORD_VIDEO_PRESET,
                "-crf", RECORD_VIDEO_CRF,
                "-pix_fmt", "yuv420p",
                "-profile:v", "main",
                "-g", "50",
            ]

        if has_audio:
            cmd.extend([
                "-map", "0:a",                 # Map the audio stream
                "-c:a", "aac",                 # Encode audio to AAC
                "-b:a", "128k",
            ])
        else:
            cmd.append("-an")                  # Disable audio if absent or invalid

        cmd.extend([
            "-ignore_unknown",                 # Skip unknown stream types instead of crashing
            "-f", "segment",
            "-segment_time", str(SEGMENT_DURATION),
            "-segment_format", "mp4",
            "-segment_format_options", "movflags=+faststart",
            "-reset_timestamps", "1",
            "-strftime", "1",
            output_pattern,
        ])

        logger.info(f"[{self.camera_name}] Starting ffmpeg recording → {output_dir}")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        # Read stderr continuously to prevent pipe buffer saturation deadlock.
        # Bounded to the last 50 lines; the finally block guarantees the child is reaped even
        # when this task is cancelled, otherwise orphaned ffmpeg processes pile up per edit.
        stderr_lines: list[str] = []
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                decoded = line.decode(errors="replace").strip()
                if decoded:
                    logger.debug(f"[{self.camera_name}] ffmpeg: {decoded}")
                    stderr_lines.append(decoded)
                    if len(stderr_lines) > 50:
                        stderr_lines.pop(0)

            await proc.wait()
        finally:
            await _terminate_process(proc)

        if proc.returncode not in (0, 255):  # 255 = SIGTERM (normal stop)
            err = "\n".join(stderr_lines) if stderr_lines else "unknown"
            raise RuntimeError(f"ffmpeg exited {proc.returncode}: {err[-300:]}")

        logger.info(f"[{self.camera_name}] ffmpeg segment completed normally.")


async def _terminate_process(proc: "asyncio.subprocess.Process", grace: float = 5.0) -> None:
    """SIGTERM (lets ffmpeg finalize the mp4), then SIGKILL after `grace` seconds."""
    if proc.returncode is not None:
        return
    try:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=grace)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
    except ProcessLookupError:
        pass


async def register_go2rtc_stream(name: str, rtsp_url: str, attempts: int = 5, timeout: float = 3.0) -> bool:
    url = settings.go2rtc_url.rstrip('/')
    if rtsp_url.lower().startswith("rtsp://") and "transport=" not in rtsp_url and "#" not in rtsp_url:
        sep = "&" if "?" in rtsp_url else "?"
        rtsp_url = f"{rtsp_url}{sep}transport=tcp"
    for attempt in range(1, max(1, attempts) + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.put(
                    f"{url}/api/streams",
                    params={"name": name, "src": rtsp_url},
                )
                if res.status_code == 200:
                    logger.info(f"Successfully registered stream {name} in go2rtc (attempt {attempt})")
                    return True
                else:
                    logger.warning(f"Failed to register stream {name} in go2rtc: {res.status_code} {res.text} (attempt {attempt})")
        except Exception as e:
            logger.warning(f"Could not connect to go2rtc API at {url} (attempt {attempt}/{attempts}): {e}")
        if attempt < attempts:
            await asyncio.sleep(0.4 if attempts <= 2 else 2.0)
    return False


async def delete_go2rtc_stream(name: str):
    url = settings.go2rtc_url.rstrip('/')
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.delete(f"{url}/api/streams", params={"name": name})
            if res.status_code == 200:
                logger.info(f"Successfully deleted stream {name} from go2rtc")
            else:
                logger.warning(f"Failed to delete stream {name} from go2rtc: {res.status_code} {res.text}")
    except Exception as e:
        logger.warning(f"Could not connect to go2rtc API at {url} to delete stream: {e}")
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.delete("http://127.0.0.1:1984/api/streams", params={"name": name})
        except Exception:
            pass


class RecorderManager:
    def __init__(self):
        self._recorders: dict[str, CameraRecorder] = {}

    async def sync_cameras(self, cameras: list):
        """
        Called at startup and whenever cameras change.
        Starts recording for every enabled camera with an RTSP URL,
        stops recording for cameras that have been removed.
        """
        current_ids = {cam.id for cam in cameras if cam.enabled and cam.rtsp_url_main}

        # Stop removed cameras
        for cid in list(self._recorders.keys()):
            if cid not in current_ids:
                logger.info(f"Stopping recorder for removed camera {cid}")
                self._recorders.pop(cid).stop()
                asyncio.create_task(delete_go2rtc_stream(cid))
                asyncio.create_task(delete_go2rtc_stream(f"{cid}_main"))
                asyncio.create_task(delete_go2rtc_stream(f"{cid}_sub"))

        # Start new or update changed cameras
        for cam in cameras:
            if cam.enabled and cam.rtsp_url_main:
                use_substream = RECORD_SUBSTREAM_DEFAULT
                if cam.config and "record_substream" in cam.config:
                    use_substream = cam.config.get("record_substream") is True
                record_url = cam.rtsp_url_sub if (use_substream and cam.rtsp_url_sub) else cam.rtsp_url_main
                
                if cam.id not in self._recorders:
                    rec = CameraRecorder(cam.id, cam.name, record_url)
                    self._recorders[cam.id] = rec
                    rec.start()
                    await local_core.publish("recorder_started", {"camera_id": cam.id, "camera_name": cam.name})
                    logger.info(f"Started recorder for [{cam.name}] → {mask_rtsp_url(record_url)}")
                    live_url = cam.rtsp_url_sub or cam.rtsp_url_main
                    asyncio.create_task(register_go2rtc_stream(cam.id, live_url))
                    asyncio.create_task(register_go2rtc_stream(f"{cam.id}_main", cam.rtsp_url_main))
                    if cam.rtsp_url_sub:
                        asyncio.create_task(register_go2rtc_stream(f"{cam.id}_sub", cam.rtsp_url_sub))
                else:
                    existing = self._recorders[cam.id]
                    if existing.rtsp_url != record_url or existing.camera_name != cam.name:
                        logger.info(f"Updating recorder for [{cam.name}] due to configuration change...")
                        existing.stop()
                        rec = CameraRecorder(cam.id, cam.name, record_url)
                        self._recorders[cam.id] = rec
                        rec.start()
                        await local_core.publish("recorder_updated", {"camera_id": cam.id, "camera_name": cam.name})
                        live_url = cam.rtsp_url_sub or cam.rtsp_url_main
                        asyncio.create_task(register_go2rtc_stream(cam.id, live_url))
                        asyncio.create_task(register_go2rtc_stream(f"{cam.id}_main", cam.rtsp_url_main))
                        if cam.rtsp_url_sub:
                            asyncio.create_task(register_go2rtc_stream(f"{cam.id}_sub", cam.rtsp_url_sub))

    def stop_all(self):
        for rec in self._recorders.values():
            rec.stop()
        self._recorders.clear()

    def status(self) -> dict:
        return {cid: rec.state() for cid, rec in self._recorders.items()}

    def diagnostics(self) -> dict:
        return {
            cid: {
                "status": rec.state(),
                "camera_name": rec.camera_name,
                "stream_url": mask_rtsp_url(rec.rtsp_url),
                "started_at": rec.last_started_at.isoformat() if rec.last_started_at else None,
                "restart_count": rec.restart_count,
                "last_error": rec.last_error,
                "task_done": rec._task.done() if rec._task else True,
            }
            for cid, rec in self._recorders.items()
        }


recorder_manager = RecorderManager()


def is_finalized_mp4(file_path: str | Path, stat_size: int | None = None) -> bool:
    """
    Check if an MP4 file has been finalized with a valid moov atom.
    In-progress ffmpeg segments and aborted/corrupted recordings lack a moov atom
    and cannot be decoded or played by web browsers.
    """
    try:
        p = Path(file_path)
        size = stat_size if stat_size is not None else p.stat().st_size
        if size < 10240:
            return False
        with open(p, "rb") as f:
            # Faststart files place moov right after ftyp (within first 64KB)
            header = f.read(min(size, 65536))
            if b"moov" in header:
                return True
            # Standard MP4 files place moov at the end of the file
            if size > 65536:
                check_tail = min(size, 262144)
                f.seek(size - check_tail)
                tail = f.read(check_tail)
                if b"moov" in tail:
                    return True
    except OSError:
        return False
    return False


def needs_browser_transcode(file_path: str | Path, stat_size: int | None = None) -> bool:
    """
    Detect whether an MP4 recording uses H.265/HEVC (hvc1/hev1) or lacks H.264 (avc1),
    requiring on-the-fly H.264 remux/transcode for universal browser playback.
    """
    try:
        p = Path(file_path)
        size = stat_size if stat_size is not None else p.stat().st_size
        with open(p, "rb") as f:
            header = f.read(min(size, 131072))
            if b"hvc1" in header or b"hev1" in header:
                return True
            if b"avc1" in header:
                return False
            if size > 131072:
                check_tail = min(size, 262144)
                f.seek(size - check_tail)
                tail = f.read(check_tail)
                if b"hvc1" in tail or b"hev1" in tail:
                    return True
    except OSError:
        return False
    return False


# (path, size, mtime_ns) -> finalized?  Size/mtime in the key invalidate entries as a file grows,
# so each segment is only inspected once instead of on every listing / Range request.
_FINALIZED_CACHE: dict[tuple[str, int, int], bool] = {}
_FINALIZED_CACHE_MAX = 200_000


def is_finalized_cached(path: str, st: os.stat_result) -> bool:
    key = (path, st.st_size, st.st_mtime_ns)
    hit = _FINALIZED_CACHE.get(key)
    if hit is not None:
        return hit
    result = is_finalized_mp4(path, st.st_size)
    if len(_FINALIZED_CACHE) >= _FINALIZED_CACHE_MAX:
        _FINALIZED_CACHE.clear()  # hard bound on memory
    _FINALIZED_CACHE[key] = result
    return result


_LIST_CACHE: dict[str, tuple[float, list]] = {}


def list_recordings(camera_id: str | None = None) -> list[dict]:
    """Return recording files. Repeat calls within two seconds reuse the last scan."""
    cache_key = camera_id or "*"
    cached = _LIST_CACHE.get(cache_key)
    now_mono = datetime.now(timezone.utc).timestamp()
    if cached and now_mono - cached[0] < 2.0:
        return cached[1]
    results = _scan_recordings(camera_id)
    _LIST_CACHE[cache_key] = (now_mono, results)
    if len(_LIST_CACHE) > 32:
        _LIST_CACHE.clear()
        _LIST_CACHE[cache_key] = (now_mono, results)
    return results


def _scan_recordings(camera_id: str | None = None) -> list[dict]:
    """Return a list of recording files across both hot and cold tiers, optionally filtered by camera."""
    results = []
    hot_base = RECORDINGS_BASE
    cold_env = os.getenv("COLD_STORAGE_PATH", "").strip()
    cold_base = Path(cold_env) if cold_env else None

    bases = [b for b in (hot_base, cold_base) if b is not None and b.exists()]
    if not bases:
        return results

    now_utc = datetime.now(timezone.utc)
    seen_filenames = set()
    max_results = 50000

    for base in bases:
        cam_dirs = [base / camera_id] if camera_id else [d for d in base.iterdir() if d.is_dir()]
        for cam_dir in cam_dirs:
            if not cam_dir.exists():
                continue
            try:
                entries = [entry for entry in os.scandir(cam_dir) if entry.is_file() and entry.name.endswith(".mp4")]
            except OSError:
                continue

            entries.sort(key=lambda x: x.name, reverse=True)

            active_recorders = recorder_manager.status()
            now_ts = now_utc.timestamp()

            for i, entry in enumerate(entries):
                unique_key = (cam_dir.name, entry.name)
                if unique_key in seen_filenames:
                    continue
                seen_filenames.add(unique_key)

                mtime = None
                size_mb = 0.0
                try:
                    stat = entry.stat()
                    if stat.st_size < 10240:
                        continue
                    # Always skip the newest segment if this camera is actively recording and the file was modified recently
                    if i == 0 and active_recorders.get(cam_dir.name) == "recording" and (now_ts - stat.st_mtime) < (SEGMENT_DURATION + 15):
                        continue
                    # Skip unfinalized / actively-writing segments (cached per path+size+mtime)
                    if not is_finalized_cached(entry.path, stat):
                        continue
                    mtime = stat.st_mtime
                    size_mb = round(stat.st_size / 1_048_576, 2)
                except OSError:
                    continue

                match = re.match(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})", entry.name)
                if match:
                    y, m, d, hr, min, sec = match.groups()
                    try:
                        dt = datetime(int(y), int(m), int(d), int(hr), int(min), int(sec), tzinfo=timezone.utc)
                        created_at = dt.isoformat()
                    except ValueError:
                        created_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat() if mtime else now_utc.isoformat()
                else:
                    created_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat() if mtime else now_utc.isoformat()

                results.append({
                    "camera_id": cam_dir.name,
                    "filename": entry.name,
                    "path": entry.path,
                    "size_mb": size_mb,
                    "created_at": created_at,
                    "url": f"/recordings/{cam_dir.name}/{entry.name}",
                })
                if len(results) >= max_results:
                    return results

    results.sort(key=lambda x: x["filename"], reverse=True)
    return results



def storage_report() -> dict:
    """Return per-camera recording storage usage and simple retention estimates."""
    base = RECORDINGS_BASE
    now = datetime.now(timezone.utc)
    report = {
        "segment_seconds": SEGMENT_DURATION,
        "record_substream_default": RECORD_SUBSTREAM_DEFAULT,
        "cameras": [],
        "total_gb": 0.0,
        "estimated_gb_per_day": 0.0,
    }
    if not base.exists():
        return report

    total_bytes = 0
    total_day_bytes = 0
    for cam_dir in sorted([d for d in base.iterdir() if d.is_dir()]):
        files = []
        cam_bytes = 0
        day_bytes = 0
        latest = None
        for f in cam_dir.glob("*.mp4"):
            try:
                stat = f.stat()
            except OSError:
                continue
            mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            cam_bytes += stat.st_size
            if (now - mtime).total_seconds() <= 24 * 3600:
                day_bytes += stat.st_size
            latest = max(latest, mtime) if latest else mtime
            files.append(stat.st_size)

        total_bytes += cam_bytes
        total_day_bytes += day_bytes
        report["cameras"].append({
            "camera_id": cam_dir.name,
            "files": len(files),
            "total_gb": round(cam_bytes / 1_073_741_824, 2),
            "last_24h_gb": round(day_bytes / 1_073_741_824, 2),
            "avg_segment_mb": round((sum(files) / len(files) / 1_048_576) if files else 0, 2),
            "estimated_gb_per_day": round(day_bytes / 1_073_741_824, 2),
            "latest_recording": latest.isoformat() if latest else None,
        })

    report["total_gb"] = round(total_bytes / 1_073_741_824, 2)
    report["estimated_gb_per_day"] = round(total_day_bytes / 1_073_741_824, 2)
    return report


def _recording_roots() -> list[Path]:
    roots = [RECORDINGS_BASE, Path(settings.recordings_dir), Path(settings.storage_path) / "recordings"]
    cold_env = os.getenv("COLD_STORAGE_PATH", "").strip()
    if cold_env:
        roots.append(Path(cold_env))
    unique: list[Path] = []
    seen = set()
    for root in roots:
        try:
            key = str(root.resolve()) if root.exists() else str(root)
        except OSError:
            key = str(root)
        if key not in seen:
            seen.add(key)
            unique.append(root)
    return unique


def purge_all_recordings(camera_id: str | None = None) -> dict:
    """Delete recording segment files from the configured recording store."""
    from api.security import contained_path, safe_camera_id
    purged_count = 0
    purged_bytes = 0

    try:
        cid = safe_camera_id(camera_id) if camera_id and camera_id.strip() else None
    except ValueError:
        logger.warning("Rejected recording purge for an unsafe camera id")
        return {"deleted_files": 0, "deleted_gb": 0.0, "error": "invalid camera id"}

    possible_bases = _recording_roots()

    seen_files = set()
    for base in possible_bases:
        if not base.exists():
            continue

        patterns = ["*.mp4", "*.mkv", "*.ts", "*.jpg", "*.jpeg", "*.png", "*.tmp"]
        for pattern in patterns:
            if cid:
                cam_dir = base / cid
                files = list(cam_dir.rglob(pattern)) if cam_dir.exists() else []
            else:
                files = list(base.rglob(pattern))

            for f in files:
                if contained_path(base, f) is None:
                    continue
                if f.is_file() and f not in seen_files:
                    seen_files.add(f)
                    try:
                        file_size = f.stat().st_size
                        f.unlink()
                        purged_count += 1
                        purged_bytes += file_size
                    except Exception as e:
                        logger.error(f"Error purging recording {f}: {e}")

    target = cid or "all cameras"
    logger.warning(f"Manual recording purge for {target} deleted {purged_count} files ({round(purged_bytes / 1_073_741_824, 2)} GB)")
    return {
        "deleted_files": purged_count,
        "deleted_gb": round(purged_bytes / 1_073_741_824, 2),
    }


def purge_old_recordings(retention_days: int):
    """Delete recording segment files older than retention_days."""
    if retention_days <= 0:
        return
    
    logger.info(f"Running auto-purge worker... (retention: {retention_days} days)")
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    purged_count = 0
    purged_bytes = 0
    
    for root in _recording_roots():
        if not root.exists():
            continue
        for cam_dir in root.iterdir():
            if not cam_dir.is_dir():
                continue
            for f in cam_dir.glob("*.mp4"):
                try:
                    stat = f.stat()
                    file_time = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
                    if file_time < cutoff:
                        file_size = stat.st_size
                        f.unlink()
                        purged_count += 1
                        purged_bytes += file_size
                except Exception as e:
                    logger.error(f"Error purging file {f}: {e}")
                
    if purged_count > 0:
        logger.info(f"Auto-purge complete. Deleted {purged_count} files ({round(purged_bytes / 1_048_576, 1)} MB)")

