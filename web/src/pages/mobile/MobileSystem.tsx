import React, { useState, useEffect } from 'react';
import { 
  HardDrive, Cpu, Camera, 
  Volume2, VolumeX, Monitor, LogOut,
  Smartphone, Code, ExternalLink
} from 'lucide-react';
import { apiUrl } from '../../lib/endpoints';
import { audioAlerts } from '../../lib/audioAlerts';

interface MobileSystemProps {
  onSwitchToDesktop: () => void;
  onLogout: () => void;
}

export const MobileSystem: React.FC<MobileSystemProps> = ({
  onSwitchToDesktop,
  onLogout,
}) => {
  const [health, setHealth] = useState<any>(null);
  const [cameras, setCameras] = useState<any[]>([]);
  const [storageReport, setStorageReport] = useState<any>(null);
  const [audioEnabled, setAudioEnabled] = useState(() => audioAlerts.isEnabled());

  const loadData = async () => {
    try {
      const [hRes, cRes, sRes] = await Promise.all([
        fetch(apiUrl('/system/health')).then(r => r.ok ? r.json() : null),
        fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []),
        fetch(apiUrl('/system/storage-report')).then(r => r.ok ? r.json() : null)
      ]);
      if (hRes) setHealth(hRes);
      if (Array.isArray(cRes)) setCameras(cRes);
      if (sRes) setStorageReport(sRes);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadData();
    const t = setInterval(loadData, 10000);
    return () => clearInterval(t);
  }, []);

  const toggleAudio = () => {
    const next = audioAlerts.toggle();
    audioAlerts.playChime('info');
    setAudioEnabled(next);
  };

  const onlineCount = cameras.filter(c => c.status !== 'offline').length;
  const storage = health?.storage;
  const cpuPercent = typeof health?.cpu_usage_percent === 'number' ? health.cpu_usage_percent.toFixed(1) : '--';
  const networkUp = typeof health?.network?.up_mbps === 'number' ? health.network.up_mbps.toFixed(2) : '0.00';
  const networkDown = typeof health?.network?.down_mbps === 'number' ? health.network.down_mbps.toFixed(2) : '0.00';

  return (
    <div>
      {/* ── 1. Storage Status Card ── */}
      <div className="mobile-stat-card">
        <div className="mobile-stat-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--mobile-text)' }}>
            <HardDrive size={15} color="var(--mobile-accent)" /> Storage Usage
          </span>
          <span>{storage ? `${storage.usage_percent}% Used` : ''}</span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--mobile-text-muted)', marginBottom: 4 }}>
          <span>Recordings Archive</span>
          <span style={{ color: 'var(--mobile-text)', fontWeight: 600 }}>
            {storageReport ? `${storageReport.total_gb} GB` : '0 GB'}
          </span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--mobile-text-muted)' }}>
          <span>Disk Used / Total</span>
          <span style={{ color: 'var(--mobile-text)', fontWeight: 600 }}>
            {storage ? `${(storage.total_gb - storage.free_gb).toFixed(1)} GB / ${storage.total_gb.toFixed(1)} GB` : '--'}
          </span>
        </div>

        <div className="mobile-progress-bar">
          <div
            className="mobile-progress-fill"
            style={{ width: `${storage ? Math.min(100, storage.usage_percent) : 0}%` }}
          />
        </div>
      </div>

      {/* ── 2. Performance Metrics Card ── */}
      <div className="mobile-stat-card">
        <div className="mobile-stat-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--mobile-text)' }}>
            <Cpu size={15} color="var(--mobile-accent)" /> System Performance
          </span>
          <span style={{ color: health?.status === 'online' ? 'var(--mobile-success)' : 'var(--mobile-warning)', fontWeight: 600 }}>
            {health?.status ? health.status.toUpperCase() : 'ONLINE'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <div style={{ background: 'var(--mobile-bg)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--mobile-border)' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)', marginBottom: 2 }}>CPU LOAD</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--mobile-text)' }}>{cpuPercent}%</div>
          </div>

          <div style={{ background: 'var(--mobile-bg)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--mobile-border)' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)', marginBottom: 2 }}>LATENCY</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--mobile-text)' }}>
              {health?.latency_ms ? `${health.latency_ms} ms` : '12 ms'}
            </div>
          </div>

          <div style={{ background: 'var(--mobile-bg)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--mobile-border)' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)', marginBottom: 2 }}>NETWORK UP</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--mobile-text)' }}>{networkUp} Mbps</div>
          </div>

          <div style={{ background: 'var(--mobile-bg)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--mobile-border)' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)', marginBottom: 2 }}>NETWORK DOWN</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--mobile-text)' }}>{networkDown} Mbps</div>
          </div>
        </div>
      </div>

      {/* ── 3. Cameras List ── */}
      <div className="mobile-stat-card">
        <div className="mobile-stat-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--mobile-text)' }}>
            <Camera size={15} color="var(--mobile-accent)" /> Camera Feeds
          </span>
          <span style={{ color: 'var(--mobile-text)' }}>{onlineCount}/{cameras.length} Active</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cameras.map(c => {
            const isOnline = c.status !== 'offline';
            return (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  background: 'var(--mobile-bg)',
                  borderRadius: 8,
                  border: '1px solid var(--mobile-border)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`mobile-dot ${isOnline ? 'online' : ''}`} />
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--mobile-text)' }}>{c.name}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)' }}>
                      {c.resolution || '1080p'} • {c.record_codec || 'H.264'}
                    </div>
                  </div>
                </div>
                <span style={{
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  color: isOnline ? 'var(--mobile-success)' : 'var(--mobile-danger)'
                }}>
                  {isOnline ? 'ONLINE' : 'OFFLINE'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 4. App & Developer Integration ── */}
      <div className="mobile-stat-card">
        <div className="mobile-stat-header">
          <span style={{ color: 'var(--mobile-text)' }}>App &amp; Developer Integration</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            background: 'var(--mobile-bg)',
            borderRadius: 10,
            border: '1px solid var(--mobile-border)',
            padding: '12px 14px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <Smartphone size={16} color="var(--mobile-accent)" />
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--mobile-text)' }}>
                Install Sentinel as Mobile App
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--mobile-text-muted)', lineHeight: 1.4 }}>
              On iOS Safari: Tap <strong>Share</strong> &rarr; <strong>Add to Home Screen</strong>.<br/>
              On Android Chrome: Tap the three dots menu &rarr; <strong>Install app</strong>.
            </div>
          </div>

          <a
            href={apiUrl('/docs')}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              background: 'var(--mobile-bg)',
              borderRadius: 10,
              border: '1px solid var(--mobile-border)',
              color: 'var(--mobile-text)',
              textDecoration: 'none'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Code size={16} color="var(--mobile-accent)" />
              <div>
                <div style={{ fontSize: '0.8rem', fontWeight: 500 }}>REST API Documentation (Swagger)</div>
                <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)' }}>Build custom native apps &amp; integrations</div>
              </div>
            </div>
            <ExternalLink size={14} color="var(--mobile-text-muted)" />
          </a>
        </div>
      </div>

      {/* ── 5. Quick Actions & Preferences ── */}
      <div className="mobile-stat-card">
        <div className="mobile-stat-header">
          <span style={{ color: 'var(--mobile-text)' }}>Preferences & Settings</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={toggleAudio}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              background: 'var(--mobile-bg)',
              borderRadius: 10,
              border: '1px solid var(--mobile-border)',
              color: 'var(--mobile-text)',
              cursor: 'pointer'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {audioEnabled ? <Volume2 size={16} color="var(--mobile-accent)" /> : <VolumeX size={16} color="var(--mobile-text-muted)" />}
              <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>Detection Sound Alerts</span>
            </div>
            <span style={{ fontSize: '0.72rem', color: audioEnabled ? 'var(--mobile-accent)' : 'var(--mobile-text-muted)', fontWeight: 600 }}>
              {audioEnabled ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            onClick={onSwitchToDesktop}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              background: 'var(--mobile-bg)',
              borderRadius: 10,
              border: '1px solid var(--mobile-border)',
              color: 'var(--mobile-text)',
              cursor: 'pointer'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Monitor size={16} color="var(--mobile-accent)" />
              <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>Switch to Desktop View</span>
            </div>
            <span style={{ fontSize: '0.72rem', color: 'var(--mobile-text-muted)' }}>Desktop NOC &rarr;</span>
          </button>

          <button
            onClick={onLogout}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              background: 'rgba(255, 71, 87, 0.08)',
              borderRadius: 10,
              border: '1px solid rgba(255, 71, 87, 0.25)',
              color: 'var(--mobile-danger)',
              cursor: 'pointer',
              marginTop: 4
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <LogOut size={16} />
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Logout</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
