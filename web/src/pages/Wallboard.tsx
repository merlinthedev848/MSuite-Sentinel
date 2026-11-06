import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, WifiOff, Maximize, Minimize, ArrowLeft } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';
import LivePlayer from '../components/LivePlayer';

interface Camera {
  id: string;
  name: string;
  rtsp_url_main?: string;
  rtsp_url_sub?: string;
  status: string;
}

const WallboardCell = React.memo<{ cam: Camera }>(({ cam }) => {
  const hasStream = Boolean(cam.rtsp_url_main || cam.rtsp_url_sub);

  return (
    <div style={{ position: 'relative', background: '#121418', overflow: 'hidden' }}>
      {!hasStream ? (
        <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#6b7b95', gap: 8 }}>
          <WifiOff size={28} />
          <span>{cam.name}</span>
        </div>
      ) : (
        <LivePlayer cameraId={cam.id} quality={cam.rtsp_url_sub ? 'sub' : 'main'} muted />
      )}
      <div style={{
        position: 'absolute',
        left: 10,
        top: 10,
        color: '#fff',
        fontWeight: 700,
        fontSize: 13,
        textShadow: '0 2px 8px #000',
        zIndex: 10,
      }}>
        {cam.name}
      </div>
      {cam.status === 'recording' && (
        <div style={{
          position: 'absolute',
          right: 10,
          top: 10,
          color: '#e7d2ce',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0,
          textShadow: '0 2px 8px #000',
          zIndex: 10,
        }}>
          REC
        </div>
      )}
    </div>
  );
});

const Wallboard: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(() => typeof document !== 'undefined' && Boolean(document.fullscreenElement));
  const [now, setNow] = useState(() => new Date());
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    const loadCameras = async () => {
      try {
        const cams = await fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []);
        if (active) setCameras(Array.isArray(cams) ? cams : []);
      } catch {
        /* keep the last grid */
      }
    };

    loadCameras();
    const timer = setInterval(loadCameras, 15000);
    const clockTimer = setInterval(() => setNow(new Date()), 1000);
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));

    document.addEventListener('fullscreenchange', handleFsChange);

    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(clockTimer);
      document.removeEventListener('fullscreenchange', handleFsChange);
    };
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch {
      /* fullscreen request ignored or blocked */
    }
  };

  const columns = Math.ceil(Math.sqrt(cameras.length)) || 1;

  if (cameras.length === 0) {
    return (
      <div style={{ minHeight: '100vh', width: '100vw', background: '#07111e', color: '#7ea6d6', display: 'grid', placeItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: '1.1rem' }}>
            <ShieldCheck size={26} color="var(--cyan)" />
            <span>No cameras configured in Sentinel</span>
          </div>
          <button
            onClick={() => navigate('/dashboard')}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', cursor: 'pointer' }}
          >
            <ArrowLeft size={16} /> Return to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: '#16181c',
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, 1fr)`,
      gridAutoRows: '1fr',
      gap: 2,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {cameras.map(cam => <WallboardCell key={cam.id} cam={cam} />)}

      {/* Floating HUD controls for NOC operations */}
      <div
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(18, 20, 24, 0.85)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 8,
          padding: '6px 12px',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
          opacity: 0.6,
          transition: 'opacity 0.2s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }}
      >
        <span style={{ fontSize: '0.78rem', color: '#a8b4c2', fontFamily: 'monospace', marginRight: 6 }}>
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
        </span>
        <span style={{ fontSize: '0.72rem', color: '#7ea6d6', background: 'rgba(255, 255, 255, 0.05)', padding: '3px 8px', borderRadius: 4 }}>
          {cameras.length} Feeds
        </span>
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#e4e8ed',
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
        <button
          onClick={() => navigate('/dashboard')}
          title="Exit to Dashboard"
          aria-label="Exit to Dashboard"
          style={{
            background: '#e4e8ed',
            color: '#17191d',
            border: 'none',
            padding: '6px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.78rem',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <ArrowLeft size={14} /> Exit
        </button>
      </div>
    </div>
  );
};

export default Wallboard;
