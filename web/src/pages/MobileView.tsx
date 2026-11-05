import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { 
  Video, PlaySquare, Bell, HardDrive, Shield, Volume2, 
  VolumeX, Bot, Monitor, X, Send 
} from 'lucide-react';
import { apiUrl } from '../lib/endpoints';
import { audioAlerts } from '../lib/audioAlerts';
import { setViewPreference, isMobileDevice } from '../lib/mobileDetect';
import { MobileLive } from './mobile/MobileLive';
import { MobilePlayback } from './mobile/MobilePlayback';
import { MobileEvents } from './mobile/MobileEvents';
import { MobileSystem } from './mobile/MobileSystem';

interface MobileViewProps {
  onLogout: () => void;
}

export const MobileView: React.FC<MobileViewProps> = ({ onLogout }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const tabParam = searchParams.get('tab') as 'live' | 'playback' | 'events' | 'system' | null;
  const initialCamParam = searchParams.get('camera') || undefined;
  const initialTimeParam = searchParams.get('time') || undefined;

  const [activeTab, setActiveTab] = useState<'live' | 'playback' | 'events' | 'system'>(
    tabParam && ['live', 'playback', 'events', 'system'].includes(tabParam) ? tabParam : 'live'
  );

  const [selectedCameraId, setSelectedCameraId] = useState<string | undefined>(initialCamParam);
  const [selectedTime, setSelectedTime] = useState<string | undefined>(initialTimeParam);

  const [cameras, setCameras] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [audioEnabled, setAudioEnabled] = useState(() => audioAlerts.isEnabled());
  const [showAIDrawer, setShowAIDrawer] = useState(false);
  const [showPreviewBanner, setShowPreviewBanner] = useState(() => !isMobileDevice());

  // AI Operator chat state
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([
    { role: 'assistant', text: 'Sentinel Operator online. You can ask for status, recent detections, or camera information.' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  // Sync tab with URL search parameter
  useEffect(() => {
    if (tabParam && tabParam !== activeTab) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  const changeTab = (tab: 'live' | 'playback' | 'events' | 'system') => {
    setActiveTab(tab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  const loadCameras = async () => {
    try {
      const res = await fetch(apiUrl('/cameras'));
      if (res.ok) {
        const data = await res.json();
        setCameras(Array.isArray(data) ? data : []);
      }
    } catch {}
  };

  const loadEvents = async () => {
    try {
      const res = await fetch(apiUrl('/events?limit=25'));
      if (res.ok) {
        const data = await res.json();
        setEvents(Array.isArray(data) ? data : []);
      }
    } catch {}
  };

  useEffect(() => {
    loadCameras();
    loadEvents();

    let eventsSource: EventSource | null = null;
    let reconnectTimeout: number | undefined;
    let sseActive = true;

    const connectSSE = () => {
      if (!sseActive) return;
      try {
        eventsSource = new EventSource(apiUrl('/system/live'));
        eventsSource.onmessage = (msg) => {
          try {
            const ev = JSON.parse(msg.data);
            if (ev.type === 'snapshot' && ev.data?.cameras) {
              setCameras(Array.isArray(ev.data.cameras) ? ev.data.cameras : []);
            } else if (ev.type === 'ai_event') {
              if (audioAlerts.isEnabled()) {
                audioAlerts.playChime(ev.data?.threat_level === 'HIGH' ? 'threat' : 'info');
              }
              loadCameras();
              loadEvents();
            } else if (ev.type === 'camera_status') {
              loadCameras();
            }
          } catch {}
        };
        eventsSource.onerror = () => {
          if (eventsSource) {
            eventsSource.close();
            eventsSource = null;
          }
          if (sseActive) {
            reconnectTimeout = window.setTimeout(connectSSE, 5000);
          }
        };
      } catch {
        if (sseActive) {
          reconnectTimeout = window.setTimeout(connectSSE, 5000);
        }
      }
    };

    connectSSE();
    const fallbackPoll = setInterval(loadCameras, 15000);

    return () => {
      sseActive = false;
      if (eventsSource) eventsSource.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      clearInterval(fallbackPoll);
    };
  }, []);

  const handleSelectCameraForPlayback = (cameraId: string, time?: string) => {
    setSelectedCameraId(cameraId);
    setSelectedTime(time);
    changeTab('playback');
  };

  const handleSelectEventForPlayback = (cameraId: string, timestamp: string) => {
    setSelectedCameraId(cameraId);
    setSelectedTime(timestamp);
    changeTab('playback');
  };

  const toggleAudio = () => {
    const next = audioAlerts.toggle();
    audioAlerts.playChime('info');
    setAudioEnabled(next);
  };

  const handleSwitchToDesktop = () => {
    setViewPreference('desktop');
    navigate('/dashboard');
  };

  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;
    const msg = chatInput.trim();
    setChatMessages(prev => [...prev, { role: 'user', text: msg }]);
    setChatInput('');
    setChatLoading(true);

    try {
      const res = await fetch(apiUrl('/agent/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          history: chatMessages.map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            content: m.text
          }))
        })
      });
      if (res.ok) {
        const data = await res.json();
        setChatMessages(prev => [...prev, { role: 'assistant', text: data.response || data.reply || data.message || 'Action executed.' }]);
      } else {
        setChatMessages(prev => [...prev, { role: 'assistant', text: 'Unable to reach Sentinel Operator service.' }]);
      }
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', text: 'Network error connecting to operator.' }]);
    } finally {
      setChatLoading(false);
    }
  };

  const onlineCamerasCount = cameras.filter(c => c.status !== 'offline').length;

  return (
    <div className="mobile-app">
      {/* Desktop Preview Banner (shown when testing on large displays) */}
      {showPreviewBanner && (
        <div className="mobile-preview-banner">
          <span>Viewing Dedicated Mobile Interface</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={handleSwitchToDesktop}
              style={{
                background: 'rgba(0, 210, 255, 0.15)',
                border: '1px solid rgba(0, 210, 255, 0.3)',
                color: 'var(--mobile-accent)',
                borderRadius: 6,
                padding: '2px 8px',
                fontSize: '0.7rem',
                cursor: 'pointer'
              }}
            >
              Switch to Desktop
            </button>
            <button
              onClick={() => setShowPreviewBanner(false)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--mobile-text-muted)',
                cursor: 'pointer',
                padding: '0 4px',
                fontSize: '0.8rem'
              }}
              title="Dismiss banner"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* ── Top Header ── */}
      <header className="mobile-header">
        <div className="mobile-brand">
          <div className="mobile-logo-icon">
            <Shield size={18} />
          </div>
          <div>
            <div className="mobile-title">
              Sentinel
              <span className="mobile-status-pill">
                <span className="mobile-dot online" />
                {onlineCamerasCount} Online
              </span>
            </div>
          </div>
        </div>

        <div className="mobile-header-actions">
          <button
            className="mobile-btn-icon"
            onClick={toggleAudio}
            title={audioEnabled ? 'Mute alert sounds' : 'Enable alert sounds'}
          >
            {audioEnabled ? <Volume2 size={16} color="var(--mobile-accent)" /> : <VolumeX size={16} color="var(--mobile-text-muted)" />}
          </button>

          <button
            className="mobile-btn-icon"
            onClick={() => setShowAIDrawer(true)}
            title="Open AI Operator"
          >
            <Bot size={16} color="var(--pink, #ff79c6)" />
          </button>

          <button
            className="mobile-btn-icon"
            onClick={handleSwitchToDesktop}
            title="Switch to Desktop View"
          >
            <Monitor size={16} color="var(--mobile-text-muted)" />
          </button>
        </div>
      </header>

      {/* ── Main Content Area ── */}
      <main className="mobile-content">
        {activeTab === 'live' && (
          <MobileLive
            cameras={cameras}
            events={events}
            onSelectCameraForPlayback={handleSelectCameraForPlayback}
            onRefresh={loadCameras}
            onViewAllEvents={() => changeTab('events')}
          />
        )}

        {activeTab === 'playback' && (
          <MobilePlayback
            cameras={cameras}
            initialCameraId={selectedCameraId}
            initialTime={selectedTime}
          />
        )}

        {activeTab === 'events' && (
          <MobileEvents
            cameras={cameras}
            onSelectEventForPlayback={handleSelectEventForPlayback}
          />
        )}

        {activeTab === 'system' && (
          <MobileSystem
            onSwitchToDesktop={handleSwitchToDesktop}
            onLogout={onLogout}
          />
        )}
      </main>

      {/* ── Bottom Navigation Tabs ── */}
      <nav className="mobile-nav-bar">
        <button
          className={`mobile-nav-item ${activeTab === 'live' ? 'active' : ''}`}
          onClick={() => changeTab('live')}
        >
          <Video size={19} />
          <span>Live</span>
        </button>

        <button
          className={`mobile-nav-item ${activeTab === 'playback' ? 'active' : ''}`}
          onClick={() => changeTab('playback')}
        >
          <PlaySquare size={19} />
          <span>Playback</span>
        </button>

        <button
          className={`mobile-nav-item ${activeTab === 'events' ? 'active' : ''}`}
          onClick={() => changeTab('events')}
        >
          <Bell size={19} />
          <span>Events</span>
        </button>

        <button
          className={`mobile-nav-item ${activeTab === 'system' ? 'active' : ''}`}
          onClick={() => changeTab('system')}
        >
          <HardDrive size={19} />
          <span>System</span>
        </button>
      </nav>

      {/* ── AI Operator Bottom Sheet Drawer ── */}
      {showAIDrawer && (
        <div className="mobile-ai-overlay" onClick={() => setShowAIDrawer(false)}>
          <div className="mobile-ai-sheet" onClick={e => e.stopPropagation()}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px',
              borderBottom: '1px solid var(--mobile-border)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Bot size={18} color="var(--pink, #ff79c6)" />
                <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Sentinel AI Operator</span>
              </div>
              <button
                onClick={() => setShowAIDrawer(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--mobile-text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    background: msg.role === 'user' ? '#252b36' : 'var(--mobile-surface)',
                    border: '1px solid var(--mobile-border)',
                    borderRadius: 12,
                    padding: '8px 12px',
                    fontSize: '0.78rem',
                    lineHeight: 1.4,
                    color: 'var(--mobile-text)'
                  }}
                >
                  {msg.text}
                </div>
              ))}
              {chatLoading && (
                <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--mobile-text-muted)' }}>
                  <div className="spinner" style={{ width: 12, height: 12 }} />
                  Operator typing...
                </div>
              )}
            </div>

            <form onSubmit={handleSendChatMessage} style={{ padding: '10px 14px', borderTop: '1px solid var(--mobile-border)', display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="Ask Sentinel AI..."
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                style={{
                  flex: 1,
                  background: 'var(--mobile-bg)',
                  border: '1px solid var(--mobile-border)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  color: 'var(--mobile-text)',
                  fontSize: '0.78rem',
                  outline: 'none'
                }}
              />
              <button
                type="submit"
                disabled={chatLoading}
                style={{
                  background: 'var(--mobile-accent)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 12px',
                  color: '#000',
                  cursor: 'pointer'
                }}
              >
                <Send size={14} />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default MobileView;
