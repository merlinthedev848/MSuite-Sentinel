import React, { Suspense, lazy, useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Video, PlaySquare, Bell, Settings as SettingsIcon, ShieldCheck, HardDrive, LogOut, Wifi, LayoutDashboard, Map, Bot, Send, X, Volume2, VolumeX, Tv, Smartphone } from 'lucide-react';

import Login     from './pages/Login';
import { apiUrl } from './lib/endpoints';
import { audioAlerts } from './lib/audioAlerts';
import { shouldUseMobileView, setViewPreference } from './lib/mobileDetect';
import './mobile.css';

const LiveView = lazy(() => import('./pages/LiveView'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const MapView = lazy(() => import('./pages/MapView'));
const Playback = lazy(() => import('./pages/Playback'));
const Events = lazy(() => import('./pages/Events'));
const Operations = lazy(() => import('./pages/Operations'));
const Settings = lazy(() => import('./pages/Settings'));
const Wallboard = lazy(() => import('./pages/Wallboard'));
const MobileView = lazy(() => import('./pages/MobileView'));

try {
  localStorage.removeItem('mview_token');
} catch {
  /* storage can be blocked; the cookie is the session */
}

const originalFetch = window.fetch;
window.fetch = async (...args) => {
  const [resource, config] = args;
  const nextConfig: RequestInit = { ...(config || {}) };
  if (!nextConfig.credentials) nextConfig.credentials = 'same-origin';
  const url = typeof resource === 'string' ? resource : '';
  const res = await originalFetch(resource, nextConfig);
  const sessionProbe = url.includes('/auth/login') || url.includes('/auth/me') || url.includes('/auth/logout');
  if (res.status === 401 && url && !sessionProbe) {
    try { localStorage.removeItem('mview_token'); } catch { /* ignore */ }
    window.dispatchEvent(new Event('sentinel-unauthorized'));
  }
  return res;
};

const Sidebar = ({ onLogout, onToggleAI, showAIActive }: { onLogout: () => void; onToggleAI: () => void; showAIActive: boolean }) => {
  const navigate = useNavigate();
  const [cameras, setCameras] = useState<any[]>([]);
  const [events,  setEvents]  = useState<any[]>([]);
  const [storage, setStorage] = useState<any>(null);
  const [recordingStorage, setRecordingStorage] = useState<any>(null);
  const [systemStats, setSystemStats] = useState({ cpu: '--', up: '0.00', down: '0.00', latency: '--', network: '--', codec: '--' });
  const [audioEnabled, setAudioEnabled] = useState(() => audioAlerts.isEnabled());

  useEffect(() => {
    const applySnapshot = (snapshot: any) => {
      if (!snapshot) return;
      if (Array.isArray(snapshot.cameras) && snapshot.cameras.length > 0) {
        setCameras(snapshot.cameras);
      } else if (Array.isArray(snapshot.cameras)) {
        setCameras(prev => (prev.length > 0 ? prev : snapshot.cameras));
      }
      if (Array.isArray(snapshot.events) && snapshot.events.length > 0) {
        setEvents(snapshot.events);
      }
      if (snapshot.recording_storage) {
        setRecordingStorage(snapshot.recording_storage);
      }
      const h = snapshot.health;
      if (h) {
        if (h.storage) setStorage(h.storage);
        setSystemStats(prev => ({
          cpu: typeof h.cpu_usage_percent === 'number' ? h.cpu_usage_percent.toFixed(1) : prev.cpu,
          up: typeof h.network?.up_mbps === 'number' ? h.network.up_mbps.toFixed(2) : prev.up,
          down: typeof h.network?.down_mbps === 'number' ? h.network.down_mbps.toFixed(2) : prev.down,
          latency: typeof h.latency_ms === 'number' ? `${h.latency_ms}` : prev.latency,
          network: h.status === 'online' ? 'OK' : (h.status ? 'DEGRADED' : prev.network),
          codec: h.record_codec || prev.codec,
        }));
      }
    };

    const load = () => {
      const started = performance.now();

      // 1. Health & Server Telemetry (fastest: populates CPU, Network, Disk immediately)
      fetch(apiUrl('/system/health'))
        .then(r => r.ok ? r.json() : null)
        .then(h => {
          if (h) {
            if (h.storage) setStorage(h.storage);
            setSystemStats(prev => ({
              cpu: typeof h.cpu_usage_percent === 'number' ? h.cpu_usage_percent.toFixed(1) : prev.cpu,
              up: typeof h.network?.up_mbps === 'number' ? h.network.up_mbps.toFixed(2) : prev.up,
              down: typeof h.network?.down_mbps === 'number' ? h.network.down_mbps.toFixed(2) : prev.down,
              latency: `${Math.round(performance.now() - started)}`,
              network: h.status === 'online' ? 'OK' : (h.status ? 'DEGRADED' : prev.network),
              codec: h.record_codec || prev.codec,
            }));
          }
        })
        .catch(() => null);

      // 2. Cameras
      fetch(apiUrl('/cameras'))
        .then(r => r.ok ? r.json() : null)
        .then(c => {
          if (Array.isArray(c) && c.length > 0) setCameras(c);
          else if (Array.isArray(c)) setCameras(prev => (prev.length > 0 ? prev : c));
        })
        .catch(() => null);

      // 3. Events
      fetch(apiUrl('/events?limit=20'))
        .then(r => r.ok ? r.json() : null)
        .then(e => {
          if (Array.isArray(e)) setEvents(e);
        })
        .catch(() => null);

      // 4. Recording Storage
      fetch(apiUrl('/system/storage-report'))
        .then(r => r.ok ? r.json() : null)
        .then(s => {
          if (s) setRecordingStorage(s);
        })
        .catch(() => null);
    };

    // Immediately trigger REST hydration on mount
    load();
    const pollInterval = window.setInterval(load, 10000);

    let eventsSource: EventSource | null = null;
    let reconnectTimeout: number | undefined;
    let sseActive = true;

    const connectSSE = () => {
      if (!sseActive) return;
      if (eventsSource) {
        try { eventsSource.close(); } catch {}
      }
      eventsSource = new EventSource(apiUrl('/system/live'), { withCredentials: true } as EventSourceInit);
      eventsSource.addEventListener('snapshot', (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);
          applySnapshot(message.payload);
        } catch {}
      });
      eventsSource.addEventListener('ai_event', () => {
        audioAlerts.playChime('threat');
      });
      eventsSource.onerror = () => {
        if (!sseActive) return;
        try { eventsSource?.close(); } catch {}
        load();
        window.clearTimeout(reconnectTimeout);
        reconnectTimeout = window.setTimeout(() => {
          if (sseActive) connectSSE();
        }, 5000);
      };
    };

    connectSSE();

    return () => {
      sseActive = false;
      window.clearInterval(pollInterval);
      window.clearTimeout(reconnectTimeout);
      if (eventsSource) {
        try { eventsSource.close(); } catch {}
      }
    };
  }, []);

  const onlineCams = cameras.filter(c => c.status !== 'offline').length;
  const unreadEvents = events.length;

  const navItems = [
    { to: '/dashboard',  label: 'Dashboard',     icon: <LayoutDashboard size={16} />, end: false },
    { to: '/',           label: 'Live View',     icon: <Video           size={16} />, end: true  },
    { to: '/wallboard',  label: 'Wallboard NOC', icon: <Tv              size={16} />, end: false },
    { to: '/map',        label: 'Spatial Map',   icon: <Map             size={16} />, end: false },
    { to: '/playback',   label: 'Playback',      icon: <PlaySquare      size={16} />, end: false },
    { to: '/events',     label: 'Events',        icon: <Bell            size={16} />, end: false, badge: unreadEvents || undefined },
    { to: '/operations', label: 'Operations',    icon: <HardDrive       size={16} />, end: false },
    { to: '/settings',   label: 'Settings',      icon: <SettingsIcon    size={16} />, end: false },
  ];

  return (
    <div className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">
          <ShieldCheck size={17} color="var(--cyan)" strokeWidth={2.5} />
        </div>
        <div>
          <div className="sidebar-logo-title">mView Sentinel</div>
          <div className="sidebar-logo-sub">NVR Platform</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        <div className="nav-section">Navigation</div>

        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {item.icon}
            {item.label}
            {item.badge ? <span className="nav-badge">{item.badge > 99 ? '99+' : item.badge}</span> : null}
          </NavLink>
        ))}

        <button 
          className={`nav-item${showAIActive ? ' active' : ''}`} 
          onClick={onToggleAI}
          style={{ border: 'none', background: 'transparent', textAlign: 'left', width: '100%', cursor: 'pointer', outline: 'none', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <Bot size={16} style={{ color: 'var(--pink)' }} />
          AI Operator
        </button>

        <button 
          className="nav-item"
          onClick={() => {
            const next = audioAlerts.toggle();
            audioAlerts.playChime('info');
            setAudioEnabled(next);
          }}
          style={{ border: 'none', background: 'transparent', textAlign: 'left', width: '100%', cursor: 'pointer', outline: 'none', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          {audioEnabled ? <Volume2 size={16} style={{ color: 'var(--cyan)' }} /> : <VolumeX size={16} style={{ color: 'var(--t3)' }} />}
          Alert Sound: {audioEnabled ? 'ON' : 'OFF'}
        </button>

        <button 
          className="nav-item"
          onClick={() => {
            setViewPreference('mobile');
            navigate('/mobile');
          }}
          style={{ border: 'none', background: 'transparent', textAlign: 'left', width: '100%', cursor: 'pointer', outline: 'none', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <Smartphone size={16} style={{ color: 'var(--cyan)' }} />
          Mobile View
        </button>

        <div className="nav-section">System</div>

        <div style={{ padding: '6px 10px' }}>
          {/* Camera summary */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div className={`dot ${onlineCams > 0 ? 'online' : 'offline'}`} />
              <span style={{ fontSize: '0.78rem', color: 'var(--t1)', fontWeight: 600 }}>Cameras</span>
            </div>
            <span style={{ fontSize: '0.7rem', color: 'var(--t2)' }}>{onlineCams}/{cameras.length}</span>
          </div>

          {/* Network indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Wifi size={13} color="var(--t3)" />
            <span style={{ fontSize: '0.74rem', color: 'var(--t2)' }}>Network</span>
            <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: systemStats.network === 'OK' ? 'var(--green)' : 'var(--t2)' }}>{systemStats.network}</span>
          </div>
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, columnGap: 12, fontSize: '0.72rem', color: 'var(--t3)' }}>
            <span>CPU</span><span style={{ color: 'var(--t2)' }}>{systemStats.cpu !== '--' ? `${systemStats.cpu}%` : '--'}</span>
            <span>Up</span><span style={{ color: 'var(--t2)' }}>{systemStats.up} Mbps</span>
            <span>Down</span><span style={{ color: 'var(--t2)' }}>{systemStats.down} Mbps</span>
            <span>Latency</span><span style={{ color: 'var(--t2)' }}>{systemStats.latency !== '--' ? `${systemStats.latency} ms` : '--'}</span>
            <span>Codec</span><span style={{ color: 'var(--t2)' }}>{systemStats.codec}</span>
          </div>
        </div>
      </nav>

      {/* Storage footer */}
      <div className="sidebar-footer" style={{ padding: '12px', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--t3)', fontWeight: 600, marginBottom: 4, letterSpacing: '0.02em' }}>
          <span>Archive</span>
          <span>{recordingStorage ? `${recordingStorage.total_gb} GB` : (storage ? `${(storage.used_gb ?? (storage.total_gb - storage.free_gb)).toFixed(1)} GB` : '0 GB')}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--t3)', fontWeight: 600, marginBottom: 6, letterSpacing: '0.02em' }}>
          <span>Server disk</span>
          <span>{storage ? `${(storage.used_gb ?? (storage.total_gb - storage.free_gb)).toFixed(1)} GB` : '--'}</span>
        </div>
        
        <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
          <div style={{ width: `${storage ? Math.min(100, Math.max(0, storage.usage_percent)) : 0}%`, height: '100%', background: 'var(--cyan)' }} />
        </div>
        <div style={{ fontSize: '0.6rem', color: 'var(--t3)', textAlign: 'right', fontFamily: 'monospace' }}>
          {storage ? `${storage.usage_percent}% full` : ''}
        </div>

        <button className="nav-item" style={{ color: 'var(--t3)', marginTop: 12 }} onClick={onLogout}>
          <LogOut size={15} /> Logout
        </button>
      </div>
    </div>
  );
};

const AIOperatorDrawer: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<{ role: 'user' | 'model'; content: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, loading]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || loading) return;

    const userMsg = message;
    setMessage('');
    setHistory(prev => [...prev, { role: 'user', content: userMsg }]);
    setLoading(true);

    try {
      const res = await fetch(apiUrl('/agent/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          history: history.map(h => ({ role: h.role, content: h.content }))
        })
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(prev => [...prev, { role: 'model', content: data.response || "No response received." }]);
      } else {
        setHistory(prev => [...prev, { role: 'model', content: "Failed to communicate with AI operator." }]);
      }
    } catch {
      setHistory(prev => [...prev, { role: 'model', content: "Network error occurred." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ai-drawer" style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: '360px',
      background: '#16181c',
      borderLeft: '1px solid var(--border)',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.5)',
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      backdropFilter: 'blur(12px)',
      animation: 'slideIn 0.3s ease'
    }}>
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Bot size={18} color="var(--pink)" />
          <span className="card-title" style={{ fontSize: '0.9rem' }}>Sentinel AI Operator</span>
        </div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer' }}>
          <X size={16} />
        </button>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {history.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--t3)', textAlign: 'center', padding: 20 }}>
            <Bot size={36} color="var(--t3)" strokeWidth={1} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--t2)', marginBottom: 4 }}>System Agent Active</div>
            <div style={{ fontSize: '0.72rem', lineHeight: 1.4 }}>Ask me to check system health, list cameras, rename devices, or adjust video retention.</div>
          </div>
        )}
        {history.map((msg, i) => (
          <div key={i} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            background: msg.role === 'user' ? '#2a2e36' : 'var(--bg-card)',
            color: 'var(--t1)',
            padding: '10px 14px',
            borderRadius: '12px',
            fontSize: '0.78rem',
            lineHeight: 1.4,
            border: '1px solid var(--border)',
            whiteSpace: 'pre-wrap'
          }}>
            {msg.content}
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: 'flex-start', background: 'var(--card-bg)', padding: '10px 14px', borderRadius: '12px', display: 'flex', gap: 4, alignItems: 'center', border: '1px solid var(--border)' }}>
            <div className="spinner" style={{ width: 12, height: 12 }} />
            <span style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>Operator thinking...</span>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} style={{ padding: 15, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
        <input
          className="form-input"
          type="text"
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Command the NVR..."
          style={{ flex: 1, fontSize: '0.78rem' }}
          disabled={loading}
        />
        <button className="btn btn-primary" type="submit" style={{ padding: '8px 12px' }} disabled={loading}>
          <Send size={14} />
        </button>
      </form>
    </div>
  );
};

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; message: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || 'Unexpected UI error' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="empty" style={{ height: '100%', padding: 32 }}>
          <div className="empty-title">View Recovery Required</div>
          <div className="empty-sub">{this.state.message}</div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={() => {
              this.setState({ hasError: false, message: '' });
              window.location.reload();
            }}
          >
            Reload View
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthenticatedShell({ onLogout }: { onLogout: () => void }) {
  const [showAIDrawer, setShowAIDrawer] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const isWallboard = location.pathname === '/wallboard';
  const isMobile = location.pathname.startsWith('/mobile');

  // Auto-detect mobile devices and redirect to /mobile if appropriate
  useEffect(() => {
    if (shouldUseMobileView() && !location.pathname.startsWith('/mobile') && location.pathname !== '/wallboard') {
      let tab = 'live';
      if (location.pathname.includes('playback')) tab = 'playback';
      else if (location.pathname.includes('events')) tab = 'events';
      else if (location.pathname.includes('operations') || location.pathname.includes('settings')) tab = 'system';

      const searchParams = new URLSearchParams(location.search);
      if (!searchParams.has('tab')) {
        searchParams.set('tab', tab);
      }
      navigate(`/mobile?${searchParams.toString()}`, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  if (isMobile) {
    return (
      <AppErrorBoundary>
        <Suspense fallback={<div className="empty">Loading Sentinel Mobile...</div>}>
          <MobileView onLogout={onLogout} />
        </Suspense>
      </AppErrorBoundary>
    );
  }

  if (isWallboard) {
    return (
      <AppErrorBoundary>
        <Suspense fallback={<div className="empty">Loading Wallboard NOC...</div>}>
          <Wallboard />
        </Suspense>
      </AppErrorBoundary>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar onLogout={onLogout} onToggleAI={() => setShowAIDrawer(!showAIDrawer)} showAIActive={showAIDrawer} />
      <div className="main-content">
        <AppErrorBoundary>
          <Suspense fallback={<div className="empty">Loading...</div>}>
            <Routes>
              <Route path="/"           element={<LiveView />}    />
              <Route path="/login"      element={<LiveView />}    />
              <Route path="/dashboard"  element={<Dashboard />}   />
              <Route path="/map"        element={<MapView />}     />
              <Route path="/playback"   element={<Playback />}    />
              <Route path="/events"     element={<Events />}      />
              <Route path="/operations" element={<Operations />}  />
              <Route path="/settings"   element={<Settings />}    />
              <Route path="/wallboard"  element={<Wallboard />}   />
              <Route path="/mobile"     element={<MobileView onLogout={onLogout} />} />
              <Route path="*"           element={<LiveView />}    />
            </Routes>
          </Suspense>
        </AppErrorBoundary>
      </div>
      <AIOperatorDrawer isOpen={showAIDrawer} onClose={() => setShowAIDrawer(false)} />
    </div>
  );
}

function App() {
  const [session, setSession] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/auth/me'))
      .then((res) => {
        if (!cancelled) setSession(res.ok ? 'in' : 'out');
      })
      .catch(() => {
        if (!cancelled) setSession('out');
      });
    const handleUnauthorized = () => setSession('out');
    window.addEventListener('sentinel-unauthorized', handleUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener('sentinel-unauthorized', handleUnauthorized);
    };
  }, []);

  const handleLogin = () => {
    setSession('in');
    window.location.href = '/dashboard';
  };

  const handleLogout = () => {
    fetch(apiUrl('/auth/logout'), { method: 'POST' }).finally(() => {
      setSession('out');
      window.location.href = '/';
    });
  };

  if (session === 'checking') {
    return <div className="empty">Checking session...</div>;
  }

  if (session === 'out') {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <Router>
      <AuthenticatedShell onLogout={handleLogout} />
    </Router>
  );
}

export default App;

