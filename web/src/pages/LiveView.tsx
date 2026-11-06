import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Activity,
  Camera as CamIcon,
  ExternalLink,
  Focus,
  Maximize2,
  Minimize2,
  WifiOff,
  Volume2,
  VolumeX,
  Crosshair,
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  Trash2,
  Plus,
  Check,
  Layers,
  Sliders,
  Sparkles,
  Save,
  Shield,
  Info,
} from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiUrl } from '../lib/endpoints';
import { requestNativeFullscreen, exitNativeFullscreen, isNativeFullscreenActive } from '../lib/fullscreen';
import { resolvePlaybackTarget } from '../lib/playbackSeek';
import PTZControls from '../components/PTZControls';
import LivePlayer, { LiveMode } from '../components/LivePlayer';

interface Camera {
  id: string;
  name: string;
  rtsp_url_main?: string;
  rtsp_url_sub?: string;
  status: string;
  resolution?: string;
  location?: string;
  has_motion?: boolean;
  onvif_endpoint?: string;
  config?: any;
}

interface CameraEvent {
  id?: string;
  camera_id?: string;
  object_class?: string;
  confidence?: number;
  timestamp?: string;
  created_at?: string;
}

interface RecordingFile {
  camera_id: string;
  filename: string;
  url: string;
  created_at: string;
  startTimestamp: number;
  endTimestamp: number;
}

type ViewMode = 'live' | 'playback' | 'analytics';

interface ZonePoint {
  x: number;
  y: number;
}

export interface AnalyticsZone {
  id: string;
  name: string;
  type: 'motion' | 'intrusion' | 'tripwire' | 'privacy';
  x: number; // 0..100
  y: number; // 0..100
  w: number; // 5..100
  h: number; // 5..100
  min_confidence: number; // 0..1
  enabled: boolean;
  notify: boolean;
  cooldown_seconds: number;
  objects: string[];
}

const parseRecording = (r: any): RecordingFile => {
  let start = 0;
  if (r.created_at) {
    const dt = new Date(r.created_at).getTime();
    if (!isNaN(dt)) start = dt;
  }
  if (!start) {
    const match = r.filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (match) {
      const [, y, m, d, hr, min, sec] = match;
      start = Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(hr), parseInt(min), parseInt(sec));
    }
  }
  const durSec = typeof r.duration_seconds === 'number' && r.duration_seconds > 0 ? r.duration_seconds : 60;
  return {
    camera_id: r.camera_id || '',
    filename: r.filename || '',
    url: r.url || '',
    created_at: r.created_at || '',
    startTimestamp: start,
    endTimestamp: start + durSec * 1000,
  };
};

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

const pointsToBox = (points: ZonePoint[]) => {
  if (!points || points.length === 0) return { x: 15, y: 15, w: 30, h: 30 };
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: Math.max(0, Math.min(95, Math.round(minX * 100))),
    y: Math.max(0, Math.min(95, Math.round(minY * 100))),
    w: Math.max(5, Math.min(100, Math.round((maxX - minX) * 100))),
    h: Math.max(5, Math.min(100, Math.round((maxY - minY) * 100))),
  };
};

const boxToPoints = (x: number, y: number, w: number, h: number): ZonePoint[] => {
  const x1 = Math.max(0, Math.min(1, x / 100));
  const y1 = Math.max(0, Math.min(1, y / 100));
  const x2 = Math.max(0, Math.min(1, (x + w) / 100));
  const y2 = Math.max(0, Math.min(1, (y + h) / 100));
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
};

const cameraToAnalyticsZones = (cam: Camera): AnalyticsZone[] => {
  const rawZones = Array.isArray(cam.config?.zones) ? cam.config.zones : [];
  if (rawZones.length === 0) {
    return [
      {
        id: `zone-default-${cam.id}`,
        name: 'Entry Zone',
        type: 'motion',
        x: 20,
        y: 20,
        w: 45,
        h: 40,
        min_confidence: 0.6,
        enabled: true,
        notify: true,
        cooldown_seconds: 60,
        objects: ['person', 'car'],
      },
    ];
  }
  return rawZones.map((z: any, idx: number) => {
    let box = { x: 15 + (idx % 3) * 10, y: 15 + (idx % 3) * 10, w: 30, h: 30 };
    if (typeof z.x === 'number' && typeof z.w === 'number') {
      box = { x: z.x, y: z.y, w: z.w, h: z.h };
    } else if (Array.isArray(z.points) && z.points.length > 0) {
      box = pointsToBox(z.points);
    }
    return {
      id: z.id || `zone-${cam.id}-${idx}`,
      name: z.name || `Zone ${idx + 1}`,
      type: (z.type as any) || (idx === 1 ? 'intrusion' : 'motion'),
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      min_confidence: typeof z.min_confidence === 'number' ? z.min_confidence : 0.6,
      enabled: z.enabled !== false,
      notify: z.notify !== false,
      cooldown_seconds: z.cooldown_seconds || 60,
      objects: Array.isArray(z.objects) && z.objects.length > 0 ? z.objects : ['person', 'car'],
    };
  });
};

const ZONE_COLORS: Record<string, { border: string; bg: string; label: string }> = {
  motion: { border: '#00d2ff', bg: 'rgba(0, 210, 255, 0.14)', label: 'Motion' },
  intrusion: { border: '#ff4757', bg: 'rgba(255, 71, 87, 0.16)', label: 'Intrusion' },
  tripwire: { border: '#ffa502', bg: 'rgba(255, 165, 2, 0.14)', label: 'Tripwire' },
  privacy: { border: '#9b59b6', bg: 'rgba(20, 24, 33, 0.92)', label: 'Privacy Mask' },
};

const AVAILABLE_OBJECTS = ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'animal'];

const CameraFeedComponent = React.memo<{
  cam: Camera;
  analytics?: boolean;
  maximized?: boolean;
  paused?: boolean;
  onMaximize?: () => void;
}>(({ cam, analytics = false, maximized = false, paused = false, onMaximize }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [liveMode, setLiveMode] = useState<LiveMode>('connecting');
  const [retryKey, setRetryKey] = useState(0);
  const [showPTZ, setShowPTZ] = useState(false);
  const hasStream = Boolean(cam.rtsp_url_main || cam.rtsp_url_sub);
  const quality: 'main' | 'sub' = cam.rtsp_url_sub && !maximized ? 'sub' : 'main';

  const [isMuted, setIsMuted] = useState(true);
  const [isZoomMode, setIsZoomMode] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const panStart = useRef({ x: 0, y: 0 });

  const handleFullscreen = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isNativeFullscreenActive()) {
      await exitNativeFullscreen();
    } else {
      await requestNativeFullscreen(containerRef.current, videoRef.current);
    }
  };

  const handleSnapshot = async () => {
    const video = videoRef.current;
    const stamp = `snapshot_${cam.name.replace(/\s+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    if (video && video.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/jpeg');
        a.download = stamp;
        a.click();
        return;
      }
    }
    try {
      const res = await fetch(apiUrl(`/cameras/${cam.id}/snapshot?t=${Date.now()}`));
      if (!res.ok) return;
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = stamp;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    } catch {
      /* snapshot endpoint unavailable */
    }
  };

  const handleZoomWheel = (e: React.WheelEvent) => {
    if (!isZoomMode) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    setZoomScale(s => Math.min(Math.max(1, s + delta), 8));
  };

  const handleZoomMouseDown = (e: React.MouseEvent) => {
    if (!isZoomMode || zoomScale === 1) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX - zoomOffset.x, y: e.clientY - zoomOffset.y };
  };

  const handleZoomMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    const x = e.clientX - panStart.current.x;
    const y = e.clientY - panStart.current.y;
    setZoomOffset({ x, y });
  };

  const handleZoomMouseUp = () => {
    setIsPanning(false);
  };

  const toggleZoomMode = () => {
    setIsZoomMode(!isZoomMode);
    setZoomScale(1);
    setZoomOffset({ x: 0, y: 0 });
    setIsPanning(false);
  };

  const zoomStyle: React.CSSProperties = {
    transform: isZoomMode ? `scale(${zoomScale}) translate(${zoomOffset.x}px, ${zoomOffset.y}px)` : 'none',
    transformOrigin: 'center center',
    transition: isPanning ? 'none' : 'transform 0.1s ease',
    cursor: isZoomMode ? (isPanning ? 'grabbing' : 'grab') : 'default',
  };

  const activeZones = useMemo(() => {
    if (!analytics) return [];
    return cameraToAnalyticsZones(cam);
  }, [analytics, cam]);

  return (
    <div
      ref={containerRef}
      className={`cam-cell${cam.has_motion || analytics ? ' has-motion' : ''}${maximized ? ' is-maximized' : ''}`}
      onDoubleClick={onMaximize}
      onWheel={handleZoomWheel}
      onMouseDown={handleZoomMouseDown}
      onMouseMove={handleZoomMouseMove}
      onMouseUp={handleZoomMouseUp}
      onMouseLeave={handleZoomMouseUp}
      style={{ overflow: 'hidden', position: 'relative' }}
    >
      {/* SVG Privacy Mask Overlay */}
      {cam.config?.privacy_masks && Array.isArray(cam.config.privacy_masks) && cam.config.privacy_masks.length > 0 && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 8 }}>
          {cam.config.privacy_masks.map((mask: any, idx: number) => (
            <polygon
              key={idx}
              points={mask.points?.map((p: any) => `${p.x * 100},${p.y * 100}`).join(' ')}
              fill="rgba(0, 0, 0, 0.96)"
            />
          ))}
        </svg>
      )}
      <div className="cam-top">
        <div>
          <div className="cam-name">{cam.name}</div>
          {cam.location && <div className="cam-sub">{cam.location}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {cam.status === 'recording' && <div className="cam-rec"><div className="cam-rec-dot" /> REC</div>}
          <button
            className="cam-more"
            title={cam.onvif_endpoint ? 'Toggle PTZ Controls' : 'Toggle Maximize'}
            onClick={() => (cam.onvif_endpoint ? setShowPTZ(v => !v) : onMaximize?.())}
          >
            ...
          </button>
        </div>
      </div>

      {hasStream ? (
        <>
          <LivePlayer
            key={`${cam.id}-${retryKey}`}
            cameraId={cam.id}
            quality={quality}
            muted={isMuted}
            paused={paused}
            videoRef={videoRef}
            onMode={setLiveMode}
            style={zoomStyle}
          />
          {liveMode === 'connecting' && (
            <div className="cam-connecting" style={{ zIndex: 2 }}>
              <div className="spinner" />
              <span style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>Connecting...</span>
            </div>
          )}
          {liveMode === 'unavailable' && (
            <div className="cam-placeholder" style={{ zIndex: 2 }}>
              <WifiOff size={26} strokeWidth={1.5} />
              <span style={{ fontSize: '0.78rem' }}>Camera Stream Unavailable</span>
              <button
                className="btn btn-xs btn-ghost"
                style={{ marginTop: 6, fontSize: '0.72rem', padding: '3px 8px' }}
                onClick={(e) => { e.stopPropagation(); setRetryKey(k => k + 1); }}
              >
                Retry
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="cam-placeholder">
          <WifiOff size={26} strokeWidth={1.5} />
          <span>No Stream URL</span>
        </div>
      )}

      {/* Real Configured Detection Zones Overlay */}
      {analytics && activeZones.map((z, idx) => {
        const theme = ZONE_COLORS[z.type] || ZONE_COLORS.motion;
        return (
          <div
            key={z.id || idx}
            style={{
              position: 'absolute',
              left: `${z.x}%`,
              top: `${z.y}%`,
              width: `${z.w}%`,
              height: `${z.h}%`,
              border: `1.5px solid ${theme.border}`,
              background: theme.bg,
              zIndex: 8,
              pointerEvents: 'none',
              borderRadius: 4,
              boxShadow: `0 0 10px ${theme.border}40`,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: -18,
                left: 0,
                fontSize: '0.62rem',
                background: 'rgba(15, 17, 21, 0.9)',
                color: theme.border,
                padding: '1px 6px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
                border: `1px solid ${theme.border}60`,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {z.name} <span style={{ opacity: 0.65 }}>({Math.round(z.min_confidence * 100)}%)</span>
            </span>
          </div>
        );
      })}

      {isZoomMode && (
        <div style={{
          position: 'absolute',
          top: '40px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.85)',
          border: '1px solid var(--surface-border)',
          color: '#fff',
          padding: '3px 8px',
          borderRadius: '20px',
          fontSize: '0.65rem',
          zIndex: 10,
          pointerEvents: 'none'
        }}>
          PTZ Active: Scroll to zoom, drag to pan
        </div>
      )}

      {showPTZ && cam.onvif_endpoint && (
        <div style={{ position: 'absolute', right: '12px', top: '50px', zIndex: 15 }}>
          <PTZControls cameraId={cam.id} />
        </div>
      )}

      <div className="cam-bottom" style={{ zIndex: 10 }}>
        {cam.onvif_endpoint && (
          <button
            className="cam-btn"
            title="PTZ Controls"
            onClick={() => setShowPTZ(!showPTZ)}
            style={{ color: showPTZ ? 'var(--cyan)' : 'inherit' }}
          >
            <Crosshair size={12} />
          </button>
        )}
        <button
          className="cam-btn"
          onClick={toggleZoomMode}
          style={{ color: isZoomMode ? 'var(--cyan)' : 'inherit' }}
          title="Digital Zoom / Focus"
        >
          <Focus size={12} />
        </button>

        <button
          className="cam-btn"
          onClick={() => setIsMuted(!isMuted)}
          style={{ color: !isMuted ? 'var(--cyan)' : 'inherit' }}
          title={isMuted ? "Listen" : "Mute"}
        >
          {isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>

        <button
          className="cam-btn"
          onClick={handleSnapshot}
          title="Take Snapshot"
        >
          <CamIcon size={12} />
        </button>

        <button
          className="cam-btn"
          onClick={(e) => { e.stopPropagation(); onMaximize?.(); }}
          title={maximized ? "Restore Grid" : "Full View (Double-click)"}
          style={{ color: maximized ? 'var(--cyan)' : 'inherit' }}
        >
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>

        <button
          className="cam-btn"
          onClick={handleFullscreen}
          title="Native Browser Fullscreen"
        >
          <ExternalLink size={12} />
        </button>

        {(liveMode === 'mse' || liveMode === 'mjpeg') && (
          <span className="cam-info">{liveMode === 'mse' ? 'Live' : 'MJPEG'} - {quality === 'sub' ? 'Sub' : 'Main'}</span>
        )}
      </div>
    </div>
  );
});

const DigitalClock = () => {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);
  return <>{now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} | {now.toLocaleTimeString('en-US', { hour12: false })}</>;
};

const LiveView: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('live');
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [events, setEvents] = useState<CameraEvent[]>([]);
  const [recordings, setRecordings] = useState<Record<string, RecordingFile[]>>({});
  const [layout, setLayout] = useState<1 | 2 | 4 | 9 | 16>(4);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [patrolMode, setPatrolMode] = useState(false);
  const [patrolOffset, setPatrolOffset] = useState<number>(0);

  const [livePaused, setLivePaused] = useState(false);
  const [syncPaused, setSyncPaused] = useState(false);
  const [syncDate, setSyncDate] = useState(() => inputDate(new Date()));
  const [syncTime, setSyncTime] = useState(() => inputTime(new Date()));
  const [syncTargetMs, setSyncTargetMs] = useState(Date.now());
  const [syncWindowStart, setSyncWindowStart] = useState(Date.now() - 3 * 3600 * 1000);
  const syncVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

  // Analytics Studio Interactive State
  const [selectedAnalyticsCamId, setSelectedAnalyticsCamId] = useState<string | null>(null);
  const [localZones, setLocalZones] = useState<Record<string, AnalyticsZone[]>>({});
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const [savingZones, setSavingZones] = useState(false);
  const [zoneToast, setZoneToast] = useState<{ message: string; ok: boolean } | null>(null);

  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    zoneId: string;
    action: 'move' | 'resize-se' | 'resize-sw' | 'resize-ne' | 'resize-nw';
    startClientX: number;
    startClientY: number;
    rectWidth: number;
    rectHeight: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const fetchData = async () => {
    try {
      const c = await fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []);
      setCameras(c);
      const e = await fetch(apiUrl('/events?limit=30')).then(r => r.ok ? r.json() : []);
      setEvents(e);
    } catch {
      /* keep the last good snapshot */
    }
  };

  const recordingSrc = (url: string) => apiUrl(url);

  const withStart = (url: string, offsetSec: number) => {
    const base = recordingSrc(url);
    return `${base}${base.includes('?') ? '&' : '?'}t=${offsetSec.toFixed(3)}`;
  };

  useEffect(() => {
    fetchData();
    const t = setInterval(() => fetchData(), 15000);
    return () => clearInterval(t);
  }, []);

  // Sync / initialize local zones when cameras are fetched
  useEffect(() => {
    if (cameras.length === 0) return;
    setLocalZones(prev => {
      const next = { ...prev };
      cameras.forEach(cam => {
        if (!next[cam.id]) {
          next[cam.id] = cameraToAnalyticsZones(cam);
        }
      });
      return next;
    });

    if (!selectedAnalyticsCamId && cameras[0]) {
      setSelectedAnalyticsCamId(cameras[0].id);
    }
  }, [cameras, selectedAnalyticsCamId]);

  // Lazy query recordings ONLY when user enters Playback view
  useEffect(() => {
    if (cameras.length === 0 || viewMode !== 'playback') return;
    (async () => {
      const next: Record<string, RecordingFile[]> = {};
      await Promise.all(cameras.map(async cam => {
        try {
          const res = await fetch(apiUrl(`/recordings-list?camera_id=${cam.id}`));
          next[cam.id] = res.ok ? (await res.json()).map(parseRecording).sort((a: RecordingFile, b: RecordingFile) => a.startTimestamp - b.startTimestamp) : [];
        } catch {
          next[cam.id] = [];
        }
      }));
      setRecordings(next);
    })();
  }, [cameras, viewMode]);

  useEffect(() => {
    if (!patrolMode || cameras.length === 0) return;
    const t = setInterval(() => {
      setPatrolOffset(prev => (prev + 1) % cameras.length);
    }, 8000);
    return () => clearInterval(t);
  }, [patrolMode, cameras.length]);

  const visibleCameras = useMemo(() => {
    if (maximizedId) return cameras.filter(c => c.id === maximizedId);
    if (!patrolMode) return cameras.slice(0, layout);
    const rotated = [];
    for (let i = 0; i < layout; i++) {
      rotated.push(cameras[(patrolOffset + i) % cameras.length]);
    }
    return rotated.filter(Boolean);
  }, [cameras, maximizedId, layout, patrolMode, patrolOffset]);

  const activeMaxCam = maximizedId ? cameras.find(c => c.id === maximizedId) : null;
  const maxCamIndex = activeMaxCam ? cameras.findIndex(c => c.id === activeMaxCam.id) : -1;
  const prevMaxCam = maxCamIndex > 0 ? cameras[maxCamIndex - 1] : cameras[cameras.length - 1];
  const nextMaxCam = maxCamIndex >= 0 && maxCamIndex < cameras.length - 1 ? cameras[maxCamIndex + 1] : cameras[0];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape' && maximizedId) {
        setMaximizedId(null);
      } else if (e.key === '1') {
        setMaximizedId(null);
        setLayout(1);
      } else if (e.key === '2') {
        setMaximizedId(null);
        setLayout(2);
      } else if (e.key === '4') {
        setMaximizedId(null);
        setLayout(4);
      } else if (e.key === '9') {
        setMaximizedId(null);
        setLayout(9);
      } else if (e.key === '6' || (e.key === '0' && cameras.length > 9)) {
        setMaximizedId(null);
        setLayout(16);
      } else if (e.key.toLowerCase() === 'p') {
        setPatrolMode(prev => !prev);
      } else if (e.code === 'Space') {
        e.preventDefault();
        setLivePaused(p => !p);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [maximizedId, cameras.length]);

  const onlineCams = cameras.filter(c => c.status !== 'offline').length;
  const gridClass = useMemo(() => {
    if (maximizedId || layout === 1) return 'g1';
    if (layout === 2) return 'g2';
    if (layout === 4) {
      return visibleCameras.length <= 2 ? 'g2' : 'g4';
    }
    if (layout === 9) {
      if (visibleCameras.length <= 2) return 'g2';
      if (visibleCameras.length <= 4) return 'g4';
      if (visibleCameras.length <= 6) return 'g6';
      return 'g9';
    }
    if (layout === 16) {
      if (visibleCameras.length <= 2) return 'g2';
      if (visibleCameras.length <= 4) return 'g4';
      if (visibleCameras.length <= 6) return 'g6';
      if (visibleCameras.length <= 9) return 'g9';
      return 'g16';
    }
    return 'g4';
  }, [maximizedId, layout, visibleCameras.length]);

  const syncSpan = 6 * 3600 * 1000;

  const chartData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ev of events) {
      const key = ev.object_class || 'event';
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
  }, [events]);

  const findRecording = (camId: string, targetMs: number) => {
    const files = recordings[camId] || [];
    const hit = resolvePlaybackTarget(files, targetMs, true);
    if (!hit) return null;
    const file = files.find(item => item.url === hit.url);
    if (!file) return null;
    return { ...file, playOffset: Math.max(0, (hit.seekMs - hit.startTimestamp) / 1000) };
  };

  const seekSyncVideos = (targetMs: number) => {
    setSyncTargetMs(targetMs);
    for (const cam of cameras) {
      const rec = findRecording(cam.id, targetMs);
      const video = syncVideoRefs.current[cam.id];
      if (rec && video && video.src.includes(rec.url)) {
        const offset = rec.playOffset;
        const duration = video.duration;
        if (Number.isFinite(duration) && duration > 1 && offset <= duration + 0.25) {
          video.currentTime = Math.min(offset, Math.max(0, duration - 0.25));
        }
      }
    }
  };

  const jumpSyncPlayback = () => {
    const target = new Date(`${syncDate}T${syncTime}`).getTime();
    if (Number.isNaN(target)) return;
    setSyncWindowStart(target - syncSpan / 2);
    seekSyncVideos(target);
  };

  // Detection Zone Dragging & Resizing Logic
  const handleStartDrag = (
    e: React.PointerEvent,
    zoneId: string,
    action: 'move' | 'resize-se' | 'resize-sw' | 'resize-ne' | 'resize-nw'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveZoneId(zoneId);
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentZone = (localZones[selectedAnalyticsCamId || ''] || []).find(z => z.id === zoneId);
    if (!currentZone) return;

    dragState.current = {
      zoneId,
      action,
      startClientX: e.clientX,
      startClientY: e.clientY,
      rectWidth: rect.width,
      rectHeight: rect.height,
      origX: currentZone.x,
      origY: currentZone.y,
      origW: currentZone.w,
      origH: currentZone.h,
    };
  };

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!dragState.current || !selectedAnalyticsCamId) return;
    const { zoneId, action, startClientX, startClientY, rectWidth, rectHeight, origX, origY, origW, origH } = dragState.current;
    if (rectWidth <= 0 || rectHeight <= 0) return;

    const dX = ((e.clientX - startClientX) / rectWidth) * 100;
    const dY = ((e.clientY - startClientY) / rectHeight) * 100;

    setLocalZones(prev => {
      const zones = prev[selectedAnalyticsCamId] || [];
      return {
        ...prev,
        [selectedAnalyticsCamId]: zones.map(z => {
          if (z.id !== zoneId) return z;
          if (action === 'move') {
            const nextX = Math.max(0, Math.min(100 - origW, Math.round(origX + dX)));
            const nextY = Math.max(0, Math.min(100 - origH, Math.round(origY + dY)));
            return { ...z, x: nextX, y: nextY };
          }
          if (action === 'resize-se') {
            const nextW = Math.max(5, Math.min(100 - origX, Math.round(origW + dX)));
            const nextH = Math.max(5, Math.min(100 - origY, Math.round(origH + dY)));
            return { ...z, w: nextW, h: nextH };
          }
          if (action === 'resize-sw') {
            const rightEdge = origX + origW;
            const nextX = Math.max(0, Math.min(rightEdge - 5, Math.round(origX + dX)));
            const nextW = rightEdge - nextX;
            const nextH = Math.max(5, Math.min(100 - origY, Math.round(origH + dY)));
            return { ...z, x: nextX, w: nextW, h: nextH };
          }
          if (action === 'resize-ne') {
            const bottomEdge = origY + origH;
            const nextY = Math.max(0, Math.min(bottomEdge - 5, Math.round(origY + dY)));
            const nextH = bottomEdge - nextY;
            const nextW = Math.max(5, Math.min(100 - origX, Math.round(origW + dX)));
            return { ...z, y: nextY, h: nextH, w: nextW };
          }
          if (action === 'resize-nw') {
            const rightEdge = origX + origW;
            const bottomEdge = origY + origH;
            const nextX = Math.max(0, Math.min(rightEdge - 5, Math.round(origX + dX)));
            const nextY = Math.max(0, Math.min(bottomEdge - 5, Math.round(origY + dY)));
            return { ...z, x: nextX, y: nextY, w: rightEdge - nextX, h: bottomEdge - nextY };
          }
          return z;
        }),
      };
    });
  }, [selectedAnalyticsCamId]);

  const handlePointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  // Zone Management Handlers
  const handleAddZone = () => {
    if (!selectedAnalyticsCamId) return;
    const current = localZones[selectedAnalyticsCamId] || [];
    const newId = `zone-${Date.now()}`;
    const newZone: AnalyticsZone = {
      id: newId,
      name: `Detection Zone ${current.length + 1}`,
      type: current.length === 0 ? 'motion' : 'intrusion',
      x: 25 + (current.length % 3) * 5,
      y: 25 + (current.length % 3) * 5,
      w: 35,
      h: 30,
      min_confidence: 0.6,
      enabled: true,
      notify: true,
      cooldown_seconds: 60,
      objects: ['person', 'car'],
    };
    setLocalZones(prev => ({
      ...prev,
      [selectedAnalyticsCamId]: [...(prev[selectedAnalyticsCamId] || []), newZone],
    }));
    setActiveZoneId(newId);
  };

  const handleUpdateZone = (zoneId: string, patch: Partial<AnalyticsZone>) => {
    if (!selectedAnalyticsCamId) return;
    setLocalZones(prev => ({
      ...prev,
      [selectedAnalyticsCamId]: (prev[selectedAnalyticsCamId] || []).map(z =>
        z.id === zoneId ? { ...z, ...patch } : z
      ),
    }));
  };

  const handleDeleteZone = (zoneId: string) => {
    if (!selectedAnalyticsCamId) return;
    setLocalZones(prev => ({
      ...prev,
      [selectedAnalyticsCamId]: (prev[selectedAnalyticsCamId] || []).filter(z => z.id !== zoneId),
    }));
    if (activeZoneId === zoneId) setActiveZoneId(null);
  };

  const handleSaveZones = async () => {
    if (!selectedAnalyticsCamId) return;
    const cam = cameras.find(c => c.id === selectedAnalyticsCamId);
    if (!cam) return;
    setSavingZones(true);
    try {
      const current = localZones[selectedAnalyticsCamId] || [];
      const formattedZones = current.map(z => ({
        id: z.id,
        name: z.name,
        type: z.type,
        x: z.x,
        y: z.y,
        w: z.w,
        h: z.h,
        points: boxToPoints(z.x, z.y, z.w, z.h),
        objects: z.objects,
        min_confidence: z.min_confidence,
        notify: z.notify,
        cooldown_seconds: z.cooldown_seconds,
        enabled: z.enabled,
        schedule: 'always',
      }));

      const updatedConfig = { ...(cam.config || {}), zones: formattedZones };
      const res = await fetch(apiUrl(`/cameras/${selectedAnalyticsCamId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: updatedConfig }),
      });

      if (res.ok) {
        const updatedCam = await res.json();
        setCameras(prev => prev.map(c => c.id === selectedAnalyticsCamId ? { ...c, ...updatedCam } : c));
        setZoneToast({ message: `Detection zones saved for ${cam.name}`, ok: true });
        setTimeout(() => setZoneToast(null), 3500);
      } else {
        const err = await res.json().catch(() => ({}));
        setZoneToast({ message: err.detail || 'Failed to save zones.', ok: false });
        setTimeout(() => setZoneToast(null), 4500);
      }
    } catch {
      setZoneToast({ message: 'Network error saving zones.', ok: false });
      setTimeout(() => setZoneToast(null), 4500);
    } finally {
      setSavingZones(false);
    }
  };

  const selectedCam = cameras.find(c => c.id === selectedAnalyticsCamId) || cameras[0] || null;
  const currentZones = (selectedCam && localZones[selectedCam.id]) || [];
  const activeZone = currentZones.find(z => z.id === activeZoneId) || null;

  const selectedCamEvents = useMemo(() => {
    if (!selectedCam) return [];
    return events.filter(e => !e.camera_id || e.camera_id === selectedCam.id);
  }, [events, selectedCam]);

  const GridIcon = ({ n }: { n: number }) => (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor">
      {n === 1 && <rect x="0.5" y="0.5" width="12" height="12" rx="1.5" />}
      {n === 2 && (
        <>
          <rect x="0.5" y="0.5" width="5.5" height="12" rx="1" />
          <rect x="7" y="0.5" width="5.5" height="12" rx="1" />
        </>
      )}
      {n === 4 && (<><rect x="0.5" y="0.5" width="5.5" height="5.5" rx="1"/><rect x="7" y="0.5" width="5.5" height="5.5" rx="1"/><rect x="0.5" y="7" width="5.5" height="5.5" rx="1"/><rect x="7" y="7" width="5.5" height="5.5" rx="1"/></>)}
      {n === 9 && (<><rect x="0.5" y="0.5" width="3.3" height="3.3" rx="0.5"/><rect x="4.85" y="0.5" width="3.3" height="3.3" rx="0.5"/><rect x="9.2" y="0.5" width="3.3" height="3.3" rx="0.5"/><rect x="0.5" y="4.85" width="3.3" height="3.3" rx="0.5"/><rect x="4.85" y="4.85" width="3.3" height="3.3" rx="0.5"/><rect x="9.2" y="4.85" width="3.3" height="3.3" rx="0.5"/><rect x="0.5" y="9.2" width="3.3" height="3.3" rx="0.5"/><rect x="4.85" y="9.2" width="3.3" height="3.3" rx="0.5"/><rect x="9.2" y="9.2" width="3.3" height="3.3" rx="0.5"/></>)}
      {n === 16 && (
        <>
          {[0, 1, 2, 3].map(row =>
            [0, 1, 2, 3].map(col => (
              <rect
                key={`${row}-${col}`}
                x={0.5 + col * 3.1}
                y={0.5 + row * 3.1}
                width="2.3"
                height="2.3"
                rx="0.3"
              />
            ))
          )}
        </>
      )}
    </svg>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="topbar">
        <div className="topbar-tabs">
          {[
            ['live', 'Live View'],
            ['playback', 'Playback'],
            ['analytics', 'Analytics Studio'],
          ].map(([mode, label]) => (
            <button key={mode} className={`topbar-tab${viewMode === mode ? ' active' : ''}`} onClick={() => setViewMode(mode as ViewMode)}>
              {label}
            </button>
          ))}
        </div>

        <div className="topbar-stats" style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <div style={{ fontSize: '0.84rem', color: 'var(--t2)' }}>
            <DigitalClock />
          </div>
          <div className="topbar-stat"><span className="topbar-stat-label">System Health</span><span className="topbar-stat-value ok">System OK</span></div>
          <div className="topbar-stat"><span className="topbar-stat-label">Cameras</span><span className="topbar-stat-value cyan">{onlineCams} / {cameras.length} Online</span></div>
          <div className="topbar-stat"><span className="topbar-stat-label">AI Status</span><span className="topbar-stat-value" style={{ color: 'var(--pink)' }}>Active</span></div>
          <button
            className="btn btn-ghost"
            title={livePaused ? 'Resume Live Feeds (Space)' : 'Pause Live Feeds (Space)'}
            onClick={() => setLivePaused(p => !p)}
            style={{ height: 28, fontSize: '0.72rem', padding: '0 8px', display: 'flex', gap: 5, alignItems: 'center' }}
          >
            {livePaused ? <Play size={12} /> : <Pause size={12} />}
            <span>{livePaused ? 'Resume' : 'Pause'}</span>
          </button>
          <button
            className={`btn btn-ghost${patrolMode ? ' active' : ''}`}
            title="Automated Patrol Mode (Rotate Feeds - Press P)"
            onClick={() => setPatrolMode(p => !p)}
            style={{
              height: 28,
              color: patrolMode ? 'var(--cyan)' : 'inherit',
              fontSize: '0.72rem',
              display: 'flex',
              gap: 5,
              alignItems: 'center',
              padding: '0 8px',
              border: patrolMode ? '1px solid var(--cyan-border)' : '1px solid transparent',
              background: patrolMode ? 'rgba(0, 210, 255, 0.08)' : 'transparent',
            }}
          >
            <Activity size={12} />
            <span>Patrol</span>
          </button>
          <button
            className="layout-btn"
            title="Open Wallboard NOC in new tab"
            onClick={() => window.open('/wallboard', '_blank')}
            style={{ width: 28, height: 28 }}
          >
            <ExternalLink size={13} />
          </button>
          {viewMode === 'live' && (
            <div className="layout-toggle" style={{ height: 28, padding: '2px 4px' }}>
              {([1, 2, 4, 9, 16] as const).map(n => (
                <button
                  key={n}
                  className={`layout-btn${layout === n && !maximizedId ? ' active' : ''}`}
                  title={`${n}-Camera Layout`}
                  onClick={() => { setMaximizedId(null); setLayout(n); }}
                >
                  <GridIcon n={n} />
                </button>
              ))}
              <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 3px' }} />
              <button
                className="layout-btn"
                title="Fullscreen Monitor Grid"
                onClick={() => {
                  const el = document.querySelector('.cam-grid') as HTMLElement;
                  if (el) requestNativeFullscreen(el);
                }}
              >
                <Maximize2 size={13} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* VIEW MODE 1: PLAYBACK */}
      {viewMode === 'playback' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input className="form-input" type="date" value={syncDate} onChange={e => setSyncDate(e.target.value)} style={{ width: 150 }} />
            <input className="form-input" type="time" value={syncTime} onChange={e => setSyncTime(e.target.value)} style={{ width: 120 }} />
            <button className="btn btn-primary" onClick={jumpSyncPlayback}>Jump All Cameras</button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                const next = !syncPaused;
                setSyncPaused(next);
                Object.values(syncVideoRefs.current).forEach(video => {
                  if (!video) return;
                  if (next) video.pause();
                  else video.play().catch(() => {});
                });
              }}
            >
              {syncPaused ? 'Play All' : 'Pause All'}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.max(0, Math.min(100, ((syncTargetMs - syncWindowStart) / syncSpan) * 100))}
              onChange={e => seekSyncVideos(syncWindowStart + (parseInt(e.target.value) / 100) * syncSpan)}
              style={{ flex: 1, accentColor: 'var(--cyan)' }}
            />
            <span style={{ color: 'var(--t2)', fontSize: '0.82rem', fontFamily: 'JetBrains Mono' }}>{new Date(syncTargetMs).toLocaleString()}</span>
          </div>
          {cameras.length === 0 ? (
            <div className="empty" style={{ flex: 1 }}>
              <div className="empty-title">No Cameras Added</div>
              <div className="empty-sub">Go to Settings to add cameras manually or auto-discover ONVIF devices.</div>
            </div>
          ) : (
            <div className={`cam-grid ${gridClass}`} style={{ flex: 1, minHeight: 0 }}>
              {visibleCameras.map(cam => {
                const rec = findRecording(cam.id, syncTargetMs);
                return (
                  <div className="cam-cell" key={cam.id}>
                    <div className="cam-top"><div className="cam-name">{cam.name}</div><div className="cam-rec"><div className="cam-rec-dot" /> SYNC</div></div>
                    {rec ? (
                      <video
                        ref={el => { syncVideoRefs.current[cam.id] = el; }}
                        src={withStart(rec.url, rec.playOffset)}
                        controls
                        autoPlay
                        playsInline
                        muted
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <div className="cam-placeholder"><WifiOff size={24} /><span>No Footage At This Time</span></div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* VIEW MODE 2: LIVE MULTI-VIEW */}
      {viewMode === 'live' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 14 }}>
          {maximizedId && activeMaxCam && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                marginBottom: 10,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: '0.75rem', padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setMaximizedId(null)}
                >
                  <Minimize2 size={13} /> Return to Multi-Grid (Esc)
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
                  <div className={`dot ${activeMaxCam.status !== 'offline' ? 'online' : 'offline'}`} />
                  <span>{activeMaxCam.name}</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--cyan)', border: '1px solid var(--cyan-border)', padding: '1px 6px', borderRadius: 4 }}>
                    {activeMaxCam.resolution || 'HD Main'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {cameras.length > 1 && prevMaxCam && nextMaxCam && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="layout-btn"
                      onClick={() => setMaximizedId(prevMaxCam.id)}
                      title={`Previous: ${prevMaxCam.name}`}
                      style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      <ChevronLeft size={13} /> {prevMaxCam.name}
                    </button>
                    <button
                      className="layout-btn"
                      onClick={() => setMaximizedId(nextMaxCam.id)}
                      title={`Next: ${nextMaxCam.name}`}
                      style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      {nextMaxCam.name} <ChevronRight size={13} />
                    </button>
                  </div>
                )}
                <button
                  className="layout-btn"
                  onClick={() => {
                    const el = document.querySelector('.cam-cell.is-maximized') as HTMLElement;
                    if (el) requestNativeFullscreen(el);
                  }}
                  title="Fullscreen Camera"
                  style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Maximize2 size={12} /> Fullscreen
                </button>
              </div>
            </div>
          )}
          <div className={`cam-grid ${gridClass}`} style={{ flex: 1, minHeight: 0 }}>
            {visibleCameras.map(cam => (
              <CameraFeed
                key={cam.id}
                cam={cam}
                paused={livePaused}
                analytics={false}
                maximized={maximizedId === cam.id}
                onMaximize={() => setMaximizedId(prev => prev === cam.id ? null : cam.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* VIEW MODE 3: INTERACTIVE ANALYTICS & DETECTION ZONE STUDIO */}
      {viewMode === 'analytics' && (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 380px', gap: 14, padding: 14 }}>
          {/* LEFT: Canvas & Stream Studio */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
            {/* Camera Switcher Tabs */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', overflowX: 'auto', paddingBottom: 4 }}>
              {cameras.map(cam => {
                const count = (localZones[cam.id] || []).length;
                const isSelected = selectedCam?.id === cam.id;
                return (
                  <button
                    key={cam.id}
                    className={`btn ${isSelected ? 'btn-primary' : 'btn-ghost'}`}
                    style={{
                      fontSize: '0.76rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      whiteSpace: 'nowrap',
                      padding: '5px 12px',
                    }}
                    onClick={() => {
                      setSelectedAnalyticsCamId(cam.id);
                      setActiveZoneId(null);
                    }}
                  >
                    <div className={`dot ${cam.status !== 'offline' ? 'online' : 'offline'}`} />
                    <span>{cam.name}</span>
                    <span
                      style={{
                        fontSize: '0.66rem',
                        background: isSelected ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.08)',
                        padding: '1px 6px',
                        borderRadius: 10,
                      }}
                    >
                      {count} {count === 1 ? 'zone' : 'zones'}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Interactive Video & Zone Dragging Canvas */}
            {selectedCam ? (
              <div
                ref={canvasContainerRef}
                className="cam-cell"
                style={{
                  flex: 1,
                  minHeight: 320,
                  position: 'relative',
                  overflow: 'hidden',
                  background: '#0a0d14',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-lg)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {/* Live Player Video Stream */}
                {selectedCam.rtsp_url_main || selectedCam.rtsp_url_sub ? (
                  <LivePlayer
                    cameraId={selectedCam.id}
                    quality="main"
                    muted={true}
                    paused={livePaused}
                  />
                ) : (
                  <div className="cam-placeholder">
                    <WifiOff size={28} />
                    <span>No Live Stream Available</span>
                  </div>
                )}

                {/* Privacy Masks */}
                {selectedCam.config?.privacy_masks && Array.isArray(selectedCam.config.privacy_masks) && (
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 6 }}>
                    {selectedCam.config.privacy_masks.map((mask: any, idx: number) => (
                      <polygon
                        key={idx}
                        points={mask.points?.map((p: any) => `${p.x * 100},${p.y * 100}`).join(' ')}
                        fill="rgba(0, 0, 0, 0.96)"
                      />
                    ))}
                  </svg>
                )}

                {/* Interactive Detection Zones Layer */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 10,
                    cursor: dragState.current ? 'grabbing' : 'default',
                  }}
                  onClick={() => setActiveZoneId(null)}
                >
                  {currentZones.map((zone) => {
                    const isSelected = zone.id === activeZoneId;
                    const theme = ZONE_COLORS[zone.type] || ZONE_COLORS.motion;

                    return (
                      <div
                        key={zone.id}
                        onPointerDown={(e) => handleStartDrag(e, zone.id, 'move')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveZoneId(zone.id);
                        }}
                        style={{
                          position: 'absolute',
                          left: `${zone.x}%`,
                          top: `${zone.y}%`,
                          width: `${zone.w}%`,
                          height: `${zone.h}%`,
                          border: isSelected ? '2px solid var(--cyan)' : `2px solid ${theme.border}`,
                          background: isSelected ? 'rgba(0, 210, 255, 0.22)' : theme.bg,
                          boxShadow: isSelected
                            ? '0 0 16px rgba(0, 210, 255, 0.6), inset 0 0 12px rgba(0, 210, 255, 0.2)'
                            : `0 0 8px ${theme.border}30`,
                          cursor: 'move',
                          userSelect: 'none',
                          touchAction: 'none',
                          borderRadius: 4,
                          transition: dragState.current?.zoneId === zone.id ? 'none' : 'border-color 0.15s, box-shadow 0.15s',
                        }}
                      >
                        {/* Zone Tag & Badge */}
                        <div
                          style={{
                            position: 'absolute',
                            top: -24,
                            left: 0,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            background: isSelected ? 'var(--cyan)' : 'rgba(15, 17, 21, 0.95)',
                            color: isSelected ? '#000' : theme.border,
                            padding: '2px 8px',
                            borderRadius: '4px 4px 0 0',
                            fontSize: '0.68rem',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                            border: isSelected ? 'none' : `1px solid ${theme.border}60`,
                          }}
                        >
                          <Shield size={10} />
                          <span>{zone.name}</span>
                          <span style={{ opacity: 0.8, fontSize: '0.62rem' }}>[{theme.label}]</span>
                        </div>

                        {/* Interactive Resize Handles (Rendered on Active Selection) */}
                        {isSelected && (
                          <>
                            {/* Bottom-Right Handle */}
                            <div
                              onPointerDown={(e) => handleStartDrag(e, zone.id, 'resize-se')}
                              style={{
                                position: 'absolute',
                                right: -6,
                                bottom: -6,
                                width: 14,
                                height: 14,
                                background: 'var(--cyan)',
                                border: '2px solid #000',
                                borderRadius: 3,
                                cursor: 'se-resize',
                                zIndex: 12,
                                boxShadow: '0 0 6px rgba(0,210,255,0.8)',
                              }}
                            />
                            {/* Bottom-Left Handle */}
                            <div
                              onPointerDown={(e) => handleStartDrag(e, zone.id, 'resize-sw')}
                              style={{
                                position: 'absolute',
                                left: -6,
                                bottom: -6,
                                width: 14,
                                height: 14,
                                background: 'var(--cyan)',
                                border: '2px solid #000',
                                borderRadius: 3,
                                cursor: 'sw-resize',
                                zIndex: 12,
                                boxShadow: '0 0 6px rgba(0,210,255,0.8)',
                              }}
                            />
                            {/* Top-Right Handle */}
                            <div
                              onPointerDown={(e) => handleStartDrag(e, zone.id, 'resize-ne')}
                              style={{
                                position: 'absolute',
                                right: -6,
                                top: -6,
                                width: 14,
                                height: 14,
                                background: 'var(--cyan)',
                                border: '2px solid #000',
                                borderRadius: 3,
                                cursor: 'ne-resize',
                                zIndex: 12,
                                boxShadow: '0 0 6px rgba(0,210,255,0.8)',
                              }}
                            />
                            {/* Top-Left Handle */}
                            <div
                              onPointerDown={(e) => handleStartDrag(e, zone.id, 'resize-nw')}
                              style={{
                                position: 'absolute',
                                left: -6,
                                top: -6,
                                width: 14,
                                height: 14,
                                background: 'var(--cyan)',
                                border: '2px solid #000',
                                borderRadius: 3,
                                cursor: 'nw-resize',
                                zIndex: 12,
                                boxShadow: '0 0 6px rgba(0,210,255,0.8)',
                              }}
                            />
                            {/* Live Dimension HUD */}
                            <div
                              style={{
                                position: 'absolute',
                                bottom: 4,
                                right: 6,
                                fontSize: '0.62rem',
                                color: '#fff',
                                background: 'rgba(0,0,0,0.75)',
                                padding: '2px 5px',
                                borderRadius: 3,
                                pointerEvents: 'none',
                                fontFamily: 'JetBrains Mono, monospace',
                              }}
                            >
                              {zone.w}% × {zone.h}%
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Helpful Canvas Footer Overlay */}
                <div
                  style={{
                    position: 'absolute',
                    bottom: 12,
                    left: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'rgba(15, 17, 21, 0.88)',
                    border: '1px solid var(--border)',
                    borderRadius: 20,
                    padding: '4px 12px',
                    fontSize: '0.68rem',
                    color: 'var(--t2)',
                    zIndex: 15,
                    pointerEvents: 'none',
                  }}
                >
                  <Info size={12} color="var(--cyan)" />
                  <span>Click & drag zones to reposition • Drag corner handles to resize • Click zone to configure</span>
                </div>
              </div>
            ) : (
              <div className="empty" style={{ flex: 1 }}>
                <div className="empty-title">No Camera Selected</div>
                <div className="empty-sub">Please select a camera to configure detection zones.</div>
              </div>
            )}
          </div>

          {/* RIGHT SIDEBAR: Zone Inspector & AI Operations */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: 'auto' }}>
            {/* Top Toolbar: Add Zone & Save */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-ghost"
                onClick={handleAddZone}
                style={{ flex: 1, fontSize: '0.78rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Plus size={14} color="var(--cyan)" /> Add Detection Zone
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveZones}
                disabled={savingZones}
                style={{ flex: 1, fontSize: '0.78rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                {savingZones ? (
                  <>
                    <div className="spinner" style={{ width: 13, height: 13 }} /> Saving...
                  </>
                ) : (
                  <>
                    <Save size={14} /> Save Zones
                  </>
                )}
              </button>
            </div>

            {/* Notification Toast */}
            {zoneToast && (
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: '0.74rem',
                  background: zoneToast.ok ? 'rgba(46, 213, 115, 0.15)' : 'rgba(255, 71, 87, 0.15)',
                  border: zoneToast.ok ? '1px solid var(--green)' : '1px solid var(--red)',
                  color: zoneToast.ok ? 'var(--green)' : 'var(--red)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Check size={14} />
                <span>{zoneToast.message}</span>
              </div>
            )}

            {/* Zone Inspector Card */}
            {activeZone ? (
              <div className="card" style={{ padding: 14 }}>
                <div className="card-head" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Sliders size={14} color="var(--cyan)" />
                    <span className="card-title">Zone Inspector</span>
                  </div>
                  <button
                    className="btn btn-danger"
                    onClick={() => handleDeleteZone(activeZone.id)}
                    title="Delete Zone"
                    style={{ padding: '4px 8px', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Zone Name */}
                  <div className="form-group">
                    <label className="form-label">Zone Name</label>
                    <input
                      className="form-input"
                      value={activeZone.name}
                      onChange={(e) => handleUpdateZone(activeZone.id, { name: e.target.value })}
                      placeholder="e.g. Front Door, Driveway"
                    />
                  </div>

                  {/* Zone Type */}
                  <div className="form-group">
                    <label className="form-label">Detection Type</label>
                    <select
                      className="form-input"
                      value={activeZone.type}
                      onChange={(e) => handleUpdateZone(activeZone.id, { type: e.target.value as any })}
                    >
                      <option value="motion">Motion Detection (General Activity)</option>
                      <option value="intrusion">Intrusion Alert (Immediate Alarm)</option>
                      <option value="tripwire">Tripwire / Perimeter Boundary</option>
                      <option value="privacy">Privacy Mask (Blackout Area)</option>
                    </select>
                  </div>

                  {/* Sensitivity / Min Confidence */}
                  <div className="form-group">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label className="form-label" style={{ margin: 0 }}>Sensitivity Threshold</label>
                      <span style={{ fontSize: '0.72rem', color: 'var(--cyan)', fontFamily: 'JetBrains Mono' }}>
                        {Math.round(activeZone.min_confidence * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="95"
                      step="5"
                      value={Math.round(activeZone.min_confidence * 100)}
                      onChange={(e) => handleUpdateZone(activeZone.id, { min_confidence: parseInt(e.target.value) / 100 })}
                      style={{ width: '100%', accentColor: 'var(--cyan)' }}
                    />
                  </div>

                  {/* Filtered Objects */}
                  <div className="form-group">
                    <label className="form-label">Target Object Classes</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {AVAILABLE_OBJECTS.map((obj) => {
                        const isIncluded = activeZone.objects.includes(obj);
                        return (
                          <button
                            key={obj}
                            type="button"
                            onClick={() => {
                              const next = isIncluded
                                ? activeZone.objects.filter(o => o !== obj)
                                : [...activeZone.objects, obj];
                              handleUpdateZone(activeZone.id, { objects: next });
                            }}
                            style={{
                              fontSize: '0.7rem',
                              padding: '3px 8px',
                              borderRadius: 4,
                              cursor: 'pointer',
                              border: isIncluded ? '1px solid var(--cyan)' : '1px solid var(--border)',
                              background: isIncluded ? 'rgba(0, 210, 255, 0.15)' : 'transparent',
                              color: isIncluded ? 'var(--cyan)' : 'var(--t2)',
                              textTransform: 'capitalize',
                              transition: 'all 0.15s',
                            }}
                          >
                            {obj}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Toggles */}
                  <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={activeZone.enabled}
                        onChange={(e) => handleUpdateZone(activeZone.id, { enabled: e.target.checked })}
                        style={{ accentColor: 'var(--cyan)' }}
                      />
                      <span>Active</span>
                    </label>
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={activeZone.notify}
                        onChange={(e) => handleUpdateZone(activeZone.id, { notify: e.target.checked })}
                        style={{ accentColor: 'var(--cyan)' }}
                      />
                      <span>Trigger Alerts</span>
                    </label>
                  </div>
                </div>
              </div>
            ) : (
              <div className="card" style={{ padding: 14, textAlign: 'center', color: 'var(--t3)' }}>
                <Layers size={24} style={{ margin: '8px auto', opacity: 0.6 }} />
                <div style={{ fontSize: '0.76rem', color: 'var(--t2)', marginBottom: 4 }}>No Zone Selected</div>
                <div style={{ fontSize: '0.7rem' }}>
                  Click any zone on the camera canvas to inspect or adjust its sensitivity and filters.
                </div>
              </div>
            )}

            {/* Configured Zones List for Current Camera */}
            <div className="card" style={{ padding: 14 }}>
              <div className="card-head" style={{ marginBottom: 10 }}>
                <span className="card-title">Zones ({currentZones.length})</span>
              </div>
              {currentZones.length === 0 ? (
                <div style={{ fontSize: '0.72rem', color: 'var(--t3)', padding: 8 }}>
                  No detection zones set. Entire camera view is monitored.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {currentZones.map((z) => {
                    const isSelected = z.id === activeZoneId;
                    const theme = ZONE_COLORS[z.type] || ZONE_COLORS.motion;
                    return (
                      <div
                        key={z.id}
                        onClick={() => setActiveZoneId(z.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: isSelected ? 'rgba(0, 210, 255, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                          border: isSelected ? '1px solid var(--cyan)' : '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: theme.border }} />
                          <div>
                            <div style={{ fontSize: '0.75rem', fontWeight: 500 }}>{z.name}</div>
                            <div style={{ fontSize: '0.64rem', color: 'var(--t3)' }}>
                              {theme.label} • {z.objects.join(', ')}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteZone(z.id);
                          }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--t3)',
                            cursor: 'pointer',
                            padding: 4,
                          }}
                          title="Remove zone"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Real-Time Detection Feed for Selected Camera */}
            <div className="card" style={{ padding: 14, flex: 1, minHeight: 180, display: 'flex', flexDirection: 'column' }}>
              <div className="card-head" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="card-title">Recent Detections</span>
                <Sparkles size={13} color="var(--pink)" />
              </div>
              <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedCamEvents.length === 0 ? (
                  <div style={{ fontSize: '0.72rem', color: 'var(--t3)', padding: 12, textAlign: 'center' }}>
                    No recent detections on this feed.
                  </div>
                ) : (
                  selectedCamEvents.slice(0, 15).map((ev, i) => (
                    <div
                      key={ev.id || i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 8px',
                        borderRadius: 4,
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid var(--border)',
                        fontSize: '0.72rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Activity size={12} color="var(--cyan)" />
                        <span style={{ fontWeight: 500 }}>{ev.object_class || 'Motion Event'}</span>
                      </div>
                      <span style={{ fontSize: '0.66rem', color: 'var(--t3)', fontFamily: 'JetBrains Mono' }}>
                        {new Date(ev.timestamp || ev.created_at || Date.now()).toLocaleTimeString()}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Detection Frequency Chart */}
            {chartData.length > 0 && (
              <div className="card" style={{ padding: 12 }}>
                <div className="card-head" style={{ marginBottom: 6 }}>
                  <span className="card-title">Activity Breakdown</span>
                </div>
                <div style={{ height: 100 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                      <XAxis dataKey="name" stroke="var(--t3)" tick={{ fontSize: 10 }} />
                      <YAxis stroke="var(--t3)" allowDecimals={false} tick={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#161920', border: '1px solid var(--border)', fontSize: '0.72rem' }} />
                      <Bar dataKey="count" fill="var(--cyan)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const CameraFeed = React.memo(CameraFeedComponent, (prev, next) => (
  prev.cam.id === next.cam.id &&
  prev.cam.name === next.cam.name &&
  prev.cam.status === next.cam.status &&
  prev.cam.location === next.cam.location &&
  prev.cam.onvif_endpoint === next.cam.onvif_endpoint &&
  prev.cam.rtsp_url_main === next.cam.rtsp_url_main &&
  prev.cam.rtsp_url_sub === next.cam.rtsp_url_sub &&
  prev.cam.has_motion === next.cam.has_motion &&
  JSON.stringify(prev.cam.config) === JSON.stringify(next.cam.config) &&
  prev.analytics === next.analytics &&
  prev.maximized === next.maximized &&
  prev.paused === next.paused
));

export default LiveView;
