import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, WifiOff } from 'lucide-react';
import { apiUrl, go2rtcUrl } from '../lib/endpoints';

interface Camera {
  id: string;
  name: string;
  rtsp_url_main?: string;
  rtsp_url_sub?: string;
  status: string;
}

const WallboardCell = React.memo<{ cam: Camera; iceServers: RTCIceServer[] }>(({ cam, iceServers }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [connected, setConnected] = useState(false);
  const [useMjpegFallback, setUseMjpegFallback] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const streamName = cam.rtsp_url_sub ? `${cam.id}_sub` : cam.id;
  const camOffline = cam.status === 'offline';
  const iceServersKey = useMemo(() => JSON.stringify(iceServers), [iceServers]);

  useEffect(() => {
    if (camOffline || !cam.rtsp_url_main) return;

    let rtcTimeout: number | undefined;
    let disconnectTimer: number | undefined;
    setConnected(false);
    setUseMjpegFallback(false);

    const pc = new RTCPeerConnection({ iceServers });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        window.clearTimeout(rtcTimeout);
        window.clearTimeout(disconnectTimer);
        setConnected(true);
      }
      if (pc.iceConnectionState === 'disconnected') {
        window.clearTimeout(disconnectTimer);
        disconnectTimer = window.setTimeout(() => {
          if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
            setRetryNonce(n => n + 1);
          }
        }, 4000);
      }
      if (pc.iceConnectionState === 'failed') {
        setUseMjpegFallback(true);
        setConnected(true);
      }
    };

    pc.ontrack = event => {
      window.clearTimeout(rtcTimeout);
      if (videoRef.current && videoRef.current.srcObject !== event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        videoRef.current.play().catch(() => {});
        setConnected(true);
      }
    };

    rtcTimeout = window.setTimeout(() => {
      if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
        setUseMjpegFallback(true);
        setConnected(true);
      }
    }, 8000);

    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const response = await fetch(go2rtcUrl(`/api/webrtc?src=${encodeURIComponent(streamName)}`), {
          method: 'POST',
          body: offer.sdp,
        });
        if (response.ok) {
          await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
        } else {
          setUseMjpegFallback(true);
          setConnected(true);
        }
      } catch (err) {
        console.error('Wallboard WebRTC error', cam.id, err);
        setUseMjpegFallback(true);
        setConnected(true);
      }
    })();

    return () => {
      window.clearTimeout(rtcTimeout);
      window.clearTimeout(disconnectTimer);
      pc.close();
      if (videoRef.current && videoRef.current.srcObject) {
        try {
          const s = videoRef.current.srcObject;
          if (s instanceof MediaStream) s.getTracks().forEach(t => t.stop());
        } catch {}
        videoRef.current.srcObject = null;
      }
      setConnected(false);
    };
  }, [cam.id, cam.rtsp_url_main, camOffline, streamName, iceServersKey, retryNonce]);

  return (
    <div style={{ position: 'relative', background: '#02050a', overflow: 'hidden' }}>
      {camOffline || !cam.rtsp_url_main ? (
        <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#6b7b95', gap: 8 }}>
          <WifiOff size={28} />
          <span>{cam.name}</span>
        </div>
      ) : useMjpegFallback ? (
        <img
          src={go2rtcUrl(`/api/stream.mjpeg?src=${encodeURIComponent(streamName)}`)}
          alt={cam.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          {!connected && (
            <img
              src={apiUrl(`/cameras/${cam.id}/snapshot?t=${Date.now()}`)}
              alt={cam.name}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
          )}
        </>
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
  const [iceServers, setIceServers] = useState<RTCIceServer[]>([]);

  useEffect(() => {
    if (!localStorage.getItem('mview_token')) {
      window.location.href = '/';
      return;
    }

    const loadCameras = async () => {
      try {
        const cams = await fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []);
        setCameras(cams);
      } catch {}
    };

    const loadConfig = async () => {
      try {
        const cfg = await fetch(apiUrl('/system/config')).then(r => r.ok ? r.json() : null);
        const servers = cfg?.network?.ice_servers || [];
        setIceServers(servers.map((url: string) => ({ urls: url })));
      } catch {}
    };

    loadConfig();
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
      {cameras.map(cam => <WallboardCell key={cam.id} cam={cam} iceServers={iceServers} />)}
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
