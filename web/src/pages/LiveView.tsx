import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Camera as CamIcon,
  ExternalLink,
  Focus,
  Maximize2,
  Mic,
  Video,
  WifiOff,
  Volume2,
  VolumeX,
  Crosshair,
} from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiUrl, go2rtcUrl } from '../lib/endpoints';
import PTZControls from '../components/PTZControls';

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

const parseRecording = (r: any): RecordingFile => {
  const match = r.filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  let start = new Date(r.created_at).getTime();
  if (match) {
    const [, y, m, d, hr, min, sec] = match;
    start = new Date(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(hr), parseInt(min), parseInt(sec)).getTime();
  }
  return {
    ...r,
    startTimestamp: start,
    endTimestamp: Math.max(start + 5000, new Date(r.created_at).getTime()),
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

const CameraFeedComponent: React.FC<{
  cam: Camera;
  iceServers: RTCIceServer[];
  analytics?: boolean;
  maximized?: boolean;
  paused?: boolean;
  onMaximize?: () => void;
}> = ({ cam, iceServers, analytics = false, maximized = false, paused = false, onMaximize }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [useMjpegFallback, setUseMjpegFallback] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showPTZ, setShowPTZ] = useState(false);
  const streamName = (cam.rtsp_url_sub && !maximized) ? `${cam.id}_sub` : `${cam.id}_main`;

  // Tools states
  const [isMuted, setIsMuted] = useState(true);
  const [isMicActive, setIsMicActive] = useState(false);
  const [isZoomMode, setIsZoomMode] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const panStart = useRef({ x: 0, y: 0 });
  const micStreamRef = useRef<MediaStream | null>(null);

  const iceServersKey = useMemo(() => JSON.stringify(iceServers), [iceServers]);

  useEffect(() => {
    if (cam.status === 'offline' || !cam.rtsp_url_main) return;

    let pc: RTCPeerConnection | null = null;
    let rtcTimeout: number | undefined;
    setConnected(false);

    const fallbackToHls = () => {
      setUseMjpegFallback(true);
      setConnected(true);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
        setIsMicActive(false);
      }
    };

    pc = new RTCPeerConnection({ iceServers });

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    if (isMicActive && micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => {
        pc?.addTrack(track, micStreamRef.current!);
      });
    }

    pc.oniceconnectionstatechange = () => {
      if (pc) {
        if (pc.iceConnectionState === 'connected') {
          window.clearTimeout(rtcTimeout);
          setConnected(true);
          videoRef.current?.play().catch(err => console.log("LiveView play on connection success error:", err));
        }
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          console.warn('[LiveView WebRTC] connection failed/disconnected. Falling back to HLS...');
          fallbackToHls();
        }
      }
    };

    pc.ontrack = e => {
      window.clearTimeout(rtcTimeout);
      if (videoRef.current && videoRef.current.srcObject !== e.streams[0]) {
        videoRef.current.srcObject = e.streams[0];
        videoRef.current.play().catch(err => console.log("LiveView WebRTC play error:", err));
        setConnected(true);
      }
    };

    (async () => {
      try {
        if (!pc) return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const res = await fetch(go2rtcUrl(`/api/webrtc?src=${encodeURIComponent(streamName)}`), {
          method: 'POST',
          body: offer.sdp,
        });
        if (!res.ok) throw new Error(`go2rtc WebRTC returned ${res.status}`);
        if (pc) {
          await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
        }
      } catch (e) {
        console.error('[LiveView WebRTC]', cam.name, e);
        fallbackToHls();
      }
    })();

    // Set an 8.0s connection timeout for WebRTC before failing over to HLS
    rtcTimeout = window.setTimeout(() => {
      if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
        console.warn(`[LiveView WebRTC] connection timed out after 8.0s for ${cam.name}. Falling back to HLS...`);
        fallbackToHls();
      }
    }, 8000);

    return () => {
      window.clearTimeout(rtcTimeout);
      if (pc) pc.close();
      if (videoRef.current) {
        if (videoRef.current.srcObject) {
          try {
            const stream = videoRef.current.srcObject;
            if (stream instanceof MediaStream) {
              stream.getTracks().forEach(track => track.stop());
            }
          } catch (e) {}
          videoRef.current.srcObject = null;
        }
        videoRef.current.src = '';
      }
      setConnected(false);
    };
  }, [cam.id, cam.name, cam.status, cam.rtsp_url_main, streamName, isMicActive, retryNonce, iceServersKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) video.pause();
    else video.play().catch(() => {});
  }, [paused]);

  useEffect(() => {
    return () => {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // 1. Fullscreen
  const handleFullscreen = () => {
    if (containerRef.current) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen();
      } else if ((containerRef.current as any).webkitRequestFullscreen) {
        (containerRef.current as any).webkitRequestFullscreen();
      }
    }
  };

  // 2. Snapshot capture
  const handleSnapshot = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg');
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot_${cam.name.replace(/\s+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
      a.click();
    }
  };

  // 3. Two-Way Mic Talk
  const toggleMic = async () => {
    if (isMicActive) {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
      }
      setIsMicActive(false);
      setRetryNonce(n => n + 1);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        setIsMicActive(true);
        setRetryNonce(n => n + 1);
      } catch (err) {
        console.error("Failed to access mic:", err);
        alert("Microphone access denied or not supported.");
      }
    }
  };

  // 4. Digital PTZ handlers
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

  const isOffline = cam.status === 'offline';

  return (
    <div 
      ref={containerRef}
      className={`cam-cell${cam.has_motion || analytics ? ' has-motion' : ''}`}
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

      {isOffline || !cam.rtsp_url_main ? (
        <div className="cam-placeholder">
          <WifiOff size={26} strokeWidth={1.5} />
          <span>{isOffline ? 'Camera Offline' : 'No Stream URL'}</span>
        </div>
      ) : (
        <>
          {useMjpegFallback ? (
            <img 
              src={go2rtcUrl(`/api/stream.mjpeg?src=${encodeURIComponent(streamName)}`)}
              alt="MJPEG Fallback"
              onError={(e) => {
                const target = e.currentTarget as HTMLImageElement;
                target.dataset.fallback = "true";
                setTimeout(() => {
                  target.src = apiUrl(`/cameras/${cam.id}/snapshot?t=${Date.now()}`);
                }, 1000);
              }}
              onLoad={(e) => {
                const target = e.currentTarget as HTMLImageElement;
                if (target.dataset.fallback === "true") {
                  setTimeout(() => {
                    target.src = apiUrl(`/cameras/${cam.id}/snapshot?t=${Date.now()}`);
                  }, 1000);
                }
              }}
              style={{ 
                width: '100%', 
                height: '100%', 
                objectFit: 'cover',
                transform: isZoomMode ? `scale(${zoomScale}) translate(${zoomOffset.x}px, ${zoomOffset.y}px)` : 'none',
                transformOrigin: 'center center',
                transition: isPanning ? 'none' : 'transform 0.1s ease',
                cursor: isZoomMode ? (isPanning ? 'grabbing' : 'grab') : 'default'
              }} 
            />
          ) : (
            <>
              {!connected && (
                <img 
                  src={apiUrl(`/cameras/${cam.id}/snapshot`)}
                  alt={cam.name}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    zIndex: 1,
                    pointerEvents: 'none'
                  }}
                />
              )}
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                muted={isMuted} 
                style={{ 
                  width: '100%', 
                  height: '100%', 
                  objectFit: 'cover',
                  opacity: connected ? 1 : 0,
                  transform: isZoomMode ? `scale(${zoomScale}) translate(${zoomOffset.x}px, ${zoomOffset.y}px)` : 'none',
                  transformOrigin: 'center center',
                  transition: isPanning ? 'none' : 'transform 0.1s ease, opacity 0.3s ease',
                  cursor: isZoomMode ? (isPanning ? 'grabbing' : 'grab') : 'default'
                }} 
              />
            </>
          )}
          {!connected && (
            <div className="cam-connecting" style={{ zIndex: 2 }}>
              <div className="spinner" />
              <span style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>Connecting...</span>
            </div>
          )}
        </>
      )}

      {analytics && (
        <>
          <div style={{ position: 'absolute', left: '18%', top: '24%', width: '18%', height: '28%', border: '2px solid var(--cyan)', boxShadow: '0 0 14px var(--cyan-glow)', zIndex: 8 }} />
          <div style={{ position: 'absolute', left: '58%', top: '46%', width: '20%', height: '18%', border: '2px solid var(--pink)', boxShadow: '0 0 14px var(--pink-glow)', zIndex: 8 }} />
        </>
      )}

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
        {/* Focus Mode (Digital Zoom) */}
        <button 
          className="cam-btn" 
          onClick={toggleZoomMode} 
          style={{ color: isZoomMode ? 'var(--cyan)' : 'inherit' }}
          title="Digital Zoom / Focus"
        >
          <Focus size={12} />
        </button>

        {/* Listen / Unmute */}
        <button 
          className="cam-btn" 
          onClick={() => setIsMuted(!isMuted)} 
          style={{ color: !isMuted ? 'var(--cyan)' : 'inherit' }}
          title={isMuted ? "Listen" : "Mute"}
        >
          {isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>

        {/* Two-Way Audio talk */}
        <button 
          className="cam-btn" 
          onClick={toggleMic} 
          style={{ color: isMicActive ? 'var(--pink)' : 'inherit' }}
          title={isMicActive ? "Mic Active" : "Two-Way Microphone Talk"}
        >
          <Mic size={12} />
        </button>

        {/* Snapshot Capture */}
        <button 
          className="cam-btn" 
          onClick={handleSnapshot} 
          title="Take Snapshot"
        >
          <CamIcon size={12} />
        </button>

        {/* Maximize in Grid */}
        <button 
          className="cam-btn" 
          onClick={onMaximize} 
          title="Maximize in Grid"
        >
          <Maximize2 size={12} />
        </button>

        {/* Fullscreen Mode */}
        <button 
          className="cam-btn" 
          onClick={handleFullscreen} 
          title="Fullscreen"
        >
          <Maximize2 size={12} />
        </button>

        {connected && <span className="cam-info">{isMicActive ? 'WebRTC Talk' : 'WebRTC'} - {cam.rtsp_url_sub && !maximized ? 'Sub' : 'Main'}</span>}
      </div>
    </div>
  );
};

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
  const [layout, setLayout] = useState<1 | 4 | 9>(4);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [patrolMode, setPatrolMode] = useState(false);
  const [patrolOffset, setPatrolOffset] = useState<number>(0);

  const [iceServers, setIceServers] = useState<RTCIceServer[]>([]);
  const [livePaused, setLivePaused] = useState(false);
  const [syncPaused, setSyncPaused] = useState(false);
  const [syncDate, setSyncDate] = useState(() => inputDate(new Date()));
  const [syncTime, setSyncTime] = useState(() => inputTime(new Date()));
  const [syncTargetMs, setSyncTargetMs] = useState(Date.now());
  const [syncWindowStart, setSyncWindowStart] = useState(Date.now() - 3 * 3600 * 1000);
  const syncVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

  // (Clock moved to DigitalClock to prevent re-renders)

  const fetchData = async (loadConfig = false) => {
    try {
      const c = await fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []);
      setCameras(c);
      const [e, cfg] = await Promise.all([
        fetch(apiUrl('/events?limit=20')).then(r => r.ok ? r.json() : []),
        loadConfig ? fetch(apiUrl('/system/config')).then(r => r.ok ? r.json() : null) : Promise.resolve(null),
      ]);
      setEvents(e);
      if (cfg) {
        const servers = cfg?.network?.ice_servers || [];
        setIceServers(servers.map((url: string) => ({ urls: url })));
      }
    } catch {}
  };

  const recordingSrc = (url: string) => {
    const token = localStorage.getItem('mview_token');
    const separator = url.includes('?') ? '&' : '?';
    return apiUrl(token ? `${url}${separator}token=${encodeURIComponent(token)}` : url);
  };

  useEffect(() => {
    fetchData(true);
    const t = setInterval(() => fetchData(false), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (cameras.length === 0) return;
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
  }, [cameras.map(c => c.id).join('|')]);

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

  const onlineCams = cameras.filter(c => c.status !== 'offline').length;
  const gridClass = maximizedId || layout === 1 ? 'g1' : layout === 4 ? 'g4' : 'g9';
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
    return files.find(r => targetMs >= r.startTimestamp && targetMs <= r.endTimestamp) || files[files.length - 1] || null;
  };

  const seekSyncVideos = (targetMs: number) => {
    setSyncTargetMs(targetMs);
    for (const cam of cameras) {
      const rec = findRecording(cam.id, targetMs);
      const video = syncVideoRefs.current[cam.id];
      if (rec && video && video.src.includes(rec.url)) {
        const offset = Math.max(0, (targetMs - rec.startTimestamp) / 1000);
        video.currentTime = Math.min(offset, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.5) : offset);
      }
    }
  };

  const jumpSyncPlayback = () => {
    const target = new Date(`${syncDate}T${syncTime}`).getTime();
    if (Number.isNaN(target)) return;
    setSyncWindowStart(target - syncSpan / 2);
    seekSyncVideos(target);
  };



  const GridIcon = ({ n }: { n: number }) => (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor">
      {n === 1 && <rect x="0.5" y="0.5" width="12" height="12" rx="1.5" />}
      {n === 4 && (<><rect x="0.5" y="0.5" width="5.5" height="5.5" rx="1"/><rect x="7" y="0.5" width="5.5" height="5.5" rx="1"/><rect x="0.5" y="7" width="5.5" height="5.5" rx="1"/><rect x="7" y="7" width="5.5" height="5.5" rx="1"/></>)}
      {n === 9 && (<><rect x="0.5" y="0.5" width="3.3" height="3.3" rx="0.5"/><rect x="4.85" y="0.5" width="3.3" height="3.3" rx="0.5"/><rect x="9.2" y="0.5" width="3.3" height="3.3" rx="0.5"/><rect x="0.5" y="4.85" width="3.3" height="3.3" rx="0.5"/><rect x="4.85" y="4.85" width="3.3" height="3.3" rx="0.5"/><rect x="9.2" y="4.85" width="3.3" height="3.3" rx="0.5"/><rect x="0.5" y="9.2" width="3.3" height="3.3" rx="0.5"/><rect x="4.85" y="9.2" width="3.3" height="3.3" rx="0.5"/><rect x="9.2" y="9.2" width="3.3" height="3.3" rx="0.5"/></>)}
    </svg>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="topbar">
        <div className="topbar-tabs">
          {[
            ['live', 'Live View'],
            ['playback', 'Playback'],
            ['analytics', 'Analytics'],
          ].map(([mode, label]) => (
            <button key={mode} className={`topbar-tab${viewMode === mode ? ' active' : ''}`} onClick={() => setViewMode(mode as ViewMode)}>
              {label}
            </button>
          ))}
        </div>

        <div className="topbar-stats" style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--t2)', fontFamily: 'JetBrains Mono, monospace' }}>
            <DigitalClock />
          </div>
          <div className="topbar-stat"><span className="topbar-stat-label">System Health</span><span className="topbar-stat-value ok">System OK</span></div>
          <div className="topbar-stat"><span className="topbar-stat-label">Cameras</span><span className="topbar-stat-value cyan">{onlineCams} / {cameras.length} Online</span></div>
          <div className="topbar-stat"><span className="topbar-stat-label">AI Status</span><span className="topbar-stat-value" style={{ color: 'var(--pink)' }}>Active</span></div>
          <button
            className={`layout-btn${livePaused ? ' active' : ''}`}
            title={livePaused ? 'Resume Live Feeds' : 'Pause Live Feeds'}
            onClick={() => setLivePaused(p => !p)}
            style={{ fontSize: '0.7rem', padding: '0 8px' }}
          >
            {livePaused ? 'Resume' : 'Pause'}
          </button>
          <button className="layout-btn" title="Wallboard Popout" onClick={() => window.open('/wallboard', '_blank')}>
            <ExternalLink size={14} />
          </button>
          <div className="layout-toggle">
            <button 
              className={`layout-btn${patrolMode ? ' active' : ''}`} 
              title="Automated Patrol Mode (Rotate Feeds)"
              onClick={() => setPatrolMode(p => !p)}
              style={{ color: patrolMode ? 'var(--cyan)' : 'inherit', fontSize: '0.7rem', display: 'flex', gap: 4, alignItems: 'center', padding: '0 8px' }}
            >
              <Activity size={12} /> Patrol
            </button>
            {([1, 4, 9] as const).map(n => (
              <button key={n} className={`layout-btn${layout === n && !maximizedId ? ' active' : ''}`} onClick={() => { setMaximizedId(null); setLayout(n); }}>
                <GridIcon n={n} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {viewMode === 'playback' ? (
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
            <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--t2)' }}>{new Date(syncTargetMs).toLocaleString()}</span>
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
                        key={rec.url}
                        src={recordingSrc(rec.url)}
                        autoPlay={!syncPaused}
                        muted
                        playsInline
                        onLoadedMetadata={e => {
                          const video = e.currentTarget;
                          const offset = Math.max(0, (syncTargetMs - rec.startTimestamp) / 1000);
                          video.currentTime = Math.min(offset, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.5) : offset);
                        }}
                      />
                    ) : (
                      <div className="cam-placeholder"><Video size={26} /><span>No recording segment</span></div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: viewMode === 'analytics' ? '1fr 300px' : '1fr', gap: 12, padding: 14 }}>
          {cameras.length === 0 ? (
            <div className="empty" style={{ flex: 1 }}>
              <div className="empty-title">No Cameras Added</div>
              <div className="empty-sub">Go to Settings to add cameras manually or auto-discover ONVIF devices.</div>
            </div>
          ) : (
            <div className={`cam-grid ${gridClass}`} style={{ minHeight: 0 }}>
              {visibleCameras.map(cam => (
                <CameraFeed
                  key={cam.id}
                  cam={cam}
                  iceServers={iceServers}
                  paused={livePaused}
                  analytics={viewMode === 'analytics'}
                  maximized={maximizedId === cam.id}
                  onMaximize={() => setMaximizedId(prev => prev === cam.id ? null : cam.id)}
                />
              ))}
            </div>
          )}
          {viewMode === 'analytics' && (
            <div className="card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="card-head"><span className="card-title">Active Detections</span></div>
              <div style={{ height: 180, padding: 12 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <XAxis dataKey="name" stroke="var(--t3)" />
                    <YAxis stroke="var(--t3)" allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" fill="var(--cyan)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {events.length === 0 ? <span style={{ color: 'var(--t3)' }}>No detections yet</span> : events.map((ev, i) => (
                  <div key={ev.id || i} className="event-row">
                    <Activity size={13} color="var(--cyan)" />
                    <span className="event-text">{ev.object_class || 'event'} detected</span>
                    <span className="event-time">{new Date(ev.timestamp || ev.created_at || Date.now()).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
};

const CameraFeed = React.memo(CameraFeedComponent, (prev, next) => (
  prev.cam.id === next.cam.id &&
  prev.cam.status === next.cam.status &&
  prev.cam.rtsp_url_main === next.cam.rtsp_url_main &&
  prev.cam.rtsp_url_sub === next.cam.rtsp_url_sub &&
  prev.cam.has_motion === next.cam.has_motion &&
  prev.analytics === next.analytics &&
  prev.maximized === next.maximized &&
  prev.paused === next.paused &&
  prev.iceServers === next.iceServers
));

export default LiveView;
