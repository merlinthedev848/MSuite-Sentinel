import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Map as MapIcon, Crosshair, Save, AlertTriangle, Loader, Video, Play, RotateCw, X } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

interface MapCamera {
  id: string;
  name: string;
  status: string;
  x: number;
  y: number;
  rotation: number;
  alert?: boolean;
}

interface MapConfig {
  map_id: string;
  floorplan_url?: string;
  cameras: MapCamera[];
}

const clamp = (value: number) => Math.max(0, Math.min(100, value));

const MapView = () => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [mapId, setMapId] = useState('default');
  const [floorplan, setFloorplan] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MapCamera[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedCamId, setSelectedCamId] = useState<string | null>(null);
  const hasDraggedPinRef = useRef(false);
  const navigate = useNavigate();

  const loadMap = async (id = 'default') => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/maps/${id}`));
      if (!res.ok) throw new Error(`Map load failed: ${res.status}`);
      const data = await res.json() as MapConfig;
      setMapId(data.map_id || id);
      setFloorplan(data.floorplan_url ? apiUrl(data.floorplan_url) : null);
      setCameras(data.cameras || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load map.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMap();
  }, []);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const body = new FormData();
    body.append('file', file);
    setUploading(true);
    setMessage('');
    try {
      const res = await fetch(apiUrl('/maps/upload'), { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Floorplan upload failed.');
      setMapId(data.map_id);
      setFloorplan(apiUrl(data.url));
      setMessage('Floorplan uploaded.');
      await loadMap(data.map_id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Floorplan upload failed.');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const saveLayout = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(apiUrl(`/maps/${mapId}/cameras`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cameras.map(({ id, x, y, rotation }) => ({ id, x, y, rotation }))),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Layout save failed.');
      setMessage(`Saved ${data.saved} camera positions.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Layout save failed.');
    } finally {
      setSaving(false);
    }
  };

  const updateCameraPosition = (cameraId: string, clientX: number, clientY: number) => {
    hasDraggedPinRef.current = true;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clamp(((clientX - rect.left) / rect.width) * 100);
    const y = clamp(((clientY - rect.top) / rect.height) * 100);
    setCameras(items => items.map(cam => cam.id === cameraId ? { ...cam, x, y } : cam));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingId) return;
    updateCameraPosition(draggingId, event.clientX, event.clientY);
  };

  const rotateCamera = (cameraId: string) => {
    setCameras(items => items.map(cam => (
      cam.id === cameraId ? { ...cam, rotation: cam.rotation >= 135 ? -180 : cam.rotation + 45 } : cam
    )));
  };

  return (
    <div style={{ padding: '20px', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: '1rem', color: 'var(--t1)', margin: 0, fontWeight: 700 }}>Spatial Map View</h1>
          <p style={{ color: 'var(--t3)', margin: '4px 0 0', fontSize: '0.8rem' }}>Place cameras on a floorplan and save their field-of-view positions.</p>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {message && <span style={{ color: 'var(--t2)', fontSize: '0.78rem' }}>{message}</span>}
          <label className="btn btn-ghost" style={{ cursor: uploading ? 'default' : 'pointer' }}>
            {uploading ? <Loader size={16} className="spin" /> : <Upload size={16} />}
            {floorplan ? 'Replace Floorplan' : 'Upload Floorplan'}
            <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleFileUpload} disabled={uploading} />
          </label>
          <button className="btn btn-primary" onClick={saveLayout} disabled={saving || loading}>
            {saving ? <Loader size={16} className="spin" /> : <Save size={16} />} Save Layout
          </button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 16, flex: 1, minHeight: 0 }}>
        <aside className="card" style={{ padding: 16, overflow: 'auto' }}>
          <h3 style={{ fontSize: '0.82rem', margin: '0 0 12px', color: 'var(--t1)' }}>Allocated Cameras</h3>
          {loading ? (
            <div className="empty"><div className="spinner" /></div>
          ) : cameras.length === 0 ? (
            <div style={{ color: 'var(--t3)', fontSize: '0.78rem' }}>No cameras are configured yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cameras.map(cam => (
                <button
                  key={cam.id}
                  className="btn btn-ghost"
                  style={{ justifyContent: 'flex-start', padding: '8px 10px', color: 'var(--t2)' }}
                  onClick={() => rotateCamera(cam.id)}
                  title="Click to rotate field of view"
                >
                  <Crosshair size={15} style={{ color: cam.status === 'offline' ? 'var(--t3)' : 'var(--cyan)' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cam.name}</span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <div
          ref={canvasRef}
          className="card"
          onPointerMove={handlePointerMove}
          onPointerUp={() => setDraggingId(null)}
          onPointerLeave={() => setDraggingId(null)}
          style={{
            position: 'relative',
            background: floorplan ? `url(${floorplan}) center/contain no-repeat, var(--bg)` : 'var(--bg)',
            border: '1px solid var(--surface-border-highlight)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            minHeight: 420,
            touchAction: 'none',
          }}
        >
          {!floorplan && (
            <div style={{ textAlign: 'center', color: 'var(--t3)' }}>
              <MapIcon size={54} opacity={0.35} style={{ marginBottom: 12 }} />
              <h3 style={{ color: 'var(--t2)', margin: 0 }}>No Floorplan Loaded</h3>
              <p style={{ fontSize: '0.8rem' }}>Upload an image to start placing cameras.</p>
            </div>
          )}

          {floorplan && (
            <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(var(--surface-border) 1px, transparent 1px), linear-gradient(90deg, var(--surface-border) 1px, transparent 1px)', backgroundSize: '50px 50px', opacity: 0.18 }} />
          )}

          {cameras.map(cam => {
            const isSelected = selectedCamId === cam.id;
            return (
              <div
                key={cam.id}
                onPointerDown={(event) => {
                  hasDraggedPinRef.current = false;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDraggingId(cam.id);
                }}
                onPointerUp={() => {
                  if (!hasDraggedPinRef.current) {
                    setSelectedCamId(prev => prev === cam.id ? null : cam.id);
                  }
                  hasDraggedPinRef.current = false;
                }}
                style={{
                  position: 'absolute',
                  left: `${cam.x}%`,
                  top: `${cam.y}%`,
                  transform: 'translate(-50%, -50%)',
                  zIndex: isSelected ? 30 : 10,
                  cursor: draggingId === cam.id ? 'grabbing' : 'pointer',
                }}
              >
                <div style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  width: 160,
                  height: 160,
                  background: cam.alert ? 'var(--red-dim)' : isSelected ? 'var(--cyan-dim)' : 'rgba(168, 180, 194, 0.12)',
                  transform: `translate(-50%, -50%) rotate(${cam.rotation}deg)`,
                  clipPath: 'polygon(50% 50%, 0 0, 100% 0)',
                  transformOrigin: 'center',
                  pointerEvents: 'none',
                  transition: 'background 0.2s',
                }} />
                <div style={{
                  width: 34,
                  height: 34,
                  background: cam.alert ? 'var(--red)' : isSelected ? 'var(--cyan)' : cam.status === 'offline' ? 'var(--t3)' : 'var(--t1)',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  zIndex: 2,
                  boxShadow: isSelected ? '0 0 16px var(--cyan)' : '0 2px 8px rgba(0,0,0,0.5)',
                  transition: 'all 0.2s ease',
                }}>
                  {cam.alert ? <AlertTriangle size={18} color="#ffffff" /> : <Crosshair size={18} color="#ffffff" />}
                </div>
                <div style={{
                  position: 'absolute',
                  top: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'var(--bg-card)', border: isSelected ? '1px solid var(--cyan)' : '1px solid var(--border)',
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontSize: '0.72rem',
                  marginTop: 4,
                  whiteSpace: 'nowrap',
                  color: isSelected ? 'var(--cyan)' : '#fff',
                  fontWeight: 600,
                  pointerEvents: 'none',
                }}>
                  {cam.name}
                </div>

                {isSelected && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute',
                      bottom: '120%',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: 240,
                      background: 'rgba(22, 24, 28, 0.95)',
                      border: '1px solid var(--cyan-border)',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 12px var(--cyan-dim)',
                      borderRadius: 10,
                      padding: 10,
                      zIndex: 40,
                      backdropFilter: 'blur(10px)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      animation: 'fadeIn 0.2s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--t1)' }}>{cam.name}</span>
                      <button
                        className="btn-ghost"
                        style={{ border: 'none', background: 'transparent', color: 'var(--t3)', cursor: 'pointer', padding: 2 }}
                        onClick={(e) => { e.stopPropagation(); setSelectedCamId(null); }}
                        aria-label="Close camera details"
                      >
                        <X size={14} />
                      </button>
                    </div>

                    <div style={{ width: '100%', height: 110, background: 'var(--bg)', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                      <img
                        src={apiUrl(`/cameras/${cam.id}/snapshot?t=${Date.now()}`)}
                        alt={cam.name}
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                      <div style={{ position: 'absolute', bottom: 4, left: 6, fontSize: '0.65rem', background: 'rgba(0,0,0,0.7)', padding: '1px 5px', borderRadius: 3, color: cam.status === 'offline' ? 'var(--red)' : 'var(--green)' }}>
                        {cam.status.toUpperCase()}
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 2 }}>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '4px 6px', fontSize: '0.7rem', display: 'flex', gap: 3, justifyContent: 'center' }}
                        onClick={() => navigate(`/?camera=${cam.id}`)}
                      >
                        <Video size={12} /> Live
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '4px 6px', fontSize: '0.7rem', display: 'flex', gap: 3, justifyContent: 'center' }}
                        onClick={() => navigate(`/playback?camera=${cam.id}`)}
                      >
                        <Play size={12} /> Play
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '4px 6px', fontSize: '0.7rem', display: 'flex', gap: 3, justifyContent: 'center' }}
                        onClick={() => rotateCamera(cam.id)}
                      >
                        <RotateCw size={12} /> Rotate
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default MapView;
