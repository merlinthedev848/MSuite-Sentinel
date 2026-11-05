import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { 
  Play, Pause, RotateCcw, RotateCw, SkipBack, SkipForward, 
  Search, Video, Download, Maximize2, Minimize2 
} from 'lucide-react';
import { apiUrl } from '../lib/endpoints';
import { requestNativeFullscreen, exitNativeFullscreen, isNativeFullscreenActive, addFullscreenChangeListener } from '../lib/fullscreen';
import { edgePieces, resolveLoadedSeek, resolvePlaybackTarget, timelineMs, uncoveredDays, type EdgePiece, type EdgeSegment } from '../lib/playbackSeek';

const inputDate = (date: Date) => {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const inputTime = (date: Date) => {
  const h = `${date.getHours()}`.padStart(2, '0');
  const m = `${date.getMinutes()}`.padStart(2, '0');
  return `${h}:${m}`;
};

interface Camera {
  id: string;
  name: string;
  rtsp_url_main: string;
  rtsp_url_sub?: string;
  status: string;
  resolution?: string;
}

interface RecordingFile {
  camera_id: string;
  filename: string;
  path: string;
  size_mb: number;
  created_at: string;
  url: string;
  duration_seconds?: number;
  startTimestamp: number;
  endTimestamp: number;
  segmentMs?: number;
  edge?: boolean;
  track?: string;
}

const edgeFile = (cameraId: string, piece: EdgePiece): RecordingFile => ({
  camera_id: cameraId,
  filename: `camera-${piece.track}-${piece.startTimestamp}`,
  path: '',
  size_mb: 0,
  created_at: new Date(piece.startTimestamp).toISOString(),
  url: `edge:${cameraId}:${piece.track}:${piece.startTimestamp}:${piece.endTimestamp}`,
  duration_seconds: (piece.endTimestamp - piece.startTimestamp) / 1000,
  startTimestamp: piece.startTimestamp,
  endTimestamp: piece.endTimestamp,
  segmentMs: piece.endTimestamp - piece.startTimestamp,
  edge: true,
  track: piece.track,
});

const fetchEdgeSegments = async (cameraId: string, dayMs: number): Promise<EdgeSegment[]> => {
  const start = new Date(dayMs).toISOString();
  const end = new Date(dayMs + 24 * 3600 * 1000).toISOString();
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    const res = await fetch(apiUrl(
      `/recordings-list/edge?camera_id=${encodeURIComponent(cameraId)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    ), { signal: controller.signal });
    window.clearTimeout(timeout);
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    return Array.isArray(body?.segments) ? body.segments : [];
  } catch {
    return [];
  }
};

interface CameraEvent {
  id: string;
  timestamp: string;
  timestampMs: number;
  object_class: string;
  confidence: number;
}

const Playback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const initCamId = searchParams.get('camera');
  const initTimeParam = searchParams.get('time');

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCam, setSelectedCam] = useState<Camera | null>(null);
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'motion' | 'person' | 'vehicle'>('all');
  
  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1); // default '1x' (speeds[1])
  const [currentTimeMs, setCurrentTimeMs] = useState<number>(0);
  const [activeFile, setActiveFile] = useState<RecordingFile | null>(null);
  const [clipOffset, setClipOffset] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [jumpDate, setJumpDate] = useState(() => {
    if (initTimeParam) {
      const d = new Date(initTimeParam);
      if (!isNaN(d.getTime())) return inputDate(d);
    }
    return inputDate(new Date());
  });
  const [jumpTime, setJumpTime] = useState(() => {
    if (initTimeParam) {
      const d = new Date(initTimeParam);
      if (!isNaN(d.getTime())) return inputTime(d);
    }
    return inputTime(new Date());
  });

  // Timeline window (default 6-hour range)
  const [timelineStart, setTimelineStart] = useState<number>(() => {
    if (initTimeParam) {
      const d = new Date(initTimeParam);
      if (!isNaN(d.getTime())) return d.getTime() - 3 * 3600 * 1000;
    }
    return Date.now() - 3 * 3600 * 1000;
  });
  const [timelineEnd, setTimelineEnd] = useState<number>(() => {
    if (initTimeParam) {
      const d = new Date(initTimeParam);
      if (!isNaN(d.getTime())) return d.getTime() + 3 * 3600 * 1000;
    }
    return Date.now() + 3 * 3600 * 1000;
  });

  const [isDragging, setIsDragging] = useState(false);
  const [toast, setToast] = useState('');
  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 4500);
  };
  const dragStartRef = useRef<{ x: number; start: number; end: number } | null>(null);
  const hasDraggedRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const timeBaseRef = useRef(0);
  const retryCountRef = useRef(0);
  const errorTimeoutRef = useRef<number | null>(null);
  const recordingsRef = useRef<RecordingFile[]>([]);
  const edgeJobsRef = useRef<Map<string, Promise<EdgeSegment[]>>>(new Map());
  const seekGen = useRef(0);

  const [isTheaterFullscreen, setIsTheaterFullscreen] = useState(false);
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);

  useEffect(() => {
    const unsub = addFullscreenChangeListener((active) => {
      setIsNativeFullscreen(active);
      if (!active) {
        setIsTheaterFullscreen(false);
      }
    });
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape' && isTheaterFullscreen) {
        setIsTheaterFullscreen(false);
      } else if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (e.shiftKey) handleRewind30();
        else {
          const video = videoRef.current;
          if (video) video.currentTime = Math.max(0, video.currentTime - 5);
        }
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (e.shiftKey) handleForward30();
        else {
          const video = videoRef.current;
          if (video) video.currentTime = Math.min(video.duration || 999999, video.currentTime + 5);
        }
      } else if (e.key === ']') {
        e.preventDefault();
        setSpeedIndex(i => Math.min(speeds.length - 1, i + 1));
      } else if (e.key === '[') {
        e.preventDefault();
        setSpeedIndex(i => Math.max(0, i - 1));
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        handleToggleFullscreen();
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      unsub();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTheaterFullscreen]);

  const handleToggleFullscreen = async () => {
    if (isNativeFullscreenActive() || isTheaterFullscreen) {
      if (isNativeFullscreenActive()) {
        await exitNativeFullscreen();
      }
      setIsTheaterFullscreen(false);
      return;
    }

    const container = playerContainerRef.current;
    const video = videoRef.current;

    const ok = await requestNativeFullscreen(container, video);
    if (!ok) {
      setIsTheaterFullscreen(true);
    }
  };

  const showVideoMessage = (msg: string, durationMs: number = 4000) => {
    setVideoError(msg);
    if (errorTimeoutRef.current) window.clearTimeout(errorTimeoutRef.current);
    if (durationMs > 0) {
      errorTimeoutRef.current = window.setTimeout(() => {
        setVideoError('');
      }, durationMs);
    }
  };

  const speeds = [0.5, 1, 2, 4, 8, 16];

  // ── 1. Load initial cameras list ───────────────────────────────────
  useEffect(() => {
    const loadCameras = async () => {
      try {
        const res = await fetch(apiUrl('/cameras'));
        if (res.ok) {
          const data = await res.json();
          setCameras(data);
          if (data.length > 0) {
            if (initCamId) {
              const cam = data.find((c: Camera) => c.id === initCamId);
              if (cam) {
                setSelectedCam(cam);
                return;
              }
            }
            setSelectedCam(data[0]);
          }
        }
      } catch (err) {
        console.error("Failed to load cameras:", err);
      }
      setLoading(false);
    };
    loadCameras();
  }, [initCamId]);

  useEffect(() => {
    if (initCamId && cameras.length > 0) {
      const cam = cameras.find((c: Camera) => c.id === initCamId);
      if (cam && cam.id !== selectedCam?.id) {
        setSelectedCam(cam);
      }
    }
  }, [initCamId, cameras, selectedCam?.id]);

  const rememberRecordings = (next: RecordingFile[]) => {
    recordingsRef.current = next;
    setRecordings(next);
    return next;
  };

  const ensureEdge = async (camId: string, days: number[], base: RecordingFile[]) => {
    const wanted = days.slice(0, 3);
    if (wanted.length === 0) return base;
    const jobs = wanted.map(day => {
      const key = `${camId}:${day}`;
      let job = edgeJobsRef.current.get(key);
      if (!job) {
        job = fetchEdgeSegments(camId, day).catch(() => [] as EdgeSegment[]);
        edgeJobsRef.current.set(key, job);
      }
      return job;
    });
    const batches = await Promise.all(jobs);
    const local = base.filter(item => !item.edge);
    const wantedSet = new Set(wanted);
    const keep = base.filter(item => {
      if (!item.edge) return false;
      const date = new Date(item.startTimestamp);
      const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      return !wantedSet.has(day);
    });
    const extra = edgePieces(batches.flat(), local).map(piece => edgeFile(camId, piece));
    const merged = [...local, ...keep, ...extra];
    merged.sort((a, b) => a.startTimestamp - b.startTimestamp);
    return merged;
  };

  // ── 2. Load recordings and events for selected camera ──────────────
  useEffect(() => {
    if (!selectedCam) return;
    retryCountRef.current = 0;
    edgeJobsRef.current = new Map();
    setVideoError('');
    if (errorTimeoutRef.current) window.clearTimeout(errorTimeoutRef.current);
    let isMounted = true;

    const loadData = async () => {
      try {
        const [recRes, eventRes] = await Promise.all([
          fetch(apiUrl(`/recordings-list?camera_id=${selectedCam.id}`)),
          fetch(apiUrl(`/events?camera_id=${selectedCam.id}&limit=1000`))
        ]);

        let recs: RecordingFile[] = [];
        if (recRes.ok) {
          const rawRecs = await recRes.json();
          recs = rawRecs.map((r: any) => {
            let start = 0;
            if (r.created_at) {
              const dt = new Date(r.created_at).getTime();
              if (!isNaN(dt)) start = dt;
            }
            if (!start) {
              const match = r.filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
              if (match) {
                const [_, y, m, d, hr, min, sec] = match;
                start = Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(hr), parseInt(min), parseInt(sec));
              }
            }
            const segmentMs = Math.max(1, Number(r.duration_seconds) || 60) * 1000;
            return {
              ...r,
              startTimestamp: start,
              endTimestamp: start + segmentMs,
              segmentMs,
            };
          }).filter((r: any) => r.startTimestamp > 0);

          // Sort by startTimestamp ascending
          recs.sort((a, b) => a.startTimestamp - b.startTimestamp);

          // A gap up to two segments still belongs to the previous file. A longer
          // gap ends the file at its own segment length.
          for (let i = 0; i < recs.length; i++) {
            const start = recs[i].startTimestamp;
            const segmentMs = recs[i].segmentMs || 60000;
            let end = start + segmentMs;
            if (i < recs.length - 1) {
              const nextStart = recs[i + 1].startTimestamp;
              const gap = nextStart - start;
              if (gap > 0 && gap <= segmentMs * 2) {
                end = nextStart;
              }
            }
            recs[i].endTimestamp = end;
          }
        }
        if (isMounted) rememberRecordings(recs);

        let evs: CameraEvent[] = [];
        if (eventRes.ok) {
          const rawEvents = await eventRes.json();
          evs = rawEvents.map((e: any) => ({
            ...e,
            timestampMs: new Date(e.timestamp).getTime()
          }));
          if (isMounted) setEvents(evs);
        }

        // A detection time seeks into that instant. A short gap moves to the
        // next segment. A long gap stays empty instead of jumping to a later file.
        let targetMs = recs.length > 0 ? recs[recs.length - 1].startTimestamp : Date.now();
        if (initTimeParam) {
          const t = new Date(initTimeParam).getTime();
          if (!isNaN(t)) targetMs = t;
        }
        const openResolved = (clips: RecordingFile[], resolvedUrl: string, seekMs: number) => {
          const file = clips.find(item => item.url === resolvedUrl);
          if (!file) return;
          const offset = Math.max(0, (seekMs - file.startTimestamp) / 1000);
          if (file.edge) {
            timeBaseRef.current = offset;
            pendingSeek.current = null;
          } else {
            timeBaseRef.current = 0;
            pendingSeek.current = offset;
          }
          setActiveFile(file);
          setClipOffset(offset);
          setCurrentTimeMs(seekMs);
          setVideoError('');
          setBuffering(true);
          setIsPlaying(true);
        };
        const gen = ++seekGen.current;
        const localHit = resolvePlaybackTarget(recs, targetMs, true);
        if (isMounted && localHit) {
          openResolved(recs, localHit.url, localHit.seekMs);
          setTimelineStart(localHit.seekMs - 3 * 3600 * 1000);
          setTimelineEnd(localHit.seekMs + 3 * 3600 * 1000);
        } else if (isMounted) {
          setActiveFile(null);
          setCurrentTimeMs(targetMs);
          setTimelineStart(targetMs - 3 * 3600 * 1000);
          setTimelineEnd(targetMs + 3 * 3600 * 1000);
          setVideoError('No recorder file covers this time. Checking the camera...');
        }
        if (isMounted) setLoading(false);

        // Fetch camera edge gaps asynchronously in background without blocking local playback
        const points = evs.map(event => event.timestampMs).filter(stamp => !Number.isNaN(stamp));
        const days = uncoveredDays(recs, points.concat(targetMs)).slice(0, 3);
        if (isMounted && days.length > 0) {
          ensureEdge(selectedCam.id, days, recs).then(merged => {
            if (isMounted && gen === seekGen.current) {
              rememberRecordings(merged);
              const again = resolvePlaybackTarget(merged, targetMs, true);
              if (!localHit && again) {
                openResolved(merged, again.url, again.seekMs);
              } else if (!localHit) {
                setVideoError('No recording segment covers the selected date and time. The camera has no footage for that gap either.');
              }
            }
          }).catch(() => {});
        } else if (isMounted && !localHit) {
          setVideoError('No recording segment covers the selected date and time.');
        }
      } catch (err) {
        console.error('Failed to load recordings', err);
      }
      if (isMounted) setLoading(false);
    };

    loadData();
    setIsPlaying(true);
  }, [selectedCam, initTimeParam]);

  // ── 3. Handle playback logic and seeks ─────────────────────────────
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speeds[speedIndex];
    }
  }, [speedIndex, activeFile]);

  const positionSec = () => timeBaseRef.current + (videoRef.current?.currentTime || 0);

  const openClip = (file: RecordingFile, offsetSec: number) => {
    const durationLimit = Number(file.duration_seconds) || ((file.segmentMs || 60000) / 1000);
    const safeOffset = Math.max(0, Math.min(offsetSec, Math.max(0, durationLimit - 0.25)));
    const video = videoRef.current;
    const sameFile = !file.edge && activeFile?.url === file.url && video;
    if (file.edge) {
      timeBaseRef.current = safeOffset;
      pendingSeek.current = null;
    } else {
      timeBaseRef.current = 0;
      pendingSeek.current = safeOffset;
    }
    const targetSeekMs = file.startTimestamp + safeOffset * 1000;
    setCurrentTimeMs(targetSeekMs);
    setVideoError('');
    setBuffering(true);
    setIsPlaying(true);

    // Keep playhead within visible range if outside
    if (targetSeekMs < timelineStart || targetSeekMs > timelineEnd) {
      const span = timelineEnd - timelineStart;
      setTimelineStart(targetSeekMs - span * 0.5);
      setTimelineEnd(targetSeekMs + span * 0.5);
    }
    if (sameFile && video) {
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 1 && safeOffset <= duration + 0.25) {
        video.currentTime = Math.min(safeOffset, Math.max(0, duration - 0.25));
        return;
      }
    }
    retryCountRef.current = 0;
    setActiveFile(file);
    setClipOffset(safeOffset);
  };

  const seekToTime = async (targetTimeMs: number, findNearest: boolean = false) => {
    const gen = ++seekGen.current;
    let clips = recordingsRef.current;
    let resolved = resolvePlaybackTarget(clips, targetTimeMs, findNearest);
    if (!resolved && selectedCam) {
      const day = new Date(targetTimeMs);
      const dayMs = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      clips = await ensureEdge(selectedCam.id, [dayMs], clips);
      if (gen !== seekGen.current) return false;
      rememberRecordings(clips);
      resolved = resolvePlaybackTarget(clips, targetTimeMs, findNearest);
    }
    if (!resolved) {
      setCurrentTimeMs(targetTimeMs);
      setActiveFile(null);
      setIsPlaying(false);
      setVideoError('No recording segment covers the selected date and time. The camera has no footage for that gap either.');
      return false;
    }
    const file = clips.find(item => item.url === resolved.url);
    if (!file) return false;
    const offset = Math.max(0, (resolved.seekMs - file.startTimestamp) / 1000);
    if (resolved.seekMs < timelineStart || resolved.seekMs > timelineEnd) {
      const span = timelineEnd - timelineStart;
      setTimelineStart(resolved.seekMs - span / 2);
      setTimelineEnd(resolved.seekMs + span / 2);
    }
    openClip(file, offset);
    return true;
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current || !activeFile) return;
    if (pendingSeek.current !== null) {
      const want = pendingSeek.current;
      const mediaTime = videoRef.current.currentTime;
      const duration = videoRef.current.duration;
      if (Number.isFinite(duration) && duration > 1) {
        const target = Math.min(want, Math.max(0, duration - 0.25));
        if (Math.abs(mediaTime - target) > 0.5) {
          return; // Still seeking
        }
        pendingSeek.current = null;
      } else {
        return; // Wait for finite duration metadata before assuming arrived
      }
    }
    const updatedTimeMs = timelineMs(activeFile.startTimestamp, timeBaseRef.current, videoRef.current.currentTime);
    setCurrentTimeMs(updatedTimeMs);

    if (!isDragging && updatedTimeMs > timelineEnd - 10 * 1000) {
      const span = timelineEnd - timelineStart;
      setTimelineStart(updatedTimeMs - span * 0.3);
      setTimelineEnd(updatedTimeMs + span * 0.7);
    }
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speeds[speedIndex];
    if (activeFile?.edge) {
      pendingSeek.current = null;
      if (isPlaying) {
        video.play().catch(err => {
          if (err.name === 'NotAllowedError') {
            video.muted = true;
            video.play().catch(() => {});
          }
        });
      }
      return;
    }
    const want = pendingSeek.current;
    if (want !== null) {
      const decision = resolveLoadedSeek(want, video.duration);
      timeBaseRef.current = decision.timeBaseSec;
      if (decision.mediaSeekSec === null || Math.abs(video.currentTime - decision.mediaSeekSec) < 0.2) {
        pendingSeek.current = null;
      } else {
        video.currentTime = decision.mediaSeekSec;
      }
    }
    if (isPlaying) {
      video.play().catch(err => {
        if (err.name === 'NotAllowedError') {
          video.muted = true;
          video.play().catch(() => {});
        }
      });
    }
  };

  const handleSeeked = () => {
    pendingSeek.current = null;
  };

  const handleVideoEnded = () => {
    if (!activeFile) return;
    const currentIndex = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIndex !== -1 && currentIndex < recordings.length - 1) {
      openClip(recordings[currentIndex + 1], 0);
      return;
    }
    setIsPlaying(false);
  };

  const handleRecordingError = () => {
    const mediaError = videoRef.current?.error;
    if (mediaError && mediaError.code === 1) return;
    if (activeFile && retryCountRef.current < 1) {
      retryCountRef.current += 1;
      pendingSeek.current = clipOffset;
      timeBaseRef.current = 0;
      setBuffering(true);
      setRetryNonce(n => n + 1);
      return;
    }
    setBuffering(false);
    setIsPlaying(false);
    showVideoMessage(
      activeFile?.edge
        ? 'The camera did not return footage for this time.'
        : 'Unable to play this recording segment in the browser.',
      0,
    );
  };

  // ── 4. Transport Control Handlers ──────────────────────────────────
  useEffect(() => {
    if (!buffering || !activeFile) return;
    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      if (video.error && video.error.code !== 1) {
        handleRecordingError();
        return;
      }
      if (video.readyState >= 2) setBuffering(false);
    }, 20000);
    return () => window.clearTimeout(timer);
  }, [buffering, activeFile?.url, clipOffset, retryNonce]);

  const handlePlayPause = () => {
    if (!videoRef.current) return;
    setVideoError('');
    if (videoRef.current.paused) {
      videoRef.current.muted = false;
      videoRef.current.play().catch(() => {
        if (videoRef.current) {
          videoRef.current.muted = true;
          videoRef.current.play().catch(() => {});
        }
      });
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleRewind30 = () => {
    if (!activeFile) return;
    const target = positionSec() - 30;
    if (target >= 0) {
      openClip(activeFile, target);
      return;
    }
    const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIdx > 0) {
      const prevFile = recordings[currentIdx - 1];
      const prevDur = Math.max(0.5, (prevFile.endTimestamp - prevFile.startTimestamp) / 1000);
      openClip(prevFile, Math.max(0, prevDur + target));
    } else {
      openClip(activeFile, 0);
    }
  };

  const handleForward30 = () => {
    if (!activeFile) return;
    const dur = Math.max(0.5, (activeFile.endTimestamp - activeFile.startTimestamp) / 1000);
    const target = positionSec() + 30;
    if (target < dur) {
      openClip(activeFile, target);
      return;
    }
    const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIdx !== -1 && currentIdx < recordings.length - 1) {
      openClip(recordings[currentIdx + 1], Math.max(0, target - dur));
    }
  };

  const handlePrevSegment = () => {
    if (!activeFile) return;
    const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIdx > 0) openClip(recordings[currentIdx - 1], 0);
  };

  const handleNextSegment = () => {
    if (!activeFile) return;
    const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIdx !== -1 && currentIdx < recordings.length - 1) openClip(recordings[currentIdx + 1], 0);
  };

  // ── 5. Timeline Click & Drag & Zoom handlers ─────────────────────────
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return;
    }
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickRatio = clickX / rect.width;
    const targetTime = timelineStart + clickRatio * (timelineEnd - timelineStart);
    seekToTime(targetTime, true);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragStartRef.current = {
      x: e.clientX,
      start: timelineStart,
      end: timelineEnd
    };
    setIsDragging(true);
    hasDraggedRef.current = false;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || !timelineRef.current) return;
    const deltaX = e.clientX - dragStartRef.current.x;
    if (Math.abs(deltaX) > 5) {
      hasDraggedRef.current = true;
    }
    if (isDragging) {
      const rect = timelineRef.current.getBoundingClientRect();
      const timeSpan = dragStartRef.current.end - dragStartRef.current.start;
      const deltaMs = (deltaX / rect.width) * timeSpan;
      setTimelineStart(dragStartRef.current.start - deltaMs);
      setTimelineEnd(dragStartRef.current.end - deltaMs);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDragging) {
      setIsDragging(false);
      dragStartRef.current = null;
      e.preventDefault();
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const currentSpan = timelineEnd - timelineStart;

    // Horizontal trackpad swipe or Shift + wheel: pan time horizontally
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      const shiftMs = (delta / (rect.width || 1000)) * currentSpan;
      setTimelineStart(prev => prev + shiftMs);
      setTimelineEnd(prev => prev + shiftMs);
      return;
    }

    // Vertical wheel or Ctrl/Cmd pinch: zoom centered at mouse position
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85;
    const mouseX = e.clientX - rect.left;
    const mouseRatio = Math.max(0, Math.min(1, mouseX / (rect.width || 1)));
    const newSpan = currentSpan * zoomFactor;
    const targetTime = timelineStart + mouseRatio * currentSpan;
    const newStart = targetTime - mouseRatio * newSpan;
    const newEnd = newStart + newSpan;

    const minSpan = 10 * 1000;
    const maxSpan = 7 * 24 * 3600 * 1000;
    if (newSpan >= minSpan && newSpan <= maxSpan) {
      setTimelineStart(newStart);
      setTimelineEnd(newEnd);
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    dragStartRef.current = {
      x: e.touches[0].clientX,
      start: timelineStart,
      end: timelineEnd
    };
    setIsDragging(true);
    hasDraggedRef.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || !timelineRef.current) return;
    const deltaX = e.touches[0].clientX - dragStartRef.current.x;
    if (Math.abs(deltaX) > 5) {
      hasDraggedRef.current = true;
    }
    if (isDragging) {
      const rect = timelineRef.current.getBoundingClientRect();
      const timeSpan = dragStartRef.current.end - dragStartRef.current.start;
      const deltaMs = (deltaX / rect.width) * timeSpan;
      setTimelineStart(dragStartRef.current.start - deltaMs);
      setTimelineEnd(dragStartRef.current.end - deltaMs);
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    dragStartRef.current = null;
  };

  const zoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    const currentSpan = timelineEnd - timelineStart;
    const newSpan = currentSpan * 0.7;
    const center = timelineStart + currentSpan / 2;
    setTimelineStart(center - newSpan / 2);
    setTimelineEnd(center + newSpan / 2);
  };

  const zoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    const currentSpan = timelineEnd - timelineStart;
    const newSpan = Math.min(currentSpan * 1.5, 7 * 24 * 3600 * 1000);
    const center = timelineStart + currentSpan / 2;
    setTimelineStart(center - newSpan / 2);
    setTimelineEnd(center + newSpan / 2);
  };

  const handleJumpToTime = () => {
    if (!jumpDate || !jumpTime) return;
    const target = new Date(`${jumpDate}T${jumpTime}`).getTime();
    if (Number.isNaN(target)) {
      setVideoError('Choose a valid date and time.');
      return;
    }
    setTimelineStart(target - 3 * 3600 * 1000);
    setTimelineEnd(target + 3 * 3600 * 1000);
    seekToTime(target, true);
  };

  // ── 6. UI Mappings ────────────────────────────────────────────────
  const filteredCameras = React.useMemo(() => {
    return cameras.filter(cam =>
      cam.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [cameras, searchQuery]);

  const recordingSrc = (url: string) => apiUrl(url);

  const withStart = (url: string, offsetSec: number) => {
    if (activeFile?.edge) {
      const startMs = activeFile.startTimestamp + Math.max(0, offsetSec) * 1000;
      const track = activeFile.track || '101';
      return apiUrl(
        `/recordings/${encodeURIComponent(activeFile.camera_id)}/edge?start=${encodeURIComponent(new Date(startMs).toISOString())}&end=${encodeURIComponent(new Date(activeFile.endTimestamp).toISOString())}&track=${encodeURIComponent(track)}`,
      );
    }
    const base = recordingSrc(url);
    const joiner = base.includes('?') ? '&' : '?';
    return `${base}${joiner}t=${offsetSec.toFixed(3)}`;
  };

  const formatTimeHM = (timeMs: number) => {
    if (!timeMs) return '--:--';
    return new Date(timeMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };

  const formatTimeHMS = (timeMs: number) => {
    if (!timeMs) return '--:--:--';
    return new Date(timeMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const getPercentage = (timeMs: number) => {
    const total = timelineEnd - timelineStart;
    const val = timeMs - timelineStart;
    return Math.max(0, Math.min(100, (val / total) * 100));
  };

  // Generate hourly scale ticks
  const timelineTicks = React.useMemo(() => {
    const ticks = [];
    const interval = 30 * 60 * 1000; // 30 minutes
    let start = Math.ceil(timelineStart / interval) * interval;
    while (start <= timelineEnd) {
      ticks.push(start);
      start += interval;
    }
    return ticks;
  }, [timelineStart, timelineEnd]);

  // Categorize events
  const getEventClass = (cls: string) => {
    const c = cls.toLowerCase();
    if (c === 'person') return 'person';
    if (c === 'car' || c === 'truck' || c === 'bus' || c === 'vehicle') return 'vehicle';
    return 'motion';
  };

  const filteredEvents = React.useMemo(() => {
    return events.filter(e => {
      if (activeFilter === 'all') return true;
      return getEventClass(e.object_class) === activeFilter;
    });
  }, [events, activeFilter]);

  return (
    <div className="playback-layout">
      {/* ── Left Sidebar: Camera List ── */}
      <div className="playback-sidebar">
        <div className="playback-search-box">
          <Search size={16} className="playback-search-icon" />
          <input 
            type="text" 
            className="playback-search-input" 
            placeholder="Search cameras..." 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        
        <div className="playback-camera-list">
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)' }}>
              <div className="spinner" style={{ margin: '0 auto 10px' }} />
              Loading cameras...
            </div>
          ) : filteredCameras.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)' }}>No cameras found</div>
          ) : (
            filteredCameras.map(cam => (
              <div 
                key={cam.id} 
                className={`playback-camera-item${selectedCam?.id === cam.id ? ' active' : ''}`}
                onClick={() => setSelectedCam(cam)}
              >
                <div className="playback-camera-info">
                  <Video size={16} />
                  <span className="playback-camera-name">{cam.name}</span>
                </div>
                {cam.status === 'recording' && (
                  <span style={{ width: 8, height: 8, background: 'var(--red)', borderRadius: '50%', display: 'inline-block' }} />
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right Content Area ── */}
      <div className="playback-main">
        {/* Video Player */}
        <div ref={playerContainerRef} className={`playback-video-container${isTheaterFullscreen ? ' theater-fullscreen' : ''}`}>
          {isTheaterFullscreen && (
            <button className="theater-exit-btn" onClick={handleToggleFullscreen} title="Exit Fullscreen (Esc)">
              <Minimize2 size={15} /> Exit Fullscreen
            </button>
          )}
          {activeFile ? (
            <>
              {/* Top Custom Metadata Text Overlay */}
              <div style={{ position: 'absolute', top: 16, left: 20, zIndex: 10, textShadow: '0 2px 4px rgba(0,0,0,0.8)' }}>
                <h2 style={{ fontSize: '1rem', color: '#fff', fontWeight: 700, margin: 0 }}>{selectedCam?.name}</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--t2)' }}>{selectedCam?.resolution || '1080p'} recorded footage</span>
              </div>
              <div style={{ position: 'absolute', top: 16, right: 20, zIndex: 10, fontSize: '1rem', color: '#fff', fontWeight: 600, fontFamily: 'JetBrains Mono', textShadow: '0 2px 4px rgba(0,0,0,0.8)' }}>
                {formatTimeHMS(currentTimeMs)}
              </div>

              <video
                ref={videoRef}
                key={`${activeFile.url}@${retryNonce}`}
                src={withStart(activeFile.url, clipOffset)}
                autoPlay
                playsInline
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onSeeked={handleSeeked}
                onEnded={handleVideoEnded}
                onWaiting={() => setBuffering(true)}
                onPlaying={() => {
                  setBuffering(false);
                  setIsPlaying(true);
                  setVideoError('');
                }}
                onCanPlay={() => setBuffering(false)}
                onError={handleRecordingError}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={handlePlayPause}
                style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: 'pointer' }}
              />

              {(buffering || videoError) && (
                <div style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  zIndex: 20,
                  background: 'rgba(0,0,0,0.72)',
                  border: `1px solid ${videoError ? 'var(--red)' : 'var(--cyan-border)'}`,
                  color: videoError ? 'var(--red)' : '#fff',
                  borderRadius: 10,
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: '0.82rem',
                  boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
                }}>
                  {buffering && !videoError && <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />}
                  <span>{videoError || 'Buffering recording...'}</span>
                </div>
              )}

              {/* Bottom Custom Play Bar overlay */}
              <div className="playback-metadata-overlay">
                <button 
                  onClick={handlePlayPause}
                  style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer' }}
                >
                  {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                </button>
                
                <span className="playback-player-title" style={{ fontSize: '0.8rem', color: '#fff', marginRight: 'auto', marginLeft: 12, fontWeight: 500 }}>
                  Main Video Player
                </span>

                <div className="playback-pills">
                  <div className="playback-pill" style={{ fontFamily: 'monospace' }}>{formatTimeHMS(currentTimeMs)}</div>
                  <div className="playback-pill">{selectedCam?.name}</div>
                  <div className="playback-pill">{selectedCam?.resolution || '1080p'}</div>

                  <button 
                    className="btn btn-primary"
                    style={{ fontSize: '0.72rem', padding: '2px 8px', display: 'flex', gap: 4, alignItems: 'center' }}
                    onClick={async () => {
                      if (!selectedCam) return;
                      try {
                        const res = await fetch(apiUrl('/recordings-list/export'), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            camera_id: selectedCam.id,
                            start_time: new Date(timelineStart).toISOString(),
                            end_time: new Date(timelineEnd).toISOString(),
                          })
                        });
                        if (!res.ok) {
                          const err = await res.json().catch(() => ({}));
                          showToast(`Export Failed: ${err.detail || 'Unable to generate incident package'}`);
                          return;
                        }
                        const data = await res.json();
                        
                        // Automatically trigger browser file download
                        const downloadLink = document.createElement('a');
                        const dlUrl = data.download_url.includes('?') ? `${data.download_url}&download=1` : `${data.download_url}?download=1`;
                        downloadLink.href = recordingSrc(dlUrl);
                        downloadLink.download = data.filename;
                        document.body.appendChild(downloadLink);
                        downloadLink.click();
                        document.body.removeChild(downloadLink);

                        showToast(`Evidence Package Ready! Verified SHA-256: ${data.sha256_hash.slice(0, 16)}...`);
                      } catch (error) {
                        showToast(`Export Network Error: ${error instanceof Error ? error.message : 'Request failed'}`);
                      }
                    }}
                  >
                    <Download size={12} /> Export Package
                  </button>


                  <button 
                    style={{ background: 'transparent', border: 'none', color: (isTheaterFullscreen || isNativeFullscreen) ? 'var(--cyan)' : 'var(--t2)', cursor: 'pointer', padding: 4 }}
                    onClick={handleToggleFullscreen}
                    title={isTheaterFullscreen || isNativeFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                  >
                    {isTheaterFullscreen || isNativeFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--t3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <Video size={48} strokeWidth={1} />
              <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--t2)' }}>{videoError ? 'No footage at this time' : 'No recordings available'}</div>
              <div style={{ fontSize: '0.8rem', maxWidth: 420 }}>{videoError || 'Choose another camera or ensure recording is active.'}</div>
            </div>
          )}
        </div>

        {/* Timeline Section */}
        <div className="playback-timeline-section">
          <div className="playback-timeline-header">
            <h3 className="playback-timeline-title">Smart Playback Timeline</h3>
            <div className="playback-timeline-filters">
              {/* Zoom Buttons */}
              <button className="filter-btn all" onClick={zoomIn} title="Zoom In (Scroll to zoom)" style={{ marginRight: 6 }}>Zoom +</button>
              <button className="filter-btn all" onClick={zoomOut} title="Zoom Out (Scroll to zoom)" style={{ marginRight: 18 }}>Zoom -</button>

              <button 
                className={`filter-btn all${activeFilter === 'all' ? ' active' : ''}`}
                onClick={() => setActiveFilter('all')}
              >
                All Events
              </button>
              <button 
                className={`filter-btn motion${activeFilter === 'motion' ? ' active' : ''}`}
                onClick={() => setActiveFilter('motion')}
              >
                Motion
              </button>
              <button 
                className={`filter-btn person${activeFilter === 'person' ? ' active' : ''}`}
                onClick={() => setActiveFilter('person')}
              >
                Person
              </button>
              <button 
                className={`filter-btn vehicle${activeFilter === 'vehicle' ? ' active' : ''}`}
                onClick={() => setActiveFilter('vehicle')}
              >
                Vehicle
              </button>
            </div>
          </div>

          {/* Timeline Viewport */}
          <div 
            className="timeline-viewport" 
            ref={timelineRef}
            onClick={handleTimelineClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
          >
            {/* Lane Separators */}
            <div className="timeline-track-separator t1" />
            <div className="timeline-track-separator t2" />
            <div className="timeline-track-separator t3" />

            {/* Sidebar background overlay for labels */}
            <div className="timeline-labels-bg" />

            {/* Visual labels on tracks */}
            <div className="timeline-track-label motion">Motion</div>
            <div className="timeline-track-label person">Person</div>
            <div className="timeline-track-label recording">Footage</div>
            <div className="timeline-track-label vehicle">Vehicle</div>

            {/* Continuous footage bar */}
            {recordings.map((rec, i) => {
              if (rec.endTimestamp < timelineStart || rec.startTimestamp > timelineEnd) return null;
              const left = getPercentage(rec.startTimestamp);
              const right = getPercentage(rec.endTimestamp);
              const width = right - left;
              return (
                <div 
                  key={i} 
                  className="timeline-recording-bar"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })}

            {/* Event Capsules */}
            {filteredEvents.map((ev, i) => {
              // visual event capsule is 2.5 minutes wide
              const durationMs = 2.5 * 60 * 1000;
              const start = ev.timestampMs - durationMs / 2;
              const end = ev.timestampMs + durationMs / 2;
              if (end < timelineStart || start > timelineEnd) return null;

              const left = getPercentage(start);
              const right = getPercentage(end);
              const width = right - left;
              const evClass = getEventClass(ev.object_class);

              return (
                <div 
                  key={ev.id || i}
                  className={`timeline-event-pill ${evClass}`}
                  title={`${ev.object_class} ${formatTimeHMS(ev.timestampMs)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    seekToTime(ev.timestampMs, true);
                  }}
                  style={{ left: `${left}%`, width: `${width}%`, cursor: 'pointer', zIndex: 6 }}
                >
                  {/* Small tag indicator inside viewport on hover */}
                  <div className="timeline-event-tag">
                    {ev.object_class?.split(/[:@]/)[0]?.trim() || 'Event'} ({formatTimeHMS(ev.timestampMs)})
                  </div>
                </div>
              );
            })}

            {/* Time Axis Ticks */}
            <div className="timeline-ticks-layer">
              {timelineTicks.map((t, idx) => {
                const left = getPercentage(t);
                return (
                  <React.Fragment key={idx}>
                    <div className="timeline-tick-line" style={{ left: `${left}%` }} />
                    <span className="timeline-tick-label" style={{ left: `${left}%` }}>
                      {formatTimeHM(t)}
                    </span>
                  </React.Fragment>
                );
              })}
            </div>

            {/* Dynamic Playhead */}
            {currentTimeMs > timelineStart && currentTimeMs < timelineEnd && (
              <div 
                className="timeline-playhead" 
                style={{ left: `${getPercentage(currentTimeMs)}%` }}
              >
                <div className="timeline-playhead-cap">
                  {formatTimeHMS(currentTimeMs)}
                </div>
              </div>
            )}
          </div>

          {/* Timeline Controls & Speed Selector Row */}
          <div className="playback-controls-section">
            <div className="speed-panel" style={{ minWidth: 360 }}>
              <span className="speed-title">Jump to Date & Time</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'center' }}>
                <input
                  className="form-input"
                  type="date"
                  value={jumpDate}
                  onChange={e => setJumpDate(e.target.value)}
                  style={{ height: 30, padding: '4px 9px', fontSize: '0.78rem' }}
                />
                <input
                  className="form-input"
                  type="time"
                  value={jumpTime}
                  onChange={e => setJumpTime(e.target.value)}
                  style={{ height: 30, padding: '4px 9px', fontSize: '0.78rem' }}
                />
                <button className="btn btn-primary" style={{ height: 30, padding: '4px 12px' }} onClick={handleJumpToTime}>
                  Jump
                </button>
              </div>
            </div>

            {/* Transport Controls Bar */}
            <div className="transport-pill">
              <button className="transport-btn" onClick={handleRewind30} title="-30s">
                <RotateCcw size={16} />
                <span style={{ fontSize: '0.62rem', marginLeft: 4, fontWeight: 'bold' }}>30s</span>
              </button>
              <button className="transport-btn" onClick={handlePrevSegment} title="Prev Segment">
                <SkipBack size={16} />
              </button>
              <button 
                className="transport-btn play-pause" 
                onClick={handlePlayPause}
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <button className="transport-btn" onClick={handleNextSegment} title="Next Segment">
                <SkipForward size={16} />
              </button>
              <button className="transport-btn" onClick={handleForward30} title="+30s">
                <span style={{ fontSize: '0.62rem', marginRight: 4, fontWeight: 'bold' }}>30s</span>
                <RotateCw size={16} />
              </button>
            </div>

            {/* Playback Speed Selector */}
            <div className="speed-panel">
              <span className="speed-title">Playback Speed Selector</span>
              <div className="speed-slider-wrap">
                <input 
                  type="range" 
                  min="0" 
                  max="5" 
                  step="1"
                  value={speedIndex}
                  onChange={e => setSpeedIndex(parseInt(e.target.value))}
                  style={{ accentColor: 'var(--cyan)', cursor: 'pointer', width: '100%' }}
                />
                <div className="speed-labels">
                  {speeds.map((s, idx) => (
                    <span 
                      key={idx} 
                      className={speedIndex === idx ? 'active' : ''}
                      onClick={() => setSpeedIndex(idx)}
                      style={{ cursor: 'pointer' }}
                    >
                      {s}x
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};

export default Playback;
