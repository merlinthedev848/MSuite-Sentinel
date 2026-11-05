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
        self._cached_has_audio: bool | None = None
        self._has_audio_cached_at: float = 0.0

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

        # Probe the stream dynamically to detect valid audio (cached for 1 hour to avoid process thrashing)
        loop = asyncio.get_running_loop()
        now_ts = loop.time()
        has_audio = False
        if self._cached_has_audio is not None and (now_ts - self._has_audio_cached_at < 3600.0):
            has_audio = self._cached_has_audio
        else:
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
                self._cached_has_audio = has_audio
                self._has_audio_cached_at = now_ts
            except Exception as e:
                logger.warning(f"[{self.camera_name}] ffprobe stream analysis timed out or failed: {e}. Defaulting to video-only.")
                self._cached_has_audio = False
                self._has_audio_cached_at = now_ts - 3540.0
            finally:
                if probe_proc is not None:
                    await _terminate_process(probe_proc)

        cmd = [
            "ffmpeg",
            "-loglevel", "warning",
            # The previous 10s/10MB probe held every new segment that long before
            # the first picture was written. Audio is probed separately above.
            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-analyzeduration", "0",
            "-probesize", "32768",
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

        if not self._stop and proc.returncode not in (0, 255, -15, 143):
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


_STREAM_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")


def browser_stream_sources(name: str, rtsp_url: str, audio_source_url: str | None = None) -> list[str]:
    """RTSP copy, plus an H.264 track and AAC audio transcoding track for the browser."""
    sources = [rtsp_url]
    if audio_source_url and audio_source_url != rtsp_url:
        sources.append(f"{audio_source_url}#video=none")
    if name and _STREAM_NAME.fullmatch(name):
        sources.append(f"ffmpeg:{name}#video=h264")
        sources.append(f"ffmpeg:{name}#audio=aac")
    return sources


async def register_go2rtc_stream(name: str, rtsp_url: str, attempts: int = 5, timeout: float = 3.0, audio_source_url: str | None = None) -> bool:
    url = settings.go2rtc_url.rstrip('/')
    if rtsp_url.lower().startswith("rtsp://") and "transport=" not in rtsp_url and "#" not in rtsp_url:
        sep = "&" if "?" in rtsp_url else "?"
        rtsp_url = f"{rtsp_url}{sep}transport=tcp"
    if audio_source_url and audio_source_url.lower().startswith("rtsp://") and "transport=" not in audio_source_url and "#" not in audio_source_url:
        sep = "&" if "?" in audio_source_url else "?"
        audio_source_url = f"{audio_source_url}{sep}transport=tcp"
    sources = browser_stream_sources(name, rtsp_url, audio_source_url=audio_source_url)
    params = [("name", name)] + [("src", source) for source in sources]
    for attempt in range(1, max(1, attempts) + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.put(
                    f"{url}/api/streams",
                    params=params,
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
                    audio_url = cam.rtsp_url_main or cam.rtsp_url_sub
                    asyncio.create_task(register_go2rtc_stream(cam.id, live_url, audio_source_url=audio_url))
                    if cam.rtsp_url_main:
                        asyncio.create_task(register_go2rtc_stream(f"{cam.id}_main", cam.rtsp_url_main))
                    if cam.rtsp_url_sub:
                        asyncio.create_task(register_go2rtc_stream(f"{cam.id}_sub", cam.rtsp_url_sub, audio_source_url=audio_url))
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
                        audio_url = cam.rtsp_url_main or cam.rtsp_url_sub
                        asyncio.create_task(register_go2rtc_stream(cam.id, live_url, audio_source_url=audio_url))
                        if cam.rtsp_url_main:
                            asyncio.create_task(register_go2rtc_stream(f"{cam.id}_main", cam.rtsp_url_main))
                        if cam.rtsp_url_sub:
                            asyncio.create_task(register_go2rtc_stream(f"{cam.id}_sub", cam.rtsp_url_sub, audio_source_url=audio_url))

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


def moov_at_start(file_path: str | Path) -> bool:
    """True when the browser can start playback from the first bytes."""
    try:
        with open(file_path, "rb") as handle:
            return b"moov" in handle.read(65536)
    except OSError:
        return False


def ensure_faststart(file_path: str | Path) -> Path:
    """Move moov to the front with a stream copy so a browser can range-seek immediately.

    The segment muxer leaves moov at the end, so the player downloads the whole
    minute before the first frame. This is a remux, not a transcode.
    """
    import subprocess
    import time

    path = Path(file_path)
    if not path.is_file() or moov_at_start(path):
        return path
    try:
        stat = path.stat()
        # A multi-hour segment is already range-seekable. Remuxing it here would
        # block the only API worker for the whole file.
        if stat.st_size > 80 * 1024 * 1024 or time.time() - stat.st_mtime < 3:
            return path
    except OSError:
        return path
    tmp = path.with_name(f".{path.name}.faststart")
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(path),
                "-c", "copy",
                "-movflags", "+faststart",
                str(tmp),
            ],
            timeout=30,
            check=False,
        )
        if proc.returncode == 0 and tmp.is_file() and tmp.stat().st_size >= 10240 and moov_at_start(tmp):
            tmp.replace(path)
        elif tmp.exists():
            tmp.unlink()
    except (OSError, subprocess.TimeoutExpired):
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return path


class Mp4Info:
    """What a browser needs from one recording file. ``duration_seconds`` is None when the movie header is missing."""

    __slots__ = ("finalized", "duration_seconds", "hevc")

    def __init__(self, finalized: bool, duration_seconds: float | None, hevc: bool):
        self.finalized = finalized
        self.duration_seconds = duration_seconds
        self.hevc = hevc


_EMPTY_MP4 = Mp4Info(False, None, False)
_MAX_SEGMENT_SECONDS = 24 * 3600
_MOOV_READ_LIMIT = 2_000_000


def _box_header(handle, offset: int, end: int) -> tuple[bytes, int, int] | None:
    """Return (type, header_length, box_size) for the box at ``offset``, or None when it is truncated."""
    if offset + 8 > end:
        return None
    handle.seek(offset)
    header = handle.read(8)
    if len(header) < 8:
        return None
    box_size = int.from_bytes(header[:4], "big")
    box_type = header[4:8]
    header_len = 8
    if box_size == 1:
        extra = handle.read(8)
        if len(extra) < 8:
            return None
        box_size = int.from_bytes(extra, "big")
        header_len = 16
    elif box_size == 0:
        box_size = end - offset
    if box_size < header_len or offset + box_size > end:
        return None
    return box_type, header_len, box_size


def _mvhd_seconds(payload: bytes) -> float | None:
    if len(payload) < 20:
        return None
    version = payload[0]
    if version == 0:
        timescale = int.from_bytes(payload[12:16], "big")
        duration = int.from_bytes(payload[16:20], "big")
    elif version == 1 and len(payload) >= 32:
        timescale = int.from_bytes(payload[20:24], "big")
        duration = int.from_bytes(payload[24:32], "big")
    else:
        return None
    if timescale <= 0 or duration <= 0:
        return None
    seconds = duration / timescale
    if seconds > _MAX_SEGMENT_SECONDS:
        return None
    return seconds


def _duration_in(payload: bytes) -> float | None:
    """Movie duration from the first mvhd box inside an already-read moov payload."""
    offset = 0
    end = len(payload)
    while offset + 8 <= end:
        box_size = int.from_bytes(payload[offset:offset + 4], "big")
        box_type = payload[offset + 4:offset + 8]
        header_len = 8
        if box_size == 1 and offset + 16 <= end:
            box_size = int.from_bytes(payload[offset + 8:offset + 16], "big")
            header_len = 16
        if box_size < header_len or offset + box_size > end:
            return None
        if box_type == b"mvhd":
            return _mvhd_seconds(payload[offset + header_len:offset + box_size])
        offset += box_size
    return None


def inspect_mp4(file_path: str | Path, stat_size: int | None = None) -> Mp4Info:
    """Walk top-level MP4 boxes. A moov atom anywhere in the file means it is finalized.

    The old check only looked at the first 64KB and the last 256KB. A long Hikvision
    segment keeps moov at the end, and that atom is larger than 256KB, so the fourcc
    sits further back than the tail window. Those files were dropped from the timeline
    even though the picture is in them.
    """
    try:
        path = Path(file_path)
        size = stat_size if stat_size is not None else path.stat().st_size
        if size < 10240:
            return _EMPTY_MP4
        with open(path, "rb") as handle:
            offset = 0
            moov_at = None
            moov_size = 0
            while offset + 8 <= size:
                parsed = _box_header(handle, offset, size)
                if parsed is None:
                    break
                box_type, header_len, box_size = parsed
                if box_type == b"moov":
                    moov_at = offset + header_len
                    moov_size = box_size - header_len
                    break
                offset += box_size
            if moov_at is None or moov_size <= 0:
                found = _moov_in_edges(handle, size)
                if found is None:
                    return _EMPTY_MP4
                moov_at, moov_size = found
            handle.seek(moov_at)
            moov = handle.read(min(moov_size, _MOOV_READ_LIMIT))
    except OSError:
        return _EMPTY_MP4
    duration = _duration_in(moov)
    hevc = b"hvc1" in moov or b"hev1" in moov
    return Mp4Info(True, duration, hevc)


def _moov_in_blob(blob: bytes, base: int, file_size: int) -> tuple[int, int] | None:
    """A moov box inside one window. Used when an earlier box claims the rest of the file."""
    start = 4
    while True:
        at = blob.find(b"moov", start)
        if at < 0:
            return None
        box_size = int.from_bytes(blob[at - 4:at], "big")
        header_len = 8
        payload_at = at + 4
        if box_size == 1 and at + 12 <= len(blob):
            box_size = int.from_bytes(blob[at + 4:at + 12], "big")
            header_len = 16
            payload_at = at + 12
        abs_off = base + at - 4
        if header_len <= box_size <= file_size - abs_off and payload_at <= len(blob):
            payload_size = box_size - header_len
            payload = blob[payload_at:payload_at + min(payload_size, _MOOV_READ_LIMIT)]
            if _duration_in(payload) is not None:
                return abs_off + header_len, payload_size
        start = at + 4


def _moov_in_edges(handle, size: int) -> tuple[int, int] | None:
    """Find a real moov in the head or the tail when the box walk stops early.

    A segment whose mdat size is zero swallows every later box, so the walk
    never reaches moov. The picture is still in the file.
    """
    windows = [(0, min(size, _MOOV_READ_LIMIT))]
    tail = min(size, 8_000_000)
    if size > tail:
        windows.append((size - tail, size))
    for begin, end in windows:
        handle.seek(begin)
        blob = handle.read(end - begin)
        found = _moov_in_blob(blob, begin, size)
        if found is not None:
            return found
    return None


def believable_duration(seconds: float | None, size: int) -> float:
    """Movie-header duration, or one segment when that header cannot be the picture.

    A 60-second file whose header says several hours covers the whole morning
    on the timeline. Seeking into it plays nothing, so the player sits on the
    next real file.
    """
    if not seconds or seconds < 0.5:
        return float(SEGMENT_DURATION)
    if seconds > SEGMENT_DURATION * 2 and size / seconds < 512:
        return float(SEGMENT_DURATION)
    return seconds


def is_finalized_mp4(file_path: str | Path, stat_size: int | None = None) -> bool:
    """True when the MP4 has a moov atom and can be opened. An in-progress segment does not."""
    return inspect_mp4(file_path, stat_size).finalized


def needs_browser_transcode(file_path: str | Path, stat_size: int | None = None) -> bool:
    """True when the recording is HEVC. Chrome cannot play that in a video element."""
    return inspect_mp4(file_path, stat_size).hevc


# (path, size, mtime_ns) -> inspection. Size and mtime invalidate a file that is still growing.
_MP4_CACHE: dict[tuple[str, int, int], Mp4Info] = {}
_MP4_CACHE_MAX = 200_000


def mp4_info_cached(path: str, st: os.stat_result) -> Mp4Info:
    key = (path, st.st_size, st.st_mtime_ns)
    hit = _MP4_CACHE.get(key)
    if hit is not None:
        return hit
    result = inspect_mp4(path, st.st_size)
    if len(_MP4_CACHE) >= _MP4_CACHE_MAX:
        _MP4_CACHE.clear()
    _MP4_CACHE[key] = result
    return result


def is_finalized_cached(path: str, st: os.stat_result) -> bool:
    return mp4_info_cached(path, st).finalized


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


def _iter_camera_mp4s(cam_dir: Path):
    """Yield mp4 files in the camera directory and in date folders under it."""
    try:
        for dirpath, dirnames, filenames in os.walk(cam_dir):
            dirnames[:] = [name for name in dirnames if not name.startswith(".")]
            for name in filenames:
                if name.startswith(".") or not name.endswith(".mp4"):
                    continue
                yield Path(dirpath) / name
    except OSError:
        return


def _scan_recordings(camera_id: str | None = None) -> list[dict]:
    """Return recording files from every configured root, including nested date folders."""
    results = []
    bases = [base for base in _recording_roots() if base.exists()]
    if not bases:
        return results

    now_utc = datetime.now(timezone.utc)
    now_ts = now_utc.timestamp()
    seen_filenames = set()
    max_results = 50000
    active_recorders = recorder_manager.status()

    for base in bases:
        try:
            cam_dirs = [base / camera_id] if camera_id else [entry for entry in base.iterdir() if entry.is_dir()]
        except OSError:
            continue
        for cam_dir in cam_dirs:
            if not cam_dir.is_dir():
                continue
            files = list(_iter_camera_mp4s(cam_dir))
            newest_mtime = None
            for path in files:
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                if newest_mtime is None or mtime > newest_mtime:
                    newest_mtime = mtime

            for path in files:
                unique_key = (cam_dir.name, path.name)
                if unique_key in seen_filenames:
                    continue

                try:
                    stat = path.stat()
                    if stat.st_size < 10240:
                        continue
                    writing = (
                        active_recorders.get(cam_dir.name) == "recording"
                        and newest_mtime is not None
                        and stat.st_mtime == newest_mtime
                        and (now_ts - stat.st_mtime) < (SEGMENT_DURATION + 15)
                    )
                    if writing:
                        continue
                    info = mp4_info_cached(str(path), stat)
                    if not info.finalized:
                        continue
                    mtime = stat.st_mtime
                    size_mb = round(stat.st_size / 1_048_576, 2)
                except OSError:
                    continue

                seen_filenames.add(unique_key)
                match = re.match(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})", path.name)
                if match:
                    y, m, d, hr, minute, sec = match.groups()
                    try:
                        dt = datetime(int(y), int(m), int(d), int(hr), int(minute), int(sec), tzinfo=timezone.utc)
                        created_at = dt.isoformat()
                    except ValueError:
                        created_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
                else:
                    created_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

                duration = believable_duration(info.duration_seconds, stat.st_size)
                results.append({
                    "camera_id": cam_dir.name,
                    "filename": path.name,
                    "path": str(path),
                    "size_mb": size_mb,
                    "created_at": created_at,
                    "duration_seconds": round(duration, 3),
                    "url": f"/recordings/{cam_dir.name}/{path.name}",
                })
                if len(results) >= max_results:
                    results.sort(key=lambda item: item["created_at"])
                    return results

    results.sort(key=lambda item: item["created_at"])
    return results


def locate_recording(camera_id: str, filename: str) -> Path | None:
    """Find a segment by file name under a camera directory, including a date subfolder."""
    from api.security import contained_path, safe_camera_id

    try:
        cid = safe_camera_id(camera_id)
    except ValueError:
        return None
    if not filename or filename != Path(filename).name or not filename.endswith(".mp4") or filename.startswith("."):
        return None

    for root in _recording_roots():
        if not root.exists():
            continue
        cam_dir = root / cid
        if not cam_dir.is_dir():
            continue
        direct = cam_dir / filename
        if direct.is_file() and contained_path(root, direct) is not None:
            return direct
        try:
            for match in cam_dir.rglob(filename):
                if match.is_file() and match.name == filename and contained_path(root, match) is not None:
                    return match
        except OSError:
            continue

    export_dir = Path(settings.export_path) if hasattr(settings, "export_path") else Path(settings.storage_path) / "exports"
    exported = export_dir / filename
    if exported.is_file() and contained_path(export_dir, exported) is not None:
        if filename.startswith(f"evidence_") or filename.startswith(f"{cid}_"):
            return exported
    return None



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
    try:
        cam_dirs = sorted([d for d in base.iterdir() if d.is_dir()])
    except OSError:
        cam_dirs = []
    for cam_dir in cam_dirs:
        files = []
        cam_bytes = 0
        day_bytes = 0
        latest = None
        for f in _iter_camera_mp4s(cam_dir):
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
            for f in cam_dir.rglob("*.mp4"):
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

