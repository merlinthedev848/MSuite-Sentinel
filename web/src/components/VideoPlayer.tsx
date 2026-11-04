import React, { useState, useEffect, useRef } from 'react';
import { Camera, Maximize, Minimize, Video as VideoIcon, Activity, Focus, Volume2, VolumeX } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';
import LivePlayer, { LiveMode } from './LivePlayer';

interface VideoPlayerProps {
  cameraId: string;
  name: string;
  status: 'online' | 'offline' | 'recording';
  hasMotion?: boolean;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ cameraId, name, status, hasMotion = false }) => {
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [liveMode, setLiveMode] = useState<LiveMode>('connecting');

  // States for tools
  const [isMuted, setIsMuted] = useState(true);
  const [isZoomMode, setIsZoomMode] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const panStart = useRef({ x: 0, y: 0 });

  // 1. Fullscreen
  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      if (containerRef.current) {
        if (containerRef.current.requestFullscreen) {
          containerRef.current.requestFullscreen();
        } else if ((containerRef.current as any).webkitRequestFullscreen) {
          (containerRef.current as any).webkitRequestFullscreen();
        }
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    }
  };

  const handleSnapshot = async () => {
    const video = videoRef.current;
    const stamp = `snapshot_${name.replace(/\s+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    if (video && video.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/jpeg');
        a.download = stamp;
        a.click();
        return;
      }
    }
    try {
      const res = await fetch(apiUrl(`/cameras/${cameraId}/snapshot?t=${Date.now()}`));
      if (!res.ok) return;
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = stamp;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    } catch {
      /* snapshot endpoint unavailable */
    }
  };

  // Zoom / Pan Event Handlers
  const handleZoomWheel = (e: React.WheelEvent) => {
    if (!isZoomMode) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    setZoomScale(s => Math.min(Math.max(1, s + delta), 8));
  };

  const handleZoomMouseDown = (e: React.MouseEvent) => {
    if (!isZoomMode || zoomScale === 1) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX - zoomOffset.x, y: e.clientY - zoomOffset.y };
  };

  const handleZoomMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    const x = e.clientX - panStart.current.x;
    const y = e.clientY - panStart.current.y;
    setZoomOffset({ x, y });
  };

  const handleZoomMouseUp = () => {
    setIsPanning(false);
  };

  const toggleZoomMode = () => {
    setIsZoomMode(!isZoomMode);
    setZoomScale(1);
    setZoomOffset({ x: 0, y: 0 });
    setIsPanning(false);
  };

  return (
    <div 
      ref={containerRef}
      className="glass-panel"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '250px',
        background: 'var(--bg-dark-base)',
        borderRadius: '12px',
        overflow: 'hidden',
        border: hasMotion ? '1px solid var(--color-danger)' : '1px solid var(--surface-border)',
        transition: 'border-color 0.2s ease',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        handleZoomMouseUp();
      }}
      onWheel={handleZoomWheel}
      onMouseDown={handleZoomMouseDown}
      onMouseMove={handleZoomMouseMove}
      onMouseUp={handleZoomMouseUp}
    >
      <LivePlayer
        cameraId={cameraId}
        quality="auto"
        muted={isMuted}
        videoRef={videoRef}
        onMode={setLiveMode}
        style={{
          transform: isZoomMode ? `scale(${zoomScale}) translate(${zoomOffset.x}px, ${zoomOffset.y}px)` : 'none',
          transformOrigin: 'center center',
          transition: isPanning ? 'none' : 'transform 0.1s ease',
          cursor: isZoomMode ? (isPanning ? 'grabbing' : 'grab') : 'default',
        }}
      />
      {liveMode === 'unavailable' && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <VideoIcon size={48} color="rgba(255,255,255,0.05)" />
        </div>
      )}

      {/* Top Gradient Overlay */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: '60px',
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)',
        zIndex: 10,
        padding: '12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className={`status-indicator ${status}`}></div>
          <span style={{ color: '#fff', fontWeight: 600, textShadow: '0 2px 4px rgba(0,0,0,0.8)' }}>
            {name}
          </span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {status === 'recording' && (
            <div style={{
              background: 'rgba(20, 22, 26, 0.72)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              color: '#f3f5f7',
              padding: '3px 8px',
              borderRadius: '6px',
              fontSize: '0.72rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}>
              <span className="cam-rec-dot" style={{
                width: '7px',
                height: '7px',
                backgroundColor: 'var(--red)',
                borderRadius: '50%',
                display: 'inline-block',
              }}></span>
              REC
            </div>
          )}

          {hasMotion && (
            <div style={{ 
              background: 'rgba(20, 22, 26, 0.72)', 
              color: '#f3f5f7', 
              border: '1px solid rgba(255,255,255,0.14)',
              padding: '2px 8px', 
              borderRadius: '4px', 
              fontSize: '0.72rem', 
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}>
              <Activity size={12} /> Motion
            </div>
          )}
        </div>
      </div>

      {/* Zoom Mode Instruction Overlay */}
      {isZoomMode && (
        <div style={{
          position: 'absolute',
          top: '50px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.8)',
          border: '1px solid var(--surface-border)',
          color: '#fff',
          padding: '4px 10px',
          borderRadius: '20px',
          fontSize: '0.7rem',
          zIndex: 10,
          pointerEvents: 'none',
          boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
        }}>
          Zoom Active: Use mouse wheel to Zoom & Drag to Pan
        </div>
      )}

      {/* Bottom Controls Overlay (Visible on Hover) */}
      <div style={{
        position: 'absolute',
        bottom: 0, left: 0, right: 0,
        height: '50px',
        background: 'linear-gradient(to top, rgba(0,0,0,0.9), transparent)',
        zIndex: 10,
        padding: '12px',
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: '12px',
        opacity: isHovered ? 1 : 0,
        transition: 'opacity 0.2s ease'
      }}>
        {/* Audio Output Mute/Unmute */}
        <button 
          onClick={() => setIsMuted(!isMuted)} 
          style={{ background: 'transparent', border: 'none', color: isMuted ? '#aaa' : 'var(--color-primary)', cursor: 'pointer', padding: '4px' }} 
          title={isMuted ? "Unmute Audio" : "Mute Audio"}
        >
          {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>

        {/* Focus Mode (Digital Zoom) */}
        <button 
          onClick={toggleZoomMode} 
          style={{ background: 'transparent', border: 'none', color: isZoomMode ? 'var(--color-primary)' : '#fff', cursor: 'pointer', padding: '4px' }} 
          title="Digital Zoom & Pan"
        >
          <Focus size={18} />
        </button>

        {/* Snapshot Capture */}
        <button 
          onClick={handleSnapshot} 
          style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: '4px' }} 
          title="Take Snapshot"
        >
          <Camera size={18} />
        </button>

        {/* Native Fullscreen */}
        <button 
          onClick={handleFullscreen} 
          style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: '4px' }} 
          title="Fullscreen Mode"
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
      
      {isHovered && (liveMode === 'mse' || liveMode === 'mjpeg') && (
        <div style={{ position: 'absolute', top: '40px', left: '12px', zIndex: 10, color: 'rgba(255,255,255,0.5)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
          {liveMode === 'mse' ? 'Live' : 'Live MJPEG'}
        </div>
      )}
    </div>
  );
};

export default React.memo(VideoPlayer);
