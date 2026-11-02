import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Search, Sparkles, X, Play, Camera as CamIcon } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

const Events: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [classFilter, setClassFilter] = useState<string>('all');
  const navigate = useNavigate();

  const loadEvents = async () => {
    try {
      const res = await fetch(apiUrl('/events?limit=200'));
      if (res.ok) setEvents(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    fetch(apiUrl('/cameras'))
      .then(r => (r.ok ? r.json() : []))
      .then(data => {
        if (Array.isArray(data)) setCameras(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (searchQuery.trim() !== '') return;
    loadEvents();
    const t = setInterval(loadEvents, 5000);
    return () => clearInterval(t);
  }, [searchQuery]);

  const cameraNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of cameras) {
      map[c.id] = c.name;
    }
    return map;
  }, [cameras]);

  const handleVectorSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      loadEvents();
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(apiUrl('/events/search'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      if (res.ok) {
        const body = await res.json();
        setEvents(Array.isArray(body) ? body : (body.results || []));
      } else {
        const err = await res.json().catch(() => ({}));
        console.warn('Vector search returned error:', err);
      }
    } catch (err) {
      console.error('Vector search network error:', err);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    loadEvents();
  };

  const filteredEvents = useMemo(() => {
    if (classFilter === 'all') return events;
    return events.filter(ev => {
      const cls = (ev.object_class ?? ev.event_type ?? '').toLowerCase();
      if (classFilter === 'vehicle') {
        return ['vehicle', 'car', 'truck', 'bus', 'motorcycle', 'bicycle'].includes(cls);
      }
      return cls === classFilter;
    });
  }, [events, classFilter]);

  const typeColor = (cls: string) => {
    if (!cls) return 'var(--t3)';
    if (cls === 'person') return 'var(--cyan)';
    if (cls === 'vehicle' || cls === 'car' || cls === 'truck') return 'var(--pink)';
    return 'var(--amber)';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="topbar" style={{ justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--t1)', margin: 0 }}>Event Log</h1>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'person', 'vehicle', 'motion'] as const).map(filter => (
              <button
                key={filter}
                type="button"
                className={`btn ${classFilter === filter ? 'btn-primary' : 'btn-ghost'}`}
                style={{ height: 26, padding: '0 10px', fontSize: '0.72rem', textTransform: 'capitalize' }}
                onClick={() => setClassFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleVectorSearch} style={{ display: 'flex', gap: 8, flex: 1, maxWidth: 460 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              className="form-input"
              style={{ paddingLeft: 34, paddingRight: searchQuery ? 28 : 10, height: 32, fontSize: '0.78rem' }}
              placeholder="Keyword search (e.g. person or car)..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <Sparkles size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--cyan)' }} />
            {searchQuery && (
              <button
                type="button"
                onClick={clearSearch}
                title="Clear search"
                style={{
                  position: 'absolute',
                  right: 6,
                  top: 6,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--t3)',
                  cursor: 'pointer',
                  padding: 2,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button type="submit" className="btn btn-primary" style={{ height: 32, padding: '0 12px', fontSize: '0.75rem' }} disabled={searching}>
            <Search size={14} /> {searching ? 'Searching...' : 'Search'}
          </button>
        </form>

        <span style={{ fontSize: '0.76rem', color: 'var(--t2)' }}>{filteredEvents.length} events</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
        {loading ? (
          <div className="empty"><div className="spinner" /></div>
        ) : filteredEvents.length === 0 ? (
          <div className="empty">
            <Bell size={38} strokeWidth={1} color="var(--t3)" />
            <div className="empty-title">No Events Found</div>
            <div className="empty-sub">No logged events match your current vector search query or filter.</div>
          </div>
        ) : (
          <div className="card">
            {filteredEvents.map((ev: any, i) => {
              const camName = ev.camera_id ? (cameraNameById[ev.camera_id] || `Camera ${ev.camera_id.slice(0, 8)}…`) : 'Unknown Camera';
              return (
                <div
                  key={ev.id ?? i}
                  className="cam-row"
                  onClick={() => {
                    if (ev.id) {
                      fetch(apiUrl(`/events/${ev.id}/review`), { method: 'PATCH' }).catch(() => {});
                    }
                    if (ev.camera_id && ev.timestamp) {
                      navigate(`/playback?camera=${ev.camera_id}&time=${ev.timestamp}`);
                    }
                  }}
                  style={{ cursor: ev.camera_id ? 'pointer' : 'default' }}
                  title="Click to jump to event playback"
                >
                  <div
                    style={{
                      width: 44,
                      height: 32,
                      borderRadius: 6,
                      overflow: 'hidden',
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      position: 'relative',
                    }}
                  >
                    <CamIcon size={13} color="var(--t3)" />
                    {ev.id && (
                      <img
                        src={apiUrl(`/events/${ev.id}/thumbnail`)}
                        alt=""
                        onError={e => { e.currentTarget.style.display = 'none'; }}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                  </div>
                  <div
                    className="event-dot"
                    style={{ background: typeColor(ev.object_class) }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: '0.84rem', textTransform: 'capitalize', color: 'var(--t1)' }}>
                      {ev.object_class ?? ev.event_type ?? 'Event'}
                    </span>
                    <span style={{ fontSize: '0.74rem', color: 'var(--t2)', marginLeft: 10 }}>
                      {camName}
                    </span>
                  </div>
                  {ev.match_score != null && (
                    <span style={{
                      fontSize: '0.72rem', padding: '2px 9px', borderRadius: 20,
                      background: 'var(--green-dim)', color: 'var(--green)',
                      border: '1px solid transparent', marginRight: 6
                    }}>
                      {Math.round(ev.match_score * 100)}% label match
                    </span>
                  )}
                  {ev.confidence != null && (
                    <span style={{
                      fontSize: '0.72rem', padding: '2px 9px', borderRadius: 20,
                      background: 'var(--cyan-dim)', color: 'var(--cyan)',
                      border: '1px solid var(--cyan-border)',
                    }}>
                      {Math.round(ev.confidence * 100)}% Conf
                    </span>
                  )}
                  <span style={{ fontSize: '0.7rem', fontFamily: 'JetBrains Mono, monospace', color: 'var(--t3)', marginLeft: 8 }}>
                    {new Date(ev.timestamp ?? ev.created_at).toLocaleString('en-GB', {
                      day: '2-digit', month: 'short',
                      hour: '2-digit', minute: '2-digit', second: '2-digit'
                    })}
                  </span>
                  {ev.camera_id && (
                    <Play size={13} color="var(--cyan)" style={{ marginLeft: 6, opacity: 0.75, flexShrink: 0 }} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default Events;
