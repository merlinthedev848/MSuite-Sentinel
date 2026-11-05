import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, RotateCcw, RotateCw,
  Maximize, Minimize, Film, Shield, Download, X, CheckCircle, FileVideo
} from 'lucide-react';
import { apiUrl } from '../../lib/endpoints';
import { requestNativeFullscreen, exitNativeFullscreen, isNativeFullscreenActive, addFullscreenChangeListener } from '../../lib/fullscreen';
import { 
  resolvePlaybackTarget, resolveLoadedSeek, edgePieces,
  type EdgePiece, type EdgeSegment 
} from '../../lib/playbackSeek';

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

interface CameraEvent {
  id: string;
  timestamp: string;
  timestampMs: number;
  object_class: string;
  confidence: number;
}

const inputDate = (date: Date) => {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
};

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
  const res = await fetch(apiUrl(
    `/recordings-list/edge?camera_id=${encodeURIComponent(cameraId)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
  ));
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.segments) ? body.segments : [];
};

interface MobilePlaybackProps {
  cameras: Camera[];
  initialCameraId?: string;
  initialTime?: string;
}

export const MobilePlayback: React.FC<MobilePlaybackProps> = ({
  cameras,
  initialCameraId,
  initialTime,
}) => {
  const [selectedCam, setSelectedCam] = useState<Camera | null>(() => {
    if (initialCameraId) {
      return cameras.find(c => c.id === initialCameraId) || cameras[0] || null;
    }
    return cameras[0] || null;
  });

  const [recordings, setRecordings] = useState<RecordingFile[]>([]);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'all' | 'person' | 'vehicle' | 'motion'>('all');

  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1); // speeds[1] = 1x
  const [currentTimeMs, setCurrentTimeMs] = useState<number>(0);
  const [activeFile, setActiveFile] = useState<RecordingFile | null>(null);
  const [clipOffset, setClipOffset] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [videoError, setVideoError] = useState('');

  const [selectedDate, setSelectedDate] = useState<string>(() => {
    if (initialTime) {
      const d = new Date(initialTime);
      if (!isNaN(d.getTime())) return inputDate(d);
    }
    return inputDate(new Date());
  });

  // Export state
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportMode, setExportMode] = useState<'segment' | 'custom'>('custom');
  const [exportMinutesPreset, setExportMinutesPreset] = useState<number>(3);
  const [exportReason, setExportReason] = useState('Mobile incident clip');
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportResult, setExportResult] = useState<any>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const timeBaseRef = useRef(0);
  const seekGen = useRef(0);
  const recordingsRef = useRef<RecordingFile[]>([]);
  const edgeJobsRef = useRef<Map<string, Promise<EdgeSegment[]>>>(new Map());

  const speeds = [0.5, 1, 2, 4];

  // Update selected cam if initialCameraId changes
  useEffect(() => {
    if (initialCameraId && cameras.length > 0) {
      const cam = cameras.find(c => c.id === initialCameraId);
      if (cam && cam.id !== selectedCam?.id) {
        setSelectedCam(cam);
      }
    }
  }, [initialCameraId, cameras]);

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

  // Fetch recordings and events when camera changes
  useEffect(() => {
    if (!selectedCam) return;
    setLoading(true);
    setVideoError('');
    edgeJobsRef.current = new Map();
    let isMounted = true;

    const loadData = async () => {
      try {
        const [recRes, eventRes] = await Promise.all([
          fetch(apiUrl(`/recordings-list?camera_id=${selectedCam.id}`)),
          fetch(apiUrl(`/events?camera_id=${selectedCam.id}&limit=2000`))
        ]);

        let recs: RecordingFile[] = [];
        if (recRes.ok) {
          const raw = await recRes.json();
          recs = raw.map((r: any) => {
            let start = 0;
            if (r.timestamp) {
              const d = new Date(r.timestamp);
              start = !isNaN(d.getTime()) ? d.getTime() : 0;
            } else if (r.created_at) {
              const d = new Date(r.created_at);
              start = !isNaN(d.getTime()) ? d.getTime() : 0;
            }
            const dur = typeof r.duration_seconds === 'number' ? r.duration_seconds : 60;
            const end = start + dur * 1000;
            return {
              ...r,
              startTimestamp: start,
              endTimestamp: end,
              segmentMs: dur * 1000,
            };
          }).filter((r: RecordingFile) => r.startTimestamp > 0);
          recs.sort((a, b) => a.startTimestamp - b.startTimestamp);
        }

        let evs: CameraEvent[] = [];
        if (eventRes.ok) {
          const rawEvents = await eventRes.json();
          evs = rawEvents.map((e: any) => ({
            ...e,
            timestampMs: new Date(e.timestamp).getTime()
          })).sort((a: CameraEvent, b: CameraEvent) => b.timestampMs - a.timestampMs);
        }

        if (!isMounted) return;
        setRecordings(recs);
        recordingsRef.current = recs;
        setEvents(evs);

        // Auto play target time or latest recording
        const targetMs = initialTime ? new Date(initialTime).getTime() : Date.now();
        const hit = resolvePlaybackTarget(recs, targetMs, true);
        if (hit) {
          openResolved(recs, hit.url, hit.seekMs);
        } else if (recs.length > 0) {
          const latest = recs[recs.length - 1];
          openClip(latest, 0);
        } else {
          // Check edge
          const day = new Date(targetMs);
          const dayMs = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
          const merged = await ensureEdge(selectedCam.id, [dayMs], recs);
          if (isMounted) {
            setRecordings(merged);
            recordingsRef.current = merged;
            const edgeHit = resolvePlaybackTarget(merged, targetMs, true);
            if (edgeHit) {
              openResolved(merged, edgeHit.url, edgeHit.seekMs);
            } else {
              setVideoError('No recordings found for this camera.');
            }
          }
        }
      } catch (e) {
        console.error("Playback load failed", e);
        if (isMounted) setVideoError('Failed to load recording index.');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    loadData();
    return () => { isMounted = false; };
  }, [selectedCam]);

  const openResolved = (clips: RecordingFile[], url: string, seekMs: number) => {
    const file = clips.find(c => c.url === url);
    if (!file) return;
    const offset = Math.max(0, (seekMs - file.startTimestamp) / 1000);
    openClip(file, offset);
  };

  const openClip = (file: RecordingFile, offsetSec: number) => {
    const offset = Math.max(0, offsetSec);
    const video = videoRef.current;
    if (file.edge) {
      timeBaseRef.current = offset;
      pendingSeek.current = null;
    } else {
      timeBaseRef.current = 0;
      pendingSeek.current = offset;
    }
    setCurrentTimeMs(file.startTimestamp + offset * 1000);
    setVideoError('');
    setBuffering(true);
    setIsPlaying(true);
    setActiveFile(file);
    setClipOffset(offset);

    if (video && !file.edge && activeFile?.url === file.url) {
      if (Number.isFinite(video.duration) && video.duration > 1) {
        video.currentTime = Math.min(offset, Math.max(0, video.duration - 0.25));
      }
    }
  };

  const seekToTime = async (targetTimeMs: number) => {
    const gen = ++seekGen.current;
    let clips = recordingsRef.current;
    let resolved = resolvePlaybackTarget(clips, targetTimeMs, true);

    if (!resolved && selectedCam) {
      const day = new Date(targetTimeMs);
      const dayMs = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      clips = await ensureEdge(selectedCam.id, [dayMs], clips);
      if (gen !== seekGen.current) return;
      recordingsRef.current = clips;
      setRecordings(clips);
      resolved = resolvePlaybackTarget(clips, targetTimeMs, true);
    }

    if (resolved) {
      openResolved(clips, resolved.url, resolved.seekMs);
    } else {
      setCurrentTimeMs(targetTimeMs);
      setVideoError('No recording segment found near this time.');
    }
  };

  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const handleRewind15 = () => {
    if (!videoRef.current || !activeFile) return;
    const current = videoRef.current.currentTime;
    const target = Math.max(0, current - 15);
    videoRef.current.currentTime = target;
  };

  const handleForward15 = () => {
    if (!videoRef.current || !activeFile) return;
    const current = videoRef.current.currentTime;
    const dur = videoRef.current.duration || 60;
    const target = Math.min(dur - 0.5, current + 15);
    videoRef.current.currentTime = target;
  };

  const handleCycleSpeed = () => {
    const nextIdx = (speedIndex + 1) % speeds.length;
    setSpeedIndex(nextIdx);
    if (videoRef.current) {
      videoRef.current.playbackRate = speeds[nextIdx];
    }
  };

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
      if (e.key === 'Escape' && isTheaterFullscreen) {
        setIsTheaterFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      unsub();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTheaterFullscreen]);

  const handleFullscreen = async () => {
    if (isNativeFullscreenActive() || isTheaterFullscreen) {
      if (isNativeFullscreenActive()) {
        await exitNativeFullscreen();
      }
      setIsTheaterFullscreen(false);
      return;
    }

    const el = containerRef.current;
    const video = videoRef.current;

    const ok = await requestNativeFullscreen(el, video);
    if (!ok) {
      setIsTheaterFullscreen(true);
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !activeFile) return;
    const currentMs = activeFile.startTimestamp + (timeBaseRef.current + video.currentTime) * 1000;
    setCurrentTimeMs(currentMs);
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speeds[speedIndex];
    if (pendingSeek.current !== null && !activeFile?.edge) {
      const decision = resolveLoadedSeek(pendingSeek.current, video.duration);
      timeBaseRef.current = decision.timeBaseSec;
      if (decision.mediaSeekSec !== null) {
        video.currentTime = decision.mediaSeekSec;
      }
      pendingSeek.current = null;
    }
    if (isPlaying) {
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
    }
  };

  const handleEnded = () => {
    if (!activeFile) return;
    const idx = recordings.findIndex(r => r.url === activeFile.url);
    if (idx !== -1 && idx < recordings.length - 1) {
      openClip(recordings[idx + 1], 0);
    } else {
      setIsPlaying(false);
    }
  };

  const withStart = (url: string, offsetSec: number) => {
    if (activeFile?.edge) {
      const startMs = activeFile.startTimestamp + Math.max(0, offsetSec) * 1000;
      const track = activeFile.track || '101';
      return apiUrl(
        `/recordings/${encodeURIComponent(activeFile.camera_id)}/edge?start=${encodeURIComponent(new Date(startMs).toISOString())}&end=${encodeURIComponent(new Date(activeFile.endTimestamp).toISOString())}&track=${encodeURIComponent(track)}`,
      );
    }
    const base = apiUrl(url);
    const joiner = base.includes('?') ? '&' : '?';
    return `${base}${joiner}t=${offsetSec.toFixed(3)}`;
  };

  // Filter events for the selected camera and selected date
  const filteredEvents = React.useMemo(() => {
    return events.filter(e => {
      if (!e.timestamp) return false;
      const eventDate = inputDate(new Date(e.timestampMs));
      if (eventDate !== selectedDate) return false;

      if (activeFilter === 'all') return true;
      const cls = (e.object_class || '').toLowerCase();
      if (activeFilter === 'person') return cls === 'person';
      if (activeFilter === 'vehicle') return ['car', 'truck', 'bus', 'vehicle', 'motorcycle'].includes(cls);
      if (activeFilter === 'motion') return cls === 'motion';
      return true;
    });
  }, [events, selectedDate, activeFilter]);

  const formatHMS = (ms: number) => {
    if (!ms) return '--:--:--';
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const currentDuration = videoRef.current?.duration || (activeFile ? (activeFile.endTimestamp - activeFile.startTimestamp) / 1000 : 60);
  const currentOffset = videoRef.current?.currentTime || 0;

  const handleDownloadDirect = (url: string, filename?: string) => {
    const hasQuery = url.includes('?');
    const downloadParam = hasQuery ? `${url}&download=1` : `${url}?download=1`;
    const fullUrl = apiUrl(downloadParam);
    const link = document.createElement('a');
    link.href = fullUrl;
    link.download = filename || 'recording.mp4';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportEvidence = async () => {
    if (!selectedCam) return;
    setExportLoading(true);
    setExportError('');
    setExportResult(null);

    try {
      let targetCenter = currentTimeMs || Date.now();
      if (activeFile && targetCenter < activeFile.startTimestamp) {
        targetCenter = activeFile.startTimestamp;
      }
      const windowHalfMs = (exportMinutesPreset * 60 * 1000) / 2;
      const startMs = targetCenter - windowHalfMs;
      const endMs = targetCenter + windowHalfMs;

      const res = await fetch(apiUrl('/recordings-list/export'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_id: selectedCam.id,
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString(),
          reason: exportReason.trim() || 'Mobile incident review'
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to generate video package');
      }

      const data = await res.json();
      setExportResult(data);

      if (data.download_url) {
        handleDownloadDirect(data.download_url, data.filename);
      }
    } catch (e: any) {
      setExportError(e.message || 'Export failed. Check camera recording coverage.');
    } finally {
      setExportLoading(false);
    }
  };

  return (
    <div>
      {/* ── 1. Camera Selector Chips ── */}
      <div className="mobile-camera-chips">
        {cameras.map(cam => (
          <button
            key={cam.id}
            className={`mobile-chip ${selectedCam?.id === cam.id ? 'active' : ''}`}
            onClick={() => setSelectedCam(cam)}
          >
            <span className={`mobile-dot ${cam.status !== 'offline' ? 'online' : ''}`} />
            {cam.name}
          </button>
        ))}
      </div>

      {/* ── 2. Video Player Card ── */}
      <div className={`mobile-player-card${isTheaterFullscreen ? ' theater-fullscreen' : ''}`} ref={containerRef}>
        {isTheaterFullscreen && (
          <button className="mobile-theater-exit-btn" onClick={handleFullscreen} title="Exit Fullscreen">
            <Minimize size={14} /> Exit Fullscreen
          </button>
        )}
        <div className="mobile-player-container" onClick={handlePlayPause}>
          {/* Top HUD: Camera Name and Live Playback Clock */}
          <div className="mobile-player-hud-top">
            <span className="mobile-hud-badge">
              {selectedCam?.name || 'Camera'}
            </span>
            <span className="mobile-hud-badge" style={{ color: 'var(--mobile-accent)' }}>
              {formatHMS(currentTimeMs)}
            </span>
          </div>

          {activeFile ? (
            <video
              ref={videoRef}
              key={`${activeFile.url}@${clipOffset.toFixed(2)}`}
              src={withStart(activeFile.url, clipOffset)}
              playsInline
              autoPlay
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onWaiting={() => setBuffering(true)}
              onPlaying={() => {
                setBuffering(false);
                setIsPlaying(true);
                setVideoError('');
              }}
              onEnded={handleEnded}
              onError={() => setVideoError('Video decode error or missing segment.')}
              className="mobile-player-video"
            />
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--mobile-text-muted)', padding: 20 }}>
              <Film size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
              <div style={{ fontSize: '0.8rem' }}>
                {loading ? 'Searching recordings...' : 'No recording selected'}
              </div>
            </div>
          )}

          {/* Buffering or Error Display */}
          {(buffering || videoError) && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: 'rgba(0,0,0,0.8)',
              border: `1px solid ${videoError ? 'var(--mobile-danger)' : 'rgba(0,210,255,0.4)'}`,
              color: videoError ? 'var(--mobile-danger)' : '#fff',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: '0.75rem',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              zIndex: 25,
            }}>
              {buffering && !videoError && <div className="spinner" style={{ width: 14, height: 14 }} />}
              <span>{videoError || 'Buffering segment...'}</span>
            </div>
          )}

          {/* Center Play Button Overlay when paused */}
          {!isPlaying && activeFile && !buffering && (
            <div className="mobile-player-center-overlay">
              <div className="mobile-play-btn-large">
                <Play size={24} fill="#fff" style={{ marginLeft: 3 }} />
              </div>
            </div>
          )}
        </div>

        {/* Video Scrubber Slider */}
        <div style={{ padding: '0 12px', background: 'var(--mobile-surface)' }}>
          <input
            type="range"
            min={0}
            max={Math.max(1, currentDuration)}
            step={0.5}
            value={currentOffset}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              if (videoRef.current) {
                videoRef.current.currentTime = val;
              }
            }}
            className="mobile-slider-track"
          />
        </div>

        {/* Video Controls Toolbar */}
        <div className="mobile-player-controls-bar">
          <div className="mobile-ctrl-group">
            <button className="mobile-ctrl-btn" onClick={handleRewind15} title="Back 15s">
              <RotateCcw size={15} /> -15s
            </button>
            <button className="mobile-ctrl-btn" onClick={handlePlayPause}>
              {isPlaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button className="mobile-ctrl-btn" onClick={handleForward15} title="Forward 15s">
              +15s <RotateCw size={15} />
            </button>
          </div>

          <div className="mobile-ctrl-group">
            <button
              className="mobile-ctrl-btn"
              onClick={() => {
                setShowExportModal(true);
                setExportError('');
                setExportResult(null);
              }}
              style={{ color: 'var(--mobile-accent)', borderColor: 'rgba(0, 210, 255, 0.3)' }}
              title="Export Video Recording"
            >
              <Download size={14} /> Export
            </button>
            <button className="mobile-ctrl-btn" onClick={handleCycleSpeed}>
              {speeds[speedIndex]}x
            </button>
            <button className="mobile-ctrl-btn" onClick={handleFullscreen} title={isTheaterFullscreen || isNativeFullscreen ? "Exit Fullscreen" : "Fullscreen"}>
              {isTheaterFullscreen || isNativeFullscreen ? <Minimize size={15} color="var(--mobile-accent)" /> : <Maximize size={15} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── 3. Date & Jump Controls ── */}
      <div className="mobile-scrubber-card">
        <div className="mobile-date-row">
          <div className="mobile-date-chips">
            <button
              className={`mobile-date-chip ${selectedDate === inputDate(new Date()) ? 'active' : ''}`}
              onClick={() => {
                const today = inputDate(new Date());
                setSelectedDate(today);
                seekToTime(Date.now());
              }}
            >
              Today
            </button>
            <button
              className={`mobile-date-chip ${selectedDate === inputDate(new Date(Date.now() - 86400000)) ? 'active' : ''}`}
              onClick={() => {
                const yest = inputDate(new Date(Date.now() - 86400000));
                setSelectedDate(yest);
                seekToTime(Date.now() - 86400000);
              }}
            >
              Yesterday
            </button>
          </div>

          <input
            type="date"
            value={selectedDate}
            onChange={(e) => {
              if (e.target.value) {
                setSelectedDate(e.target.value);
                const target = new Date(`${e.target.value}T12:00:00`).getTime();
                seekToTime(target);
              }
            }}
            className="mobile-input-date"
          />
        </div>

        {/* Event Classification Filters */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {(['all', 'person', 'vehicle', 'motion'] as const).map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              style={{
                padding: '4px 10px',
                borderRadius: 14,
                fontSize: '0.72rem',
                border: '1px solid var(--mobile-border)',
                background: activeFilter === f ? 'rgba(0, 210, 255, 0.15)' : 'var(--mobile-bg)',
                color: activeFilter === f ? 'var(--mobile-accent)' : 'var(--mobile-text-muted)',
                fontWeight: activeFilter === f ? 600 : 400,
                cursor: 'pointer',
                textTransform: 'capitalize'
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* ── 4. Quick-Seek Events Feed ── */}
      <div className="mobile-events-section-title">
        <h3>
          <Shield size={15} color="var(--mobile-accent)" />
          Events on {selectedDate} ({filteredEvents.length})
        </h3>
        <span style={{ fontSize: '0.7rem', color: 'var(--mobile-text-muted)' }}>
          Tap to jump video
        </span>
      </div>

      {filteredEvents.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '24px 12px',
          background: 'var(--mobile-surface)',
          borderRadius: 10,
          border: '1px solid var(--mobile-border)',
          color: 'var(--mobile-text-muted)',
          fontSize: '0.78rem'
        }}>
          No {activeFilter === 'all' ? '' : activeFilter} events recorded on {selectedDate}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filteredEvents.slice(0, 50).map(evt => {
            const cls = (evt.object_class || 'motion').toLowerCase();
            const badgeClass = cls === 'person' 
              ? 'mobile-badge-person' 
              : ['car', 'vehicle', 'truck'].includes(cls) 
              ? 'mobile-badge-vehicle' 
              : 'mobile-badge-motion';

            return (
              <div
                key={evt.id}
                className="mobile-event-card"
                onClick={() => seekToTime(evt.timestampMs)}
              >
                <div className="mobile-event-info">
                  <div className="mobile-event-label">
                    <span className={badgeClass}>{evt.object_class}</span>
                    {evt.confidence > 0 && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--mobile-text-dim)' }}>
                        {(evt.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  <span className="mobile-event-time">
                    {formatHMS(evt.timestampMs)}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--mobile-accent)', fontSize: '0.75rem', fontWeight: 600 }}>
                  <Play size={14} fill="var(--mobile-accent)" /> Play
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 5. Video File Export Modal ── */}
      {showExportModal && (
        <div className="mobile-modal-overlay" onClick={() => setShowExportModal(false)}>
          <div className="mobile-modal-card" onClick={e => e.stopPropagation()}>
            <div className="mobile-modal-header">
              <div className="mobile-modal-title">
                <Download size={18} color="var(--mobile-accent)" />
                Export Video Footage
              </div>
              <button
                onClick={() => setShowExportModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--mobile-text-muted)', cursor: 'pointer', padding: 4 }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Target Camera & Time Info Pill */}
            <div style={{
              background: 'var(--mobile-bg)',
              border: '1px solid var(--mobile-border)',
              borderRadius: 8,
              padding: '8px 12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.74rem',
              marginBottom: 14
            }}>
              <div>
                <span style={{ color: 'var(--mobile-text-muted)' }}>Camera: </span>
                <span style={{ color: 'var(--mobile-text)', fontWeight: 600 }}>{selectedCam?.name}</span>
              </div>
              <div>
                <span style={{ color: 'var(--mobile-text-muted)' }}>Position: </span>
                <span style={{ color: 'var(--mobile-accent)', fontFamily: 'monospace', fontWeight: 600 }}>{formatHMS(currentTimeMs)}</span>
              </div>
            </div>

            {/* Export Mode Tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button
                className={`mobile-export-tab-btn ${exportMode === 'custom' ? 'active' : ''}`}
                onClick={() => setExportMode('custom')}
              >
                Incident Range Clip
              </button>
              <button
                className={`mobile-export-tab-btn ${exportMode === 'segment' ? 'active' : ''}`}
                onClick={() => setExportMode('segment')}
              >
                Current Segment (.mp4)
              </button>
            </div>

            {exportMode === 'segment' ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--mobile-text)', marginBottom: 8, lineHeight: 1.4 }}>
                  Directly download the current 60-second raw recording file without re-encoding.
                </div>
                {activeFile ? (
                  <div style={{ background: 'var(--mobile-bg)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--mobile-border)', fontSize: '0.72rem', color: 'var(--mobile-text-muted)', marginBottom: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, color: 'var(--mobile-text)', fontWeight: 600 }}>
                      <FileVideo size={15} color="var(--mobile-accent)" />
                      {activeFile.filename || 'active_segment.mp4'}
                    </div>
                    <div>Recorded: {new Date(activeFile.startTimestamp).toLocaleTimeString()} &ndash; {new Date(activeFile.endTimestamp).toLocaleTimeString()}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.75rem', color: 'var(--mobile-warning)', marginBottom: 12 }}>
                    No active recording segment loaded. Scrub to a valid segment first.
                  </div>
                )}
                <button
                  className="mobile-btn-primary"
                  disabled={!activeFile}
                  onClick={() => {
                    if (activeFile) {
                      handleDownloadDirect(activeFile.url, activeFile.filename);
                      setShowExportModal(false);
                    }
                  }}
                >
                  <Download size={16} /> Download Active Segment
                </button>
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 14 }}>
                  <label className="mobile-form-label">Clip Window Presets</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {[1, 3, 5, 10].map(mins => (
                      <button
                        key={mins}
                        onClick={() => setExportMinutesPreset(mins)}
                        style={{
                          flex: 1,
                          padding: '7px 4px',
                          borderRadius: 8,
                          fontSize: '0.72rem',
                          background: exportMinutesPreset === mins ? 'rgba(0, 210, 255, 0.15)' : 'var(--mobile-bg)',
                          border: `1px solid ${exportMinutesPreset === mins ? 'var(--mobile-accent)' : 'var(--mobile-border)'}`,
                          color: exportMinutesPreset === mins ? 'var(--mobile-accent)' : 'var(--mobile-text-muted)',
                          fontWeight: exportMinutesPreset === mins ? 600 : 400,
                          cursor: 'pointer'
                        }}
                      >
                        &plusmn;{mins} min
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label className="mobile-form-label">Reason / Incident Note</label>
                  <input
                    type="text"
                    value={exportReason}
                    onChange={e => setExportReason(e.target.value)}
                    placeholder="e.g. Vehicle entry review"
                    className="mobile-form-input"
                  />
                </div>

                {exportError && (
                  <div style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'rgba(255, 71, 87, 0.12)',
                    border: '1px solid rgba(255, 71, 87, 0.3)',
                    color: 'var(--mobile-danger)',
                    fontSize: '0.75rem',
                    marginBottom: 12
                  }}>
                    {exportError}
                  </div>
                )}

                {exportResult && (
                  <div style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'rgba(46, 213, 115, 0.12)',
                    border: '1px solid rgba(46, 213, 115, 0.3)',
                    color: 'var(--mobile-success)',
                    fontSize: '0.75rem',
                    marginBottom: 12
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 4 }}>
                      <CheckCircle size={15} /> Video Package Ready!
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)' }}>
                      File: {exportResult.filename} ({exportResult.file_size_bytes ? `${(exportResult.file_size_bytes / (1024 * 1024)).toFixed(1)} MB` : 'MP4'})
                    </div>
                  </div>
                )}

                <button
                  className="mobile-btn-primary"
                  disabled={exportLoading}
                  onClick={handleExportEvidence}
                >
                  {exportLoading ? (
                    <>
                      <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                      Synthesizing Video Package...
                    </>
                  ) : (
                    <>
                      <Download size={16} />
                      Export &amp; Download MP4 Package
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
