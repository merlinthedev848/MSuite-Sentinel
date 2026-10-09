import React, { Suspense, lazy, useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import { Video, PlaySquare, Bell, Settings as SettingsIcon, ShieldCheck, HardDrive, LogOut, Wifi, LayoutDashboard, Map, Bot, Send, X, Volume2, VolumeX } from 'lucide-react';

import Login     from './pages/Login';
import { apiUrl } from './lib/endpoints';
import { audioAlerts } from './lib/audioAlerts';

const LiveView = lazy(() => import('./pages/LiveView'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const MapView = lazy(() => import('./pages/MapView'));
const Playback = lazy(() => import('./pages/Playback'));
const Events = lazy(() => import('./pages/Events'));
const Operations = lazy(() => import('./pages/Operations'));
const Settings = lazy(() => import('./pages/Settings'));
const Wallboard = lazy(() => import('./pages/Wallboard'));

// Setup global fetch interceptor to inject JWT
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  let [resource, config] = args;
  const token = localStorage.getItem('mview_token');
  
  if (token && typeof resource === 'string' && !resource.includes('/auth/login') && !resource.includes('/go2rtc/')) {
     config = config || {};
     config.headers = {
       ...config.headers,
       'Authorization': `Bearer ${token}`
     };
  }
  
  const res = await originalFetch(resource, config);
  
  // If API returns 401 Unauthorized (and not the login endpoint), force logout
  if (res.status === 401 && typeof resource === 'string' && !resource.includes('/auth/login')) {
    localStorage.removeItem('mview_token');
    window.dispatchEvent(new Event('storage')); // Trigger re-render
  }
  
  return res;
};

const Sidebar = ({ onLogout, onToggleAI, showAIActive }: { onLogout: () => void; onToggleAI: () => void; showAIActive: boolean }) => {
  const [cameras, setCameras] = useState<any[]>([]);
  const [events,  setEvents]  = useState<any[]>([]);
  const [storage, setStorage] = useState<any>(null);
  const [recordingStorage, setRecordingStorage] = useState<any>(null);
  const [systemStats, setSystemStats] = useState({ cpu: '--', up: '0.00', down: '0.00', latency: '--' });
  const [audioEnabled, setAudioEnabled] = useState(() => audioAlerts.isEnabled());

  useEffect(() => {
    let fallbackTimer: number | undefined;

    const applySnapshot = (snapshot: any) => {
      const h = snapshot?.health;
      setCameras(Array.isArray(snapshot?.cameras) ? snapshot.cameras : []);
      setEvents(Array.isArray(snapshot?.events) ? snapshot.events : []);
      if (snapshot?.recording_storage) setRecordingStorage(snapshot.recording_storage);
      if (h?.storage) {
        setStorage(h.storage);
        setSystemStats({
          cpu: typeof h.cpu_usage_percent === 'number' ? h.cpu_usage_percent.toFixed(1) : '--',
          up: typeof h.network?.up_mbps === 'number' ? h.network.up_mbps.toFixed(2) : '0.00',
          down: typeof h.network?.down_mbps === 'number' ? h.network.down_mbps.toFixed(2) : '0.00',
          latency: typeof h.latency_ms === 'number' ? `${h.latency_ms}` : '--',
        });
      }
    };

    const load = async () => {
      try {
        const started = performance.now();
        const [c, e, h, s] = await Promise.all([
          fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []),
          fetch(apiUrl('/events?limit=20')).then(r => r.ok ? r.json() : []),
          fetch(apiUrl('/system/health')).then(r => r.ok ? r.json() : null),
          fetch(apiUrl('/system/storage-report')).then(r => r.ok ? r.json() : null),
        ]);
        setCameras(c);
        setEvents(e);
        if (s) setRecordingStorage(s);
        if (h && h.storage) {
          setStorage(h.storage);
          setSystemStats({
            cpu: typeof h.cpu_usage_percent === 'number' ? h.cpu_usage_percent.toFixed(1) : '--',
            up: typeof h.network?.up_mbps === 'number' ? h.network.up_mbps.toFixed(2) : '0.00',
            down: typeof h.network?.down_mbps === 'number' ? h.network.down_mbps.toFixed(2) : '0.00',
            latency: `${Math.round(performance.now() - started)}`,
          });
        }
      } catch {}
    };

    const token = localStorage.getItem('mview_token');
    const liveUrl = apiUrl(`/system/live${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    const eventsSource = new EventSource(liveUrl);

    const handleSnapshot = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ai_event') {
          audioAlerts.playChime('threat');
        }
        applySnapshot(message.payload);
      } catch {}
    };

    eventsSource.addEventListener('snapshot', handleSnapshot);
    eventsSource.onerror = () => {
      eventsSource.close();
      load();
      fallbackTimer = window.setInterval(load, 15000);
    };

    return () => {
      eventsSource.close();
      if (fallbackTimer) window.clearInterval(fallbackTimer);
    };
  }, []);

  const onlineCams = cameras.filter(c => c.status !== 'offline').length;
  const unreadEvents = events.length;

  const navItems = [
    { to: '/dashboard',  label: 'Dashboard',   icon: <LayoutDashboard size={16} />, end: false },
    { to: '/',           label: 'Live View',   icon: <Video           size={16} />, end: true  },
    { to: '/map',        label: 'Spatial Map', icon: <Map             size={16} />, end: false },
    { to: '/playback',   label: 'Playback',    icon: <PlaySquare      size={16} />, end: false },
    { to: '/events',     label: 'Events',      icon: <Bell            size={16} />, end: false, badge: unreadEvents || undefined },
    { to: '/operations', label: 'Operations',  icon: <HardDrive       size={16} />, end: false },
    { to: '/settings',   label: 'Settings',    icon: <SettingsIcon    size={16} />, end: false },
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
            <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--green)' }}>OK</span>
          </div>
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 4, columnGap: 8, fontSize: '0.66rem', color: 'var(--t3)', fontFamily: 'JetBrains Mono, monospace' }}>
            <span>CPU</span><span style={{ color: 'var(--t2)' }}>{systemStats.cpu}%</span>
            <span>Up</span><span style={{ color: 'var(--cyan)' }}>{systemStats.up} Mbps</span>
            <span>Down</span><span style={{ color: 'var(--cyan)' }}>{systemStats.down} Mbps</span>
            <span>Latency</span><span style={{ color: 'var(--t2)' }}>{systemStats.latency} ms</span>
            <span>Codec</span><span style={{ color: 'var(--green)' }}>H.264</span>
          </div>
        </div>
      </nav>

      {/* Storage footer */}
      <div className="sidebar-footer" style={{ padding: '12px', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--t3)', fontWeight: 600, marginBottom: 4, letterSpacing: '0.02em' }}>
          <span>NVR ARCHIVE</span>
          <span>{recordingStorage ? `${recordingStorage.total_gb} GB` : '0 GB'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--t3)', fontWeight: 600, marginBottom: 6, letterSpacing: '0.02em' }}>
          <span>SERVER DISK</span>
          <span>{storage ? `${(storage.total_gb - storage.free_gb).toFixed(1)} GB` : '--'}</span>
        </div>
        
        <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
          <div style={{ width: `${storage ? storage.usage_percent : 0}%`, height: '100%', background: 'var(--cyan)' }} />
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
      background: 'rgba(13, 21, 32, 0.96)',
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
            background: msg.role === 'user' ? 'var(--cyan-dim)' : 'var(--card-bg)',
            color: msg.role === 'user' ? 'var(--cyan)' : 'var(--t1)',
            padding: '10px 14px',
            borderRadius: '12px',
            fontSize: '0.78rem',
            lineHeight: 1.4,
            border: '1px solid ' + (msg.role === 'user' ? 'var(--cyan-dim)' : 'var(--border)'),
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

function App() {
  const [token, setToken] = useState(localStorage.getItem('mview_token'));

  useEffect(() => {
    const handleStorage = () => {
      setToken(localStorage.getItem('mview_token'));
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const handleLogin = (t: string) => {
    localStorage.setItem('mview_token', t);
    setToken(t);
    window.location.href = '/dashboard';
  };

  const handleLogout = () => {
    localStorage.removeItem('mview_token');
    setToken(null);
    window.location.href = '/';
  };

  if (!token) {
    return <Login onLogin={handleLogin} />;
  }

  if (window.location.pathname === '/wallboard') {
    return (
      <Router>
        <Suspense fallback={<div className="empty">Loading...</div>}>
          <Wallboard />
        </Suspense>
      </Router>
    );
  }

  const [showAIDrawer, setShowAIDrawer] = useState(false);

  return (
    <Router>
      <div className="app-shell">
        <Sidebar onLogout={handleLogout} onToggleAI={() => setShowAIDrawer(!showAIDrawer)} showAIActive={showAIDrawer} />
        <div className="main-content">
          <Suspense fallback={<div className="empty">Loading...</div>}>
            <Routes>
              <Route path="/"           element={<LiveView />}    />
              <Route path="/dashboard"  element={<Dashboard />}   />
              <Route path="/map"        element={<MapView />}     />
              <Route path="/playback"   element={<Playback />}    />
              <Route path="/events"     element={<Events />}      />
              <Route path="/operations" element={<Operations />}  />
              <Route path="/settings"   element={<Settings />}    />
            </Routes>
          </Suspense>
        </div>
        <AIOperatorDrawer isOpen={showAIDrawer} onClose={() => setShowAIDrawer(false)} />
      </div>
    </Router>
  );
}

export default App;
