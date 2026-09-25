import React, { useState, useEffect } from 'react';
import { Bell, Search, Sparkles } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

const Events: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const loadEvents = async () => {
    try {
      const res = await fetch(apiUrl('/events?limit=200'));
      if (res.ok) setEvents(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    if (searchQuery.trim() !== '') return;
    loadEvents();
    const t = setInterval(loadEvents, 5000);
    return () => clearInterval(t);
  }, [searchQuery]);

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
        setEvents(await res.json());
      }
    } catch {}
    setSearching(false);
  };

  const typeColor = (cls: string) => {
    if (!cls) return 'var(--t3)';
    if (cls === 'person') return 'var(--cyan)';
    if (cls === 'vehicle' || cls === 'car') return 'var(--pink)';
    return 'var(--amber)';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="topbar" style={{ justifyContent: 'space-between', gap: 16 }}>
        <h1 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--t1)' }}>Event Log</h1>
        
        <form onSubmit={handleVectorSearch} style={{ display: 'flex', gap: 8, flex: 1, maxWidth: 450 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              className="form-input"
              style={{ paddingLeft: 34, height: 32, fontSize: '0.78rem' }}
              placeholder="AI Vector Search (e.g. 'person in red jacket' or 'car')..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <Sparkles size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--cyan)' }} />
          </div>
          <button type="submit" className="btn btn-primary" style={{ height: 32, padding: '0 12px', fontSize: '0.75rem' }} disabled={searching}>
            <Search size={14} /> {searching ? 'Searching...' : 'Search'}
          </button>
        </form>

        <span style={{ fontSize: '0.76rem', color: 'var(--t2)' }}>{events.length} events</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
        {loading ? (
          <div className="empty"><div className="spinner" /></div>
        ) : events.length === 0 ? (
          <div className="empty">
            <Bell size={38} strokeWidth={1} color="var(--t3)" />
            <div className="empty-title">No Events Found</div>
            <div className="empty-sub">No logged events match your current vector search query or filter.</div>
          </div>
        ) : (
          <div className="card">
            {events.map((ev: any, i) => (
              <div key={ev.id ?? i} className="cam-row">
                <div className="event-dot"
                  style={{ background: typeColor(ev.object_class), boxShadow: `0 0 6px ${typeColor(ev.object_class)}` }}
                />
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontSize: '0.84rem', textTransform: 'capitalize' }}>
                    {ev.object_class ?? ev.event_type ?? 'Event'}
                  </span>
                  {ev.camera_id && (
                    <span style={{ fontSize: '0.74rem', color: 'var(--t2)', marginLeft: 10 }}>
                      Camera {ev.camera_id.slice(0, 8)}…
                    </span>
                  )}
                </div>
                {ev.match_score != null && (
                  <span style={{
                    fontSize: '0.72rem', padding: '2px 9px', borderRadius: 20,
                    background: 'rgba(16, 185, 129, 0.15)', color: '#10b981',
                    border: '1px solid rgba(16, 185, 129, 0.3)', marginRight: 6
                  }}>
                    {Math.round(ev.match_score * 100)}% Vector Match
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Events;
