import React, { useState, useEffect } from 'react';
import { Bell, Search, Play, Camera as CamIcon, RefreshCw, Download } from 'lucide-react';
import { apiUrl } from '../../lib/endpoints';

interface Camera {
  id: string;
  name: string;
}

interface MobileEventsProps {
  cameras: Camera[];
  onSelectEventForPlayback: (cameraId: string, timestamp: string) => void;
}

export const MobileEvents: React.FC<MobileEventsProps> = ({
  cameras,
  onSelectEventForPlayback,
}) => {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'person' | 'vehicle' | 'motion'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [exportingEventId, setExportingEventId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(30);

  const handleExportEvent = async (e: React.MouseEvent, ev: any) => {
    e.stopPropagation();
    if (!ev.camera_id || !ev.timestamp) return;
    setExportingEventId(ev.id);

    try {
      const centerMs = new Date(ev.timestamp).getTime();
      const startMs = centerMs - 45 * 1000;
      const endMs = centerMs + 45 * 1000;

      const res = await fetch(apiUrl('/recordings-list/export'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_id: ev.camera_id,
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString(),
          reason: `Event clip ${ev.object_class || 'detection'}`
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.download_url) {
          const downloadParam = data.download_url.includes('?') ? `${data.download_url}&download=1` : `${data.download_url}?download=1`;
          const fullUrl = apiUrl(downloadParam);
          const link = document.createElement('a');
          link.href = fullUrl;
          link.download = data.filename || `event_${ev.id}.mp4`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      }
    } catch (err) {
      console.error('Failed to export event clip', err);
    } finally {
      setExportingEventId(null);
    }
  };

  const cameraMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of cameras) {
      map[c.id] = c.name;
    }
    return map;
  }, [cameras]);

  const loadEvents = async () => {
    try {
      const res = await fetch(apiUrl('/events?limit=300'));
      if (res.ok) {
        setEvents(await res.json());
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvents();
    const interval = setInterval(loadEvents, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadEvents();
    setTimeout(() => setRefreshing(false), 500);
  };

  const filteredEvents = React.useMemo(() => {
    return events.filter(e => {
      if (activeFilter !== 'all') {
        const cls = (e.object_class || 'motion').toLowerCase();
        if (activeFilter === 'person' && cls !== 'person') return false;
        if (activeFilter === 'vehicle' && !['car', 'vehicle', 'truck', 'bus'].includes(cls)) return false;
        if (activeFilter === 'motion' && cls !== 'motion') return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const camName = (cameraMap[e.camera_id] || '').toLowerCase();
        const cls = (e.object_class || '').toLowerCase();
        const desc = (e.label || e.description || '').toLowerCase();
        return camName.includes(q) || cls.includes(q) || desc.includes(q);
      }
      return true;
    });
  }, [events, activeFilter, searchQuery, cameraMap]);

  const displayedEvents = React.useMemo(() => {
    return filteredEvents.slice(0, visibleCount);
  }, [filteredEvents, visibleCount]);

  const hasMore = visibleCount < filteredEvents.length;

  const formatEventTime = (isoString: string) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleString('en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div>
      {/* Search Input Bar */}
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--mobile-text-muted)' }} />
        <input
          type="text"
          placeholder="Filter events..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--mobile-surface)',
            border: '1px solid var(--mobile-border)',
            borderRadius: 10,
            padding: '8px 12px 8px 34px',
            color: 'var(--mobile-text)',
            fontSize: '0.8rem',
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
      </div>

      {/* Filter Chips Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
          {(['all', 'person', 'vehicle', 'motion'] as const).map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              style={{
                padding: '5px 12px',
                borderRadius: 16,
                fontSize: '0.72rem',
                border: '1px solid var(--mobile-border)',
                background: activeFilter === f ? 'var(--cyan-dim)' : 'var(--mobile-surface)',
                color: activeFilter === f ? 'var(--mobile-accent)' : 'var(--mobile-text-muted)',
                fontWeight: activeFilter === f ? 600 : 400,
                cursor: 'pointer',
                textTransform: 'capitalize'
              }}
            >
              {f}
            </button>
          ))}
        </div>

        <button
          onClick={handleRefresh}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--mobile-text-muted)',
            cursor: 'pointer',
            padding: 4
          }}
          title="Refresh Events"
        >
          <RefreshCw size={14} className={refreshing ? 'spinner' : ''} />
        </button>
      </div>

      {/* Events List */}
      {loading && events.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--mobile-text-muted)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          <div style={{ fontSize: '0.8rem' }}>Loading detection events...</div>
        </div>
      ) : filteredEvents.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--mobile-text-muted)' }}>
          <Bell size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--mobile-text)' }}>No events found</div>
          <div style={{ fontSize: '0.72rem', marginTop: 4 }}>
            {searchQuery ? 'Try clearing your search query' : 'No recent detection events'}
          </div>
        </div>
      ) : (
        <div className="mobile-events-scroll-list">
          {displayedEvents.map((ev: any, idx) => {
            const camName = cameraMap[ev.camera_id] || `Camera ${ev.camera_id || ''}`;
            const cls = (ev.object_class || 'motion').toLowerCase();
            const badgeClass = cls === 'person' 
              ? 'mobile-badge-person' 
              : ['car', 'vehicle', 'truck'].includes(cls) 
              ? 'mobile-badge-vehicle' 
              : 'mobile-badge-motion';

            return (
              <div
                key={ev.id || idx}
                className="mobile-event-card"
                onClick={() => {
                  if (ev.camera_id && ev.timestamp) {
                    onSelectEventForPlayback(ev.camera_id, ev.timestamp);
                  }
                }}
              >
                {/* Thumbnail Preview */}
                <div style={{
                  width: 56,
                  height: 42,
                  borderRadius: 6,
                  overflow: 'hidden',
                  background: '#090a0d',
                  border: '1px solid var(--mobile-border)',
                  position: 'relative',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <CamIcon size={14} color="var(--mobile-text-dim)" />
                  {ev.id && (
                    <img
                      src={apiUrl(`/events/${ev.id}/thumbnail`)}
                      alt=""
                      onError={e => { e.currentTarget.style.display = 'none'; }}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  )}
                </div>

                {/* Event Description */}
                <div className="mobile-event-info" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span className={badgeClass}>{ev.object_class?.split(/[:@]/)[0]?.trim() || 'Motion'}</span>
                    <span style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: 'var(--mobile-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {camName}
                    </span>
                  </div>
                  {ev.object_class?.includes(':') && (
                    <div style={{ fontSize: '0.68rem', color: 'var(--mobile-text-muted)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {ev.object_class.split(':').slice(1).join(':').trim()}
                    </div>
                  )}
                  <span className="mobile-event-time">
                    {formatEventTime(ev.timestamp)}
                  </span>
                </div>

                {/* Actions: Play and Export */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={(e) => handleExportEvent(e, ev)}
                    disabled={exportingEventId === ev.id}
                    title="Export Event Video Clip"
                    style={{
                      background: 'var(--mobile-surface-hover)',
                      border: '1px solid var(--mobile-border)',
                      color: 'var(--mobile-text)',
                      borderRadius: 8,
                      padding: '6px 8px',
                      fontSize: '0.72rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer'
                    }}
                  >
                    {exportingEventId === ev.id ? (
                      <div className="spinner" style={{ width: 12, height: 12 }} />
                    ) : (
                      <Download size={13} color="var(--mobile-accent)" />
                    )}
                  </button>

                  <button
                    style={{
                      background: 'var(--cyan-dim)',
                      border: '1px solid var(--cyan-border)',
                      color: 'var(--mobile-accent)',
                      borderRadius: 8,
                      padding: '6px 10px',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      cursor: 'pointer'
                    }}
                  >
                    <Play size={12} fill="var(--mobile-accent)" /> Play
                  </button>
                </div>
              </div>
            );
          })}

          {hasMore && (
            <button
              onClick={() => setVisibleCount(c => c + 30)}
              className="mobile-ctrl-btn"
              style={{
                margin: '12px auto 0',
                padding: '8px 18px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--mobile-accent)',
                borderColor: 'var(--cyan-border)',
                fontSize: '0.75rem',
                cursor: 'pointer'
              }}
            >
              Load Older Notifications ({filteredEvents.length - displayedEvents.length} more)
            </button>
          )}

          {/* Bottom clearance spacer */}
          <div style={{ height: 48 }} />
        </div>
      )}
    </div>
  );
};
