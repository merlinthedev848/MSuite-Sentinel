import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, Camera, HardDrive, Play } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import VideoPlayer from '../components/VideoPlayer';
import { apiUrl } from '../lib/endpoints';

interface DashboardCamera {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'recording';
  has_motion?: boolean;
}

interface DashboardEvent {
  id: string;
  camera_id: string;
  object_class?: string;
  confidence?: number;
  timestamp?: string;
}

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  overflow: 'hidden',
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 16px',
  borderBottom: '1px solid var(--border)',
};

export const Dashboard = () => {
  const [cameras, setCameras] = useState<DashboardCamera[]>([]);
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [storage, setStorage] = useState<{ free_gb: number; total_gb: number; usage_percent: number; used_gb?: number } | null>(null);
  const [recordingStorage, setRecordingStorage] = useState<{ total_gb: number } | null>(null);
  const [systemStatus, setSystemStatus] = useState<string>('online');
  const [stats, setStats] = useState({ total_cameras: 0, online_cameras: 0, events_today: 0 });
  const [analytics, setAnalytics] = useState<{ total_events: number; hourly: { hour: string; count: number }[]; top_classes: { class: string; count: number }[] } | null>(null);

  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    const fetchData = async () => {
      try {
        const [camRes, eventRes, healthRes, analyticsRes, storageRes] = await Promise.all([
          fetch(apiUrl('/cameras')).catch(() => ({ ok: false } as Response)),
          fetch(apiUrl('/events?limit=20&unreviewed_only=true')).catch(() => ({ ok: false } as Response)),
          fetch(apiUrl('/system/health')).catch(() => ({ ok: false } as Response)),
          fetch(apiUrl('/events/analytics')).catch(() => ({ ok: false } as Response)),
          fetch(apiUrl('/system/storage-report')).catch(() => ({ ok: false } as Response)),
        ]);

        if (!active) return;

        if (camRes.ok) {
          const camData = await camRes.json();
          const validCams = Array.isArray(camData) ? camData : [];
          setCameras(validCams);
          setStats(s => ({
            ...s,
            total_cameras: validCams.length,
            online_cameras: validCams.filter(c => c.status === 'online' || c.status === 'recording').length,
          }));
        }

        if (eventRes.ok) {
          const eventData = await eventRes.json();
          const validEvents = Array.isArray(eventData) ? eventData : [];
          setEvents(validEvents);
          setStats(s => ({ ...s, events_today: validEvents.length }));
        }

        if (healthRes.ok) {
          const healthData = await healthRes.json();
          if (healthData && healthData.status) setSystemStatus(healthData.status);
          if (healthData && healthData.storage) setStorage(healthData.storage);
        }

        if (storageRes.ok) {
          const storageData = await storageRes.json();
          if (storageData) setRecordingStorage(storageData);
        }

        if (analyticsRes.ok) {
          const analyticsData = await analyticsRes.json();
          if (analyticsData && typeof analyticsData === 'object') setAnalytics(analyticsData);
        }
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      }
    };

    fetchData();
    const interval = window.setInterval(fetchData, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const cameraNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of cameras) {
      map[c.id] = c.name;
    }
    return map;
  }, [cameras]);

  const chartData = useMemo(() => {
    if (analytics?.hourly && Array.isArray(analytics.hourly) && analytics.hourly.some(h => (h.count || 0) > 0)) {
      return analytics.hourly.map(h => ({ name: h.hour || '--', count: Number(h.count) || 0 }));
    }
    const buckets: Record<string, number> = {};
    for (const event of (Array.isArray(events) ? events : [])) {
      const label = event.object_class || 'other';
      buckets[label] = (buckets[label] || 0) + 1;
    }
    return Object.entries(buckets).map(([name, count]) => ({ name, count }));
  }, [events, analytics]);

  const kpis = [
    {
      label: 'Active Cameras',
      value: stats.total_cameras,
      detail: `${stats.online_cameras} online`,
      icon: Camera,
      tone: 'var(--t2)',
      background: 'rgba(168, 180, 194, 0.10)',
    },
    {
      label: 'AI Events',
      value: stats.events_today,
      detail: 'real-time',
      icon: AlertTriangle,
      tone: 'var(--red)',
      background: 'rgba(197, 139, 132, 0.12)',
    },
    {
      label: 'System Health',
      value: systemStatus === 'online' ? 'OK' : 'Degraded',
      detail: systemStatus,
      icon: Activity,
      tone: systemStatus === 'online' ? 'var(--green)' : 'var(--amber)',
      background: systemStatus === 'online' ? 'rgba(142, 170, 148, 0.12)' : 'rgba(245, 158, 11, 0.12)',
    },
    {
      label: 'NVR Archive Size',
      value: recordingStorage ? `${recordingStorage.total_gb} GB` : (storage ? `${(storage.used_gb ?? (storage.total_gb - storage.free_gb)).toFixed(1)} GB` : '0 GB'),
      detail: storage ? `Server Disk: ${storage.usage_percent}% full` : 'loading',
      icon: HardDrive,
      tone: 'var(--t2)',
      background: 'rgba(183, 174, 166, 0.12)',
    },
  ];

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 28 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minHeight: '100%' }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h1 style={{ fontSize: '1.25rem', lineHeight: 1.2, margin: 0, fontWeight: 600, color: 'var(--t1)' }}>
              mView Sentinel Overview
            </h1>
            <p style={{ color: 'var(--t2)', margin: '6px 0 0', fontSize: '0.88rem' }}>
              System health, live cameras, recording status, and AI alerts
            </p>
          </div>
          <div style={{ color: 'var(--t3)', fontSize: '0.78rem' }}>
            Refreshes every 5s
          </div>
        </header>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(180px, 1fr))', gap: 16 }}>
          {kpis.map(item => {
            const Icon = item.icon;
            return (
              <div key={item.label} style={{ ...panelStyle, padding: 14, display: 'flex', alignItems: 'center', gap: 12, minHeight: 88 }}>
                <div style={{ width: 42, height: 42, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: item.background, color: item.tone, flexShrink: 0 }}>
                  <Icon size={22} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="card-title">{item.label}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6, minWidth: 0 }}>
                    <span style={{ color: 'var(--t1)', fontSize: '1.25rem', fontWeight: 600, lineHeight: 1 }}>{item.value}</span>
                    <span style={{ color: item.tone, fontSize: '0.74rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.detail}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'minmax(520px, 1.65fr) minmax(320px, 0.95fr)', gap: 20, alignItems: 'stretch', flex: 1, minHeight: 0 }}>
          <div style={{ ...panelStyle, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={sectionHeaderStyle}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--t1)', fontSize: '0.95rem', margin: 0 }}>
                <Play size={16} color="var(--cyan)" /> Live Camera Grid
              </h2>
              <span className="badge online">{stats.online_cameras}/{stats.total_cameras}</span>
            </div>

            <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, alignContent: 'start', overflowY: 'auto' }}>
              {cameras.length === 0 ? (
                <div className="empty" style={{ minHeight: 300, gridColumn: '1 / -1' }}>
                  <Camera size={24} />
                  <div className="empty-title">No Cameras Added</div>
                  <div className="empty-sub">Add ONVIF cameras or import an existing NVR from Operations.</div>
                </div>
              ) : (
                cameras.slice(0, 6).map(cam => (
                  <div key={cam.id} style={{ aspectRatio: '16 / 9', minHeight: 210 }}>
                    <VideoPlayer
                      cameraId={cam.id}
                      name={cam.name}
                      status={cam.status}
                      hasMotion={cam.has_motion}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateRows: 'minmax(300px, 1fr) 260px', gap: 20, minHeight: 0 }}>
            <div style={{ ...panelStyle, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={sectionHeaderStyle}>
                <h2 style={{ color: 'var(--t1)', fontSize: '0.95rem', margin: 0 }}>Real-Time Events</h2>
                <span className={`badge ${events.length ? 'recording' : 'offline'}`}>{events.length}</span>
              </div>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
                {events.length === 0 ? (
                  <div className="empty" style={{ minHeight: 220 }}>
                    <AlertTriangle size={22} />
                    <div className="empty-title">Waiting for AI detections</div>
                  </div>
                ) : (
                  events.map(event => (
                    <div 
                      key={event.id} 
                      onClick={() => {
                        if (event.id) {
                          fetch(apiUrl(`/events/${event.id}/review`), { method: 'PATCH' }).catch(console.error);
                          setEvents(e => e.filter(x => x.id !== event.id));
                        }
                        if (event.camera_id) {
                          const timeQuery = event.timestamp ? `&time=${encodeURIComponent(event.timestamp)}` : '';
                          navigate(`/playback?camera=${encodeURIComponent(event.camera_id)}${timeQuery}`);
                        }
                      }}
                      style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: 10, 
                        padding: 10, 
                        borderRadius: 8, 
                        border: '1px solid var(--border)', 
                        background: 'rgba(255,255,255,0.025)',
                        cursor: 'pointer',
                        transition: 'background 0.2s ease'
                      }}
                      onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                      onMouseOut={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.025)'}
                    >
                      <div style={{ width: 48, height: 48, borderRadius: 6, overflow: 'hidden', flexShrink: 0, border: '1px solid var(--border)' }}>
                        <img
                          src={apiUrl(`/events/${event.id}/thumbnail`)}
                          alt=""
                          onLoad={(e) => { e.currentTarget.style.visibility = 'visible'; }}
                          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', visibility: 'visible' }}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                          <strong style={{ color: 'var(--t1)', fontSize: '0.82rem', textTransform: 'capitalize' }}>{event.object_class || 'event'}</strong>
                          <span style={{ color: 'var(--t3)', fontSize: '0.72rem' }}>
                            {event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '--'}
                          </span>
                        </div>
                        <div style={{ color: 'var(--t3)', fontSize: '0.7rem', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cameraNameById[event.camera_id] || `Camera ${event.camera_id.slice(0, 8)}`}
                        </div>
                      </div>
                      <span style={{ color: 'var(--t2)', fontSize: '0.75rem', fontWeight: 600 }}>
                        {Math.round((event.confidence || 0) * 100)}%
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={{ ...panelStyle, display: 'flex', flexDirection: 'column', minHeight: 220 }}>
              <div style={sectionHeaderStyle}>
                <h2 style={{ color: 'var(--t1)', fontSize: '0.95rem', margin: 0 }}>Activity Trend</h2>
              </div>
              <div style={{ flex: 1, minHeight: 160, padding: 12 }}>
                {chartData.length === 0 ? (
                  <div className="empty" style={{ height: '100%', minHeight: 140 }}>
                    <div className="empty-title">No historical trend data</div>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={160} minWidth={100}>
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--cyan)" stopOpacity={0.38} />
                          <stop offset="95%" stopColor="var(--cyan)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Tooltip contentStyle={{ background: 'var(--bg-card)', borderColor: 'var(--border)', borderRadius: 8, color: 'var(--t1)' }} />
                      <Area type="monotone" dataKey="count" stroke="var(--cyan)" fillOpacity={1} fill="url(#colorCount)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default Dashboard;
