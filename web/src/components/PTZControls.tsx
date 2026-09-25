import React, { useState, useEffect } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Crosshair, ZoomIn, ZoomOut, Bookmark, Play, Pause, Plus } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

interface PTZControlsProps {
  cameraId: string;
}

export const PTZControls: React.FC<PTZControlsProps> = ({ cameraId }) => {
  const [presets, setPresets] = useState<string[]>([]);
  const [newPresetName, setNewPresetName] = useState('');
  const [tourActive, setTourActive] = useState(false);

  useEffect(() => {
    const fetchPresets = async () => {
      try {
        const res = await fetch(apiUrl(`/cameras/${cameraId}/ptz/presets`));
        if (res.ok) {
          const data = await res.json();
          setPresets(data.presets || []);
        }
      } catch {}
    };
    fetchPresets();
  }, [cameraId]);

  const handlePTZ = async (action: string) => {
    try {
      await fetch(apiUrl(`/cameras/${cameraId}/ptz/move`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, speed: 0.5 })
      });
    } catch (e) {
      console.error("PTZ Command Failed", e);
    }
  };

  const stopPTZ = async () => {
    try {
      await fetch(apiUrl(`/cameras/${cameraId}/ptz/stop`), {
        method: 'POST'
      });
    } catch (e) {
      console.error("PTZ Stop Failed", e);
    }
  };

  const gotoPreset = async (name: string) => {
    try {
      await fetch(apiUrl(`/cameras/${cameraId}/ptz/goto`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
    } catch {}
  };

  const savePreset = async () => {
    if (!newPresetName.trim()) return;
    try {
      const res = await fetch(apiUrl(`/cameras/${cameraId}/ptz/presets`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newPresetName.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        setPresets(data.presets || []);
        setNewPresetName('');
      }
    } catch {}
  };

  const toggleTour = async () => {
    const next = !tourActive;
    try {
      await fetch(apiUrl(`/cameras/${cameraId}/ptz/tour`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next, interval_seconds: 15 })
      });
      setTourActive(next);
    } catch {}
  };

  return (
    <div className="glass-panel" style={{ 
      padding: '1rem', 
      display: 'flex', 
      flexDirection: 'column', 
      gap: '1rem',
      background: 'rgba(0,0,0,0.6)',
      border: '1px solid var(--surface-border-highlight)',
      width: 260
    }}>
      <div style={{ textAlign: 'center', fontWeight: 600, color: 'var(--color-primary)', fontSize: '0.85rem' }}>
        PTZ & Guard Patrol
      </div>
      
      {/* Joystick Cross */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', width: 'fit-content', margin: '0 auto' }}>
        <div></div>
        <button 
          className="btn btn-outline" 
          onMouseDown={() => handlePTZ('up')} 
          onMouseUp={stopPTZ}
          onMouseLeave={stopPTZ}
          onTouchStart={(e) => { e.preventDefault(); handlePTZ('up'); }}
          onTouchEnd={(e) => { e.preventDefault(); stopPTZ(); }}
          style={{ padding: '10px' }}
        >
          <ArrowUp size={18} />
        </button>
        <div></div>
        
        <button 
          className="btn btn-outline" 
          onMouseDown={() => handlePTZ('left')} 
          onMouseUp={stopPTZ}
          onMouseLeave={stopPTZ}
          onTouchStart={(e) => { e.preventDefault(); handlePTZ('left'); }}
          onTouchEnd={(e) => { e.preventDefault(); stopPTZ(); }}
          style={{ padding: '10px' }}
        >
          <ArrowLeft size={18} />
        </button>
        <button className="btn btn-outline" style={{ padding: '10px', background: 'rgba(0,212,255,0.1)', color: 'var(--color-primary)' }}>
          <Crosshair size={18} />
        </button>
        <button 
          className="btn btn-outline" 
          onMouseDown={() => handlePTZ('right')} 
          onMouseUp={stopPTZ}
          onMouseLeave={stopPTZ}
          onTouchStart={(e) => { e.preventDefault(); handlePTZ('right'); }}
          onTouchEnd={(e) => { e.preventDefault(); stopPTZ(); }}
          style={{ padding: '10px' }}
        >
          <ArrowRight size={18} />
        </button>
        
        <div></div>
        <button 
          className="btn btn-outline" 
          onMouseDown={() => handlePTZ('down')} 
          onMouseUp={stopPTZ}
          onMouseLeave={stopPTZ}
          onTouchStart={(e) => { e.preventDefault(); handlePTZ('down'); }}
          onTouchEnd={(e) => { e.preventDefault(); stopPTZ(); }}
          style={{ padding: '10px' }}
        >
          <ArrowDown size={18} />
        </button>
        <div></div>
      </div>

      {/* Zoom Controls */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', borderTop: '1px solid var(--surface-border)', paddingTop: '0.75rem' }}>
        <button 
          className="btn btn-outline"
          onMouseDown={() => handlePTZ('zoom_in')} 
          onMouseUp={stopPTZ}
          onMouseLeave={stopPTZ}
          onTouchStart={(e) => { e.preventDefault(); handlePTZ('zoom_in'); }}
          onTouchEnd={(e) => { e.preventDefault(); stopPTZ(); }}
          style={{ fontSize: '0.75rem' }}
        >
          <ZoomIn size={14} /> Zoom +
        </button>
        <button 
          className="btn btn-outline"
          onMouseDown={() => handlePTZ('zoom_out')} 
          onMouseUp={stopPTZ}
          onMouseLeave={stopPTZ}
          onTouchStart={(e) => { e.preventDefault(); handlePTZ('zoom_out'); }}
          onTouchEnd={(e) => { e.preventDefault(); stopPTZ(); }}
          style={{ fontSize: '0.75rem' }}
        >
          <ZoomOut size={14} /> Zoom -
        </button>
      </div>

      {/* Saved Presets & Guard Patrol */}
      <div style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-1)' }}>Waypoints & Patrol</span>
          <button 
            className="btn" 
            onClick={toggleTour}
            style={{ 
              fontSize: '0.68rem', padding: '2px 8px', 
              background: tourActive ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
              color: tourActive ? '#ef4444' : '#10b981',
              border: `1px solid ${tourActive ? '#ef4444' : '#10b981'}`
            }}
          >
            {tourActive ? <Pause size={10} /> : <Play size={10} />} {tourActive ? 'Stop Tour' : 'Guard Tour'}
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {presets.map(p => (
            <button 
              key={p} 
              className="btn btn-outline" 
              onClick={() => gotoPreset(p)}
              style={{ fontSize: '0.68rem', padding: '3px 8px' }}
            >
              <Bookmark size={10} /> {p}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <input
            className="form-input"
            style={{ fontSize: '0.7rem', height: 26, padding: '0 8px' }}
            placeholder="New preset name..."
            value={newPresetName}
            onChange={e => setNewPresetName(e.target.value)}
          />
          <button className="btn btn-primary" onClick={savePreset} style={{ height: 26, padding: '0 8px', fontSize: '0.7rem' }}>
            <Plus size={12} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PTZControls;
