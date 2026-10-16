import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { 
  Play, Pause, RotateCcw, RotateCw, SkipBack, SkipForward, 
  Search, Video, Download, Maximize2 
} from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

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
  startTimestamp: number;
  endTimestamp: number;
}

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
  const dragStartRef = useRef<{ x: number; start: number; end: number } | null>(null);
  const hasDraggedRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingSeek = useRef<number | null>(null);

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

  // ── 2. Load recordings and events for selected camera ──────────────
  useEffect(() => {
    if (!selectedCam) return;
    let isMounted = true;

    const loadData = async () => {
      try {
        const [recRes, eventRes] = await Promise.all([
          fetch(apiUrl(`/recordings-list?camera_id=${selectedCam.id}`)),
          fetch(apiUrl(`/events?camera_id=${selectedCam.id}&limit=5000`))
        ]);

        let recs: RecordingFile[] = [];
        if (recRes.ok) {
          const rawRecs = await recRes.json();
          recs = rawRecs.map((r: any) => {
            const match = r.filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
            let start = 0;
            if (match) {
              const [_, y, m, d, hr, min, sec] = match;
              start = new Date(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(hr), parseInt(min), parseInt(sec)).getTime();
            } else {
              start = new Date(r.created_at).getTime();
            }
            return {
              ...r,
              startTimestamp: start,
              endTimestamp: start + 60000
            };
          });

          // Sort by startTimestamp ascending
          recs.sort((a, b) => a.startTimestamp - b.startTimestamp);

          // Calculate gapless/accurate endTimestamp to display continuous footage
          for (let i = 0; i < recs.length; i++) {
            const start = recs[i].startTimestamp;
            let end = start + 60000;
            if (i < recs.length - 1) {
              const nextStart = recs[i + 1].startTimestamp;
              const gap = nextStart - start;
              if (gap > 0 && gap <= 120000) {
                end = nextStart;
              }
            }
            recs[i].endTimestamp = end;
          }
          if (isMounted) setRecordings(recs);
        }

        let evs: CameraEvent[] = [];
        if (eventRes.ok) {
          const rawEvents = await eventRes.json();
          evs = rawEvents.map((e: any) => ({
            ...e,
            timestampMs: new Date(e.timestamp).getTime()
          }));
          if (isMounted) setEvents(evs);
        }

        // Initialize timeline and active file
        if (isMounted && recs.length > 0) {
          let targetTime = 0;
          let targetFile = recs[recs.length - 1];

          if (initTimeParam) {
            const t = new Date(initTimeParam).getTime();
            if (!isNaN(t)) {
              targetTime = t;
              // Find the file containing this time
              const f = recs.find(r => targetTime >= r.startTimestamp && targetTime < r.endTimestamp);
              if (f) targetFile = f;
            }
          }

          if (!targetTime) {
            targetTime = targetFile.startTimestamp;
          }

          setActiveFile(targetFile);
          setCurrentTimeMs(targetTime);
        } else {
          setActiveFile(null);
          setRecordings([]);
        }
      } catch (err) {
        console.error('Failed to load recordings', err);
      }
      setLoading(false);
    };

    loadData();
    setIsPlaying(true);
  }, [selectedCam]);

  // ── 3. Handle playback logic and seeks ─────────────────────────────
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speeds[speedIndex];
    }
  }, [speedIndex, activeFile]);

  const seekToTime = (targetTimeMs: number, findNearest: boolean = false) => {
    if (recordings.length === 0) return false;

    // 1. Try to find the exact segment
    let file = recordings.find(r => targetTimeMs >= r.startTimestamp && targetTimeMs <= r.endTimestamp);
    let seekTargetMs = targetTimeMs;

    // 2. Fallback to nearest segment if findNearest is true
    if (!file && findNearest) {
      let minDiff = Infinity;
      let closestFile = null;

      for (const r of recordings) {
        const diffStart = Math.abs(r.startTimestamp - targetTimeMs);
        const diffEnd = Math.abs(r.endTimestamp - targetTimeMs);
        const minLocalDiff = Math.min(diffStart, diffEnd);

        if (minLocalDiff < minDiff) {
          minDiff = minLocalDiff;
          closestFile = r;
        }
      }

      if (closestFile) {
        file = closestFile;
        if (targetTimeMs < closestFile.startTimestamp) {
          seekTargetMs = closestFile.startTimestamp;
        } else {
          seekTargetMs = closestFile.endTimestamp - 500; // 0.5s before end
        }
      }
    }

    if (file) {
      const offsetSeconds = (seekTargetMs - file.startTimestamp) / 1000;
      setActiveFile(file);
      setCurrentTimeMs(seekTargetMs);
      setVideoError('');
      setBuffering(true);

      // Auto-center timeline if target is off-screen
      if (seekTargetMs < timelineStart || seekTargetMs > timelineEnd) {
        const span = timelineEnd - timelineStart;
        setTimelineStart(seekTargetMs - span / 2);
        setTimelineEnd(seekTargetMs + span / 2);
      }

      if (videoRef.current) {
        if (videoRef.current.src.includes(file.url)) {
          const duration = videoRef.current.duration;
          if (!isNaN(duration) && duration > 0) {
            const clampSeek = Math.min(offsetSeconds, duration > 0.5 ? duration - 0.5 : 0);
            videoRef.current.currentTime = Math.max(0, clampSeek);
          } else {
            videoRef.current.currentTime = offsetSeconds;
          }
          videoRef.current.play().catch(() => {});
          setIsPlaying(true);
        } else {
          pendingSeek.current = offsetSeconds;
          setIsPlaying(true);
        }
      }
      return true;
    } else {
      setCurrentTimeMs(targetTimeMs);
      setVideoError('No recording segment covers the selected date and time.');
      return false;
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current || !activeFile) return;
    const currentVideoTime = videoRef.current.currentTime;
    const updatedTimeMs = activeFile.startTimestamp + currentVideoTime * 1000;
    setCurrentTimeMs(updatedTimeMs);

    // Slide timeline forward if playhead is near the end
    if (updatedTimeMs > timelineEnd - 30 * 1000) {
      const span = timelineEnd - timelineStart;
      setTimelineStart(updatedTimeMs - span * 0.1);
      setTimelineEnd(updatedTimeMs + span * 0.9);
    }
    // Slide timeline backward if playhead is near or before the start
    else if (updatedTimeMs < timelineStart + 30 * 1000) {
      const span = timelineEnd - timelineStart;
      setTimelineStart(updatedTimeMs - span * 0.9);
      setTimelineEnd(updatedTimeMs + span * 0.1);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speeds[speedIndex];
    }
    if (pendingSeek.current !== null && videoRef.current) {
      const duration = videoRef.current.duration;
      const clampSeek = Math.min(pendingSeek.current, duration > 0.5 ? duration - 0.5 : 0);
      videoRef.current.currentTime = Math.max(0, clampSeek);
      pendingSeek.current = null;
    }
    if (isPlaying && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  };

  const handleVideoEnded = () => {
    if (!activeFile) return;
    const currentIndex = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIndex !== -1 && currentIndex < recordings.length - 1) {
      const nextFile = recordings[currentIndex + 1];
      setActiveFile(nextFile);
      setCurrentTimeMs(nextFile.startTimestamp);
      pendingSeek.current = 0;
    } else {
      setIsPlaying(false);
    }
  };

  const handleRecordingError = () => {
    setBuffering(false);
    if (activeFile) {
      const currentIndex = recordings.findIndex(r => r.url === activeFile.url);
      if (currentIndex > 0) {
        const previousFile = recordings[currentIndex - 1];
        setActiveFile(previousFile);
        setCurrentTimeMs(previousFile.startTimestamp);
        pendingSeek.current = 0;
        setVideoError('Skipped an unfinished recording segment.');
        return;
      }
    }
    setVideoError('Failed to load recording file. The segment may still be finalizing.');
  };

  // ── 4. Transport Control Handlers ──────────────────────────────────
  useEffect(() => {
    if (!buffering || !activeFile) return;
    const timer = window.setTimeout(() => {
      if (videoRef.current && videoRef.current.readyState < 2) {
        handleRecordingError();
      }
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [buffering, activeFile?.url]);

  const handlePlayPause = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    } else {
      videoRef.current.pause();
    }
  };

  const handleRewind30 = () => {
    if (!videoRef.current || !activeFile) return;
    const targetTime = videoRef.current.currentTime - 30;
    if (targetTime >= 0) {
      videoRef.current.currentTime = targetTime;
    } else {
      const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
      if (currentIdx > 0) {
        const prevFile = recordings[currentIdx - 1];
        setActiveFile(prevFile);
        pendingSeek.current = 3600 + targetTime; 
      } else {
        videoRef.current.currentTime = 0;
      }
    }
  };

  const handleForward30 = () => {
    if (!videoRef.current || !activeFile) return;
    const targetTime = videoRef.current.currentTime + 30;
    if (targetTime < videoRef.current.duration) {
      videoRef.current.currentTime = targetTime;
    } else {
      const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
      if (currentIdx !== -1 && currentIdx < recordings.length - 1) {
        const nextFile = recordings[currentIdx + 1];
        const rolloverSecs = targetTime - videoRef.current.duration;
        setActiveFile(nextFile);
        pendingSeek.current = rolloverSecs;
      }
    }
  };

  const handlePrevSegment = () => {
    if (!activeFile) return;
    const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIdx > 0) {
      const prevFile = recordings[currentIdx - 1];
      setActiveFile(prevFile);
      setCurrentTimeMs(prevFile.startTimestamp);
      pendingSeek.current = 0;
    }
  };

  const handleNextSegment = () => {
    if (!activeFile) return;
    const currentIdx = recordings.findIndex(r => r.url === activeFile.url);
    if (currentIdx !== -1 && currentIdx < recordings.length - 1) {
      const nextFile = recordings[currentIdx + 1];
      setActiveFile(nextFile);
      setCurrentTimeMs(nextFile.startTimestamp);
      pendingSeek.current = 0;
    }
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
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85;
    const rect = timelineRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseRatio = mouseX / rect.width;
    const currentSpan = timelineEnd - timelineStart;
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

  const recordingSrc = (url: string) => {
    const token = localStorage.getItem('mview_token');
    const separator = url.includes('?') ? '&' : '?';
    return apiUrl(token ? `${url}${separator}token=${encodeURIComponent(token)}` : url);
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
                  <span style={{ width: 8, height: 8, background: 'var(--red)', borderRadius: '50%', boxShadow: '0 0 8px var(--red)', display: 'inline-block' }} />
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right Content Area ── */}
      <div className="playback-main">
        {/* Video Player */}
        <div className="playback-video-container">
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
                key={activeFile.url}
                src={recordingSrc(activeFile.url)}
                autoPlay
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={handleVideoEnded}
                onWaiting={() => setBuffering(true)}
                onPlaying={() => { setBuffering(false); setIsPlaying(true); }}
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
                
                <span style={{ fontSize: '0.8rem', color: '#fff', marginRight: 'auto', marginLeft: 12, fontWeight: 500 }}>
                  Main Video Player
                </span>

                <div className="playback-pills">
                  <div className="playback-pill">Time</div>
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
                          alert(`Export Failed: ${err.detail || 'Unable to generate incident package'}`);
                          return;
                        }
                        const data = await res.json();
                        
                        // Automatically trigger browser file download
                        const downloadLink = document.createElement('a');
                        downloadLink.href = recordingSrc(data.download_url);
                        downloadLink.download = data.filename;
                        document.body.appendChild(downloadLink);
                        downloadLink.click();
                        document.body.removeChild(downloadLink);

                        alert(`Incident Evidence Package Ready!\n\nPackage ID: ${data.export_id}\nSHA-256 Verification: ${data.sha256_hash}\nFile: ${data.filename}`);
                      } catch (error) {
                        alert(`Export Network Error: ${error instanceof Error ? error.message : 'Request failed'}`);
                      }
                    }}
                  >
                    <Download size={12} /> Export Package
                  </button>


                  <button 
                    style={{ background: 'transparent', border: 'none', color: 'var(--t2)', cursor: 'pointer', padding: 4 }}
                    onClick={() => videoRef.current?.requestFullscreen()}
                  >
                    <Maximize2 size={16} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--t3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <Video size={48} strokeWidth={1} />
              <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--t2)' }}>No recordings available</div>
              <div style={{ fontSize: '0.8rem' }}>Choose another camera or ensure recording is active.</div>
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
                  key={i}
                  className={`timeline-event-pill ${evClass}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                >
                  {/* Small tag indicator inside viewport on hover */}
                  <div className="timeline-event-tag">
                    {ev.object_class} ({formatTimeHMS(ev.timestampMs)})
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
    </div>
  );
};

export default Playback;
