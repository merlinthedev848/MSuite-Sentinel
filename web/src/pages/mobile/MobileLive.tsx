import React, { useState } from 'react';
import { Camera, Volume2, VolumeX, PlaySquare, RefreshCw } from 'lucide-react';
import LivePlayer from '../../components/LivePlayer';

interface CameraItem {
  id: string;
  name: string;
  rtsp_url_main: string;
  rtsp_url_sub?: string;
  status: string;
  resolution?: string;
  fps?: number;
}

interface MobileLiveProps {
  cameras: CameraItem[];
  onSelectCameraForPlayback: (cameraId: string) => void;
  onRefresh: () => void;
}

export const MobileLive: React.FC<MobileLiveProps> = ({
  cameras,
  onSelectCameraForPlayback,
  onRefresh,
}) => {
  const [mutedStates, setMutedStates] = useState<Record<string, boolean>>({});
  const [qualities, setQualities] = useState<Record<string, 'auto' | 'main' | 'sub'>>({});
  const [refreshing, setRefreshing] = useState(false);

  const toggleMute = (camId: string) => {
    setMutedStates(prev => ({ ...prev, [camId]: !(prev[camId] ?? true) }));
  };

  const setQuality = (camId: string, q: 'auto' | 'main' | 'sub') => {
    setQualities(prev => ({ ...prev, [camId]: q }));
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await onRefresh();
    setTimeout(() => setRefreshing(false), 500);
  };

  if (cameras.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--mobile-text-muted)' }}>
        <Camera size={36} style={{ opacity: 0.4, marginBottom: 12 }} />
        <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--mobile-text)' }}>No cameras found</div>
        <div style={{ fontSize: '0.75rem', marginTop: 4 }}>Add or configure cameras in Settings.</div>
        <button
          onClick={handleRefresh}
          className="mobile-ctrl-btn"
          style={{ margin: '16px auto 0', display: 'inline-flex' }}
        >
          <RefreshCw size={14} className={refreshing ? 'spinner' : ''} /> Refresh
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--mobile-text-muted)', fontWeight: 600 }}>
          {cameras.length} {cameras.length === 1 ? 'Camera' : 'Cameras'} Streaming
        </span>
        <button
          onClick={handleRefresh}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--mobile-text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: '0.75rem',
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={13} className={refreshing ? 'spinner' : ''} /> Refresh
        </button>
      </div>

      {cameras.map(cam => {
        const isMuted = mutedStates[cam.id] ?? true;
        const quality = qualities[cam.id] ?? 'auto';
        const isOnline = cam.status !== 'offline';

        return (
          <div key={cam.id} className="mobile-live-card">
            {/* Camera Card Header */}
            <div className="mobile-live-card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`mobile-dot ${isOnline ? 'online' : ''}`} />
                <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--mobile-text)' }}>
                  {cam.name}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => setQuality(cam.id, quality === 'sub' ? 'main' : 'sub')}
                  style={{
                    fontSize: '0.65rem',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: 'var(--mobile-surface-hover)',
                    border: '1px solid var(--mobile-border)',
                    color: quality === 'main' ? 'var(--mobile-accent)' : 'var(--mobile-text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {quality.toUpperCase()}
                </button>
                {cam.resolution && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--mobile-text-muted)', fontFamily: 'monospace' }}>
                    {cam.resolution}
                  </span>
                )}
              </div>
            </div>

            {/* Video Feed Body */}
            <div className="mobile-live-card-body">
              <LivePlayer
                cameraId={cam.id}
                quality={quality}
                muted={isMuted}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            </div>

            {/* Camera Card Footer Controls */}
            <div className="mobile-live-card-footer">
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => toggleMute(cam.id)}
                  title={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} color="var(--mobile-accent)" />}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => onSelectCameraForPlayback(cam.id)}
                  style={{ color: 'var(--mobile-accent)', borderColor: 'rgba(0, 210, 255, 0.3)' }}
                >
                  <PlaySquare size={14} /> Playback
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
