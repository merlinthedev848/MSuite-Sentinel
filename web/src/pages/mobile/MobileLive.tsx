import React, { useState } from 'react';
import { Camera, Volume2, VolumeX, PlaySquare, RefreshCw, Download, Search, Maximize2, X, ChevronLeft, ChevronRight, Bell } from 'lucide-react';
import LivePlayer from '../../components/LivePlayer';
import { apiUrl } from '../../lib/endpoints';

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
  events?: any[];
  onSelectCameraForPlayback: (cameraId: string, time?: string) => void;
  onRefresh: () => void;
  onViewAllEvents?: () => void;
}

export const MobileLive: React.FC<MobileLiveProps> = ({
  cameras,
  events = [],
  onSelectCameraForPlayback,
  onRefresh,
  onViewAllEvents,
}) => {
  const [mutedStates, setMutedStates] = useState<Record<string, boolean>>({});
  const [qualities, setQualities] = useState<Record<string, 'auto' | 'main' | 'sub'>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [capturingCamId, setCapturingCamId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [fullViewCamId, setFullViewCamId] = useState<string | null>(null);

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

  const handleCaptureSnapshot = async (camId: string, camName: string) => {
    setCapturingCamId(camId);
    try {
      const res = await fetch(apiUrl(`/cameras/${camId}/snapshot`));
      if (!res.ok) throw new Error('Snapshot failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot_${camName.replace(/\s+/g, '_')}_${Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert('Snapshot could not be captured. Camera stream may be offline or initializing.');
    } finally {
      setCapturingCamId(null);
    }
  };

  const filteredCameras = cameras.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

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

  const activeFullViewCam = fullViewCamId ? cameras.find(c => c.id === fullViewCamId) : null;
  const activeCamIndex = activeFullViewCam ? filteredCameras.findIndex(c => c.id === activeFullViewCam.id) : -1;
  const prevCam = activeCamIndex > 0 ? filteredCameras[activeCamIndex - 1] : filteredCameras[filteredCameras.length - 1];
  const nextCam = activeCamIndex >= 0 && activeCamIndex < filteredCameras.length - 1 ? filteredCameras[activeCamIndex + 1] : filteredCameras[0];

  return (
    <div>
      {/* ── Dedicated Mobile Full View Modal ── */}
      {activeFullViewCam && (
        <div className="mobile-live-fullview-modal">
          {/* Header */}
          <div className="mobile-fullview-header">
            <div className="mobile-fullview-title">
              <span className={`mobile-dot ${activeFullViewCam.status !== 'offline' ? 'online' : ''}`} />
              <span>{activeFullViewCam.name}</span>
              <span style={{ fontSize: '0.65rem', padding: '2px 6px', borderRadius: 4, background: 'rgba(0,210,255,0.15)', color: 'var(--mobile-accent)' }}>
                {qualities[activeFullViewCam.id]?.toUpperCase() || 'MAIN'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="mobile-ctrl-btn"
                onClick={() => setQuality(activeFullViewCam.id, qualities[activeFullViewCam.id] === 'sub' ? 'main' : 'sub')}
                style={{ padding: '4px 8px', fontSize: '0.72rem' }}
              >
                {qualities[activeFullViewCam.id] === 'sub' ? 'Switch to HD' : 'Switch to Sub'}
              </button>
              <button
                className="mobile-ctrl-btn"
                onClick={() => setFullViewCamId(null)}
                title="Close Full View"
                style={{ padding: '6px 10px', borderRadius: '50%' }}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Full View Video Body */}
          <div className="mobile-fullview-body">
            <LivePlayer
              cameraId={activeFullViewCam.id}
              quality={qualities[activeFullViewCam.id] || 'main'}
              muted={mutedStates[activeFullViewCam.id] ?? true}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </div>

          {/* Full View Footer Controls */}
          <div className="mobile-fullview-footer">
            <div className="mobile-fullview-actions">
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => toggleMute(activeFullViewCam.id)}
                  title={mutedStates[activeFullViewCam.id] ? 'Unmute live audio' : 'Mute live audio'}
                  style={{ color: !(mutedStates[activeFullViewCam.id] ?? true) ? 'var(--mobile-accent)' : 'inherit' }}
                >
                  {!(mutedStates[activeFullViewCam.id] ?? true) ? <Volume2 size={16} color="var(--mobile-accent)" /> : <VolumeX size={16} />}
                  {!(mutedStates[activeFullViewCam.id] ?? true) ? 'Audio ON' : 'Unmute'}
                </button>
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => handleCaptureSnapshot(activeFullViewCam.id, activeFullViewCam.name)}
                  disabled={capturingCamId === activeFullViewCam.id}
                >
                  {capturingCamId === activeFullViewCam.id ? <div className="spinner" style={{ width: 14, height: 14 }} /> : <Download size={15} />}
                  Snapshot
                </button>
              </div>

              <button
                className="mobile-ctrl-btn"
                onClick={() => {
                  setFullViewCamId(null);
                  onSelectCameraForPlayback(activeFullViewCam.id);
                }}
                style={{ color: 'var(--mobile-accent)', borderColor: 'rgba(0, 210, 255, 0.3)' }}
              >
                <PlaySquare size={15} /> Playback
              </button>
            </div>

            {/* Quick Camera Switcher Bar */}
            {filteredCameras.length > 1 && prevCam && nextCam && (
              <div className="mobile-fullview-cams-switcher">
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => setFullViewCamId(prevCam.id)}
                  style={{ fontSize: '0.72rem', padding: '4px 10px' }}
                >
                  <ChevronLeft size={14} /> {prevCam.name}
                </button>
                <span style={{ fontSize: '0.72rem', color: 'var(--mobile-text-muted)' }}>
                  {activeCamIndex + 1} of {filteredCameras.length}
                </span>
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => setFullViewCamId(nextCam.id)}
                  style={{ fontSize: '0.72rem', padding: '4px 10px' }}
                >
                  {nextCam.name} <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Scrollable Recent Notifications Ticker ── */}
      {events && events.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, padding: '0 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--mobile-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <Bell size={12} color="var(--mobile-accent)" />
              Recent Notifications
            </div>
            {onViewAllEvents && (
              <button 
                onClick={onViewAllEvents} 
                style={{ background: 'transparent', border: 'none', color: 'var(--mobile-accent)', fontSize: '0.72rem', cursor: 'pointer', padding: 0, fontWeight: 500 }}
              >
                All Events &rarr;
              </button>
            )}
          </div>
          <div className="mobile-notifications-ticker">
            {events.slice(0, 15).map((ev: any, idx) => {
              const cls = (ev.object_class || 'motion').toLowerCase();
              const camName = cameras.find(c => c.id === ev.camera_id)?.name || 'Camera';
              const timeStr = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              return (
                <div
                  key={ev.id || idx}
                  className="mobile-notification-chip"
                  onClick={() => onSelectCameraForPlayback(ev.camera_id, ev.timestamp)}
                  title="Jump to incident footage"
                >
                  <span className={`mobile-dot ${cls === 'person' ? 'person' : cls === 'vehicle' ? 'vehicle' : 'online'}`} />
                  <span style={{ fontWeight: 600, color: 'var(--mobile-text)' }}>{camName}</span>
                  <span style={{ color: 'var(--mobile-text-muted)' }}>{ev.object_class?.split(/[:@]/)[0] || 'Motion'}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.65rem', color: 'var(--mobile-accent)' }}>{timeStr}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Camera Feeds List ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--mobile-text-muted)', fontWeight: 600 }}>
          {filteredCameras.length} {filteredCameras.length === 1 ? 'Camera' : 'Cameras'} Streaming
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

      {cameras.length > 2 && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--mobile-text-muted)' }} />
          <input
            type="text"
            placeholder="Search cameras..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--mobile-surface)',
              border: '1px solid var(--mobile-border)',
              borderRadius: 8,
              padding: '7px 10px 7px 30px',
              fontSize: '0.8rem',
              color: 'var(--mobile-text)',
              outline: 'none',
            }}
          />
        </div>
      )}

      {filteredCameras.map(cam => {
        const isMuted = mutedStates[cam.id] ?? true;
        const quality = qualities[cam.id] ?? 'auto';
        const isOnline = cam.status !== 'offline';
        const isCapturing = capturingCamId === cam.id;

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
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => setFullViewCamId(cam.id)}
                  style={{ padding: '2px 8px', fontSize: '0.68rem', display: 'flex', alignItems: 'center', gap: 4 }}
                  title="Expand to Full View"
                >
                  <Maximize2 size={12} /> Full View
                </button>
              </div>
            </div>

            {/* Video Feed Body (Click to expand) */}
            <div 
              className="mobile-live-card-body" 
              onClick={() => setFullViewCamId(cam.id)}
              style={{ cursor: 'pointer' }}
              title="Click for full view"
            >
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
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => handleCaptureSnapshot(cam.id, cam.name)}
                  disabled={isCapturing}
                  title="Capture still JPEG"
                >
                  {isCapturing ? <div className="spinner" style={{ width: 12, height: 12 }} /> : <Download size={14} />} Still
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="mobile-ctrl-btn"
                  onClick={() => setFullViewCamId(cam.id)}
                  title="Full View"
                  style={{ color: 'var(--mobile-accent)' }}
                >
                  <Maximize2 size={14} /> Full View
                </button>
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

      {/* Clearance spacer to prevent any cards or buttons from clipping behind bottom nav bar */}
      <div style={{ height: 48 }} />
    </div>
  );
};
