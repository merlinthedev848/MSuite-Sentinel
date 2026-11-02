import React, { useEffect, useState } from 'react';
import { ShieldCheck, WifiOff } from 'lucide-react';
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
    <div style={{ position: 'relative', background: '#02050a', overflow: 'hidden' }}>
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
      }}>
        {cam.name}
      </div>
      {cam.status === 'recording' && (
        <div style={{
          position: 'absolute',
          right: 10,
          top: 10,
          color: '#ff3b6b',
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1,
          textShadow: '0 2px 8px #000',
        }}>
          REC
        </div>
      )}
    </div>
  );
});

const Wallboard: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);

  useEffect(() => {
    const loadCameras = async () => {
      try {
        const cams = await fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []);
        setCameras(cams);
      } catch {
        /* keep the last grid */
      }
    };

    loadCameras();
    const timer = setInterval(loadCameras, 15000);
    return () => clearInterval(timer);
  }, []);

  const columns = Math.ceil(Math.sqrt(cameras.length)) || 1;

  if (cameras.length === 0) {
    return (
      <div style={{ minHeight: '100vh', background: '#07111e', color: '#7ea6d6', display: 'grid', placeItems: 'center' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <ShieldCheck size={22} />
          No cameras available
        </div>
      </div>
    );
  }

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: '#02050a',
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, 1fr)`,
      gridAutoRows: '1fr',
      gap: 2,
      overflow: 'hidden',
    }}>
      {cameras.map(cam => <WallboardCell key={cam.id} cam={cam} />)}
      <div
        style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000, opacity: 0.5, transition: 'opacity 0.2s' }}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.5'}
      >
        <button
          onClick={() => window.location.href = '/'}
          style={{ background: '#ff3b6b', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}
        >
          Exit Wallboard
        </button>
      </div>
    </div>
  );
};

export default Wallboard;
