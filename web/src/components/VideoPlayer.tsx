import React, { useState, useEffect, useRef } from 'react';
import { Camera, Maximize, Minimize, Mic, Video as VideoIcon, Activity, Focus, Volume2, VolumeX } from 'lucide-react';
import { go2rtcUrl, apiUrl } from '../lib/endpoints';

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
  const [isStreaming, setIsStreaming] = useState(false);
  const [useMjpegFallback, setUseMjpegFallback] = useState(false);

  // States for tools
  const [isMuted, setIsMuted] = useState(true);
  const [isMicActive, setIsMicActive] = useState(false);
  const [isZoomMode, setIsZoomMode] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const panStart = useRef({ x: 0, y: 0 });
  const micStreamRef = useRef<MediaStream | null>(null);

  const isOffline = status === 'offline';

  // WebRTC Connection Setup
  useEffect(() => {
    if (isOffline) return;

    let pc: RTCPeerConnection | null = null;
    let rtcTimeout: number | undefined;
    let disconnectTimer: number | undefined;
    setIsStreaming(false);
    setUseMjpegFallback(false);

    const fallbackToHls = () => {
      setUseMjpegFallback(true);
      setIsStreaming(true);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
        if (setIsMicActive) setIsMicActive(false);
      }
    };

    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // Stream mic tracks if two-way mic is enabled
    if (isMicActive && micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => {
        pc?.addTrack(track, micStreamRef.current!);
      });
    }

    pc.oniceconnectionstatechange = () => {
      if (pc) {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          window.clearTimeout(rtcTimeout);
          window.clearTimeout(disconnectTimer);
          videoRef.current?.play().catch(e => console.log("Play on connection success error:", e));
        }
        if (pc.iceConnectionState === 'disconnected') {
          window.clearTimeout(disconnectTimer);
          disconnectTimer = window.setTimeout(() => {
            if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
              console.warn("WebRTC stayed disconnected; renegotiating...");
              setRetryNonce(n => n + 1);
            }
          }, 4000);
        }
        if (pc.iceConnectionState === 'failed') {
          console.warn("WebRTC connection failed. Falling back to MJPEG...");
          fallbackToHls();
        }
      }
    };

    pc.ontrack = (event) => {
      window.clearTimeout(rtcTimeout);
      if (videoRef.current && videoRef.current.srcObject !== event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        videoRef.current.play().catch(e => console.log("WebRTC play error:", e));
        setIsStreaming(true);
      }
    };

    const startStream = async () => {
      try {
        if (!pc) return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const streamName = encodeURIComponent(cameraId);
        const response = await fetch(go2rtcUrl(`/api/webrtc?src=${streamName}`), {
          method: 'POST',
          body: offer.sdp
        });

        if (response.ok) {
          const answerSdp = await response.text();
          if (pc) {
            await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
          }
        } else {
          console.warn("WebRTC offer rejected, falling back to live stream");
          fallbackToHls();
        }
      } catch (err) {
        console.error("WebRTC Error for camera", cameraId, err);
        fallbackToHls();
      }
    };

    // Set an 8.0s connection timeout for WebRTC before failing over
    rtcTimeout = window.setTimeout(() => {
      if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
        console.warn(`WebRTC connection timed out after 8.0s for camera ${cameraId}. Falling back to stream...`);
        fallbackToHls();
      }
    }, 8000);

    startStream();

    return () => {
      setIsStreaming(false);
      window.clearTimeout(rtcTimeout);
      window.clearTimeout(disconnectTimer);
      if (pc) {
        pc.close();
      }
      if (videoRef.current) {
        if (videoRef.current.srcObject) {
          try {
            const stream = videoRef.current.srcObject;
            if (stream instanceof MediaStream) {
              stream.getTracks().forEach(track => track.stop());
            }
          } catch (e) {}
          videoRef.current.srcObject = null;
        }
        videoRef.current.src = '';
      }
    };
  }, [cameraId, isOffline, isMicActive, retryNonce]);

  // Cleanup mic stream on unmount
  useEffect(() => {
    return () => {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

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

  // 2. Snapshot capture
  const handleSnapshot = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg');
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot_${name.replace(/\s+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
      a.click();
    }
  };

  // 3. Two-Way Audio Talk Toggle
  const toggleMic = async () => {
    if (isMicActive) {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
      }
      setIsMicActive(false);
      setRetryNonce(n => n + 1);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        setIsMicActive(true);
        setRetryNonce(n => n + 1);
      } catch (err) {
        console.error("Failed to access mic:", err);
        alert("Microphone access denied or not supported.");
      }
    }
  };

  // 4. Zoom / Pan Event Handlers
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
        border: hasMotion ? '2px solid var(--color-danger)' : '1px solid var(--surface-border)',
        transition: 'all 0.3s ease',
        boxShadow: hasMotion ? '0 0 20px rgba(244, 63, 94, 0.4)' : 'none'
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
      {/* Video Element */}
      {status !== 'offline' ? (
        useMjpegFallback ? (
          <img 
            src={go2rtcUrl(`/api/stream.mjpeg?src=${cameraId}`)}
            alt="Camera Feed"
            onError={(e) => {
              const target = e.currentTarget as HTMLImageElement;
              target.dataset.fallback = "true";
              setTimeout(() => {
                target.src = apiUrl(`/cameras/${cameraId}/snapshot?t=${Date.now()}`);
              }, 1000);
            }}
            onLoad={(e) => {
              const target = e.currentTarget as HTMLImageElement;
              if (target.dataset.fallback === "true") {
                setTimeout(() => {
                  target.src = apiUrl(`/cameras/${cameraId}/snapshot?t=${Date.now()}`);
                }, 1000);
              }
            }}
            style={{ 
              width: '100%', 
              height: '100%', 
              objectFit: 'cover',
              transform: isZoomMode ? `scale(${zoomScale}) translate(${zoomOffset.x}px, ${zoomOffset.y}px)` : 'none',
              transformOrigin: 'center center',
              transition: isPanning ? 'none' : 'transform 0.1s ease',
              cursor: isZoomMode ? (isPanning ? 'grabbing' : 'grab') : 'default'
            }} 
          />
        ) : (
          <>
            {!isStreaming && (
              <img 
                src={apiUrl(`/cameras/${cameraId}/snapshot`)}
                alt={name}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  zIndex: 1,
                  pointerEvents: 'none'
                }}
              />
            )}
            <video 
              ref={videoRef}
              autoPlay 
              playsInline 
              muted={isMuted} 
              style={{ 
                width: '100%', 
                height: '100%', 
                objectFit: 'cover',
                opacity: isStreaming ? 1 : 0,
                transform: isZoomMode ? `scale(${zoomScale}) translate(${zoomOffset.x}px, ${zoomOffset.y}px)` : 'none',
                transformOrigin: 'center center',
                transition: isPanning ? 'none' : 'transform 0.1s ease, opacity 0.3s ease',
                cursor: isZoomMode ? (isPanning ? 'grabbing' : 'grab') : 'default'
              }} 
            />
          </>
        )
      ) : (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'linear-gradient(45deg, #050508 0%, #1a1a24 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
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
              background: 'rgba(244, 63, 94, 0.18)',
              border: '1px solid rgba(244, 63, 94, 0.4)',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '6px',
              fontSize: '0.7rem',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              letterSpacing: '0.5px',
              boxShadow: '0 0 12px rgba(244, 63, 94, 0.3)',
              backdropFilter: 'blur(4px)',
            }}>
              <span className="cam-rec-dot" style={{
                width: '8px',
                height: '8px',
                backgroundColor: '#f43f5e',
                borderRadius: '50%',
                display: 'inline-block',
                boxShadow: '0 0 8px #f43f5e',
                animation: 'heartbeat 1.5s ease-in-out infinite'
              }}></span>
              REC
            </div>
          )}

          {hasMotion && (
            <div style={{ 
              background: 'var(--color-danger)', 
              color: '#fff', 
              padding: '2px 8px', 
              borderRadius: '4px', 
              fontSize: '0.75rem', 
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              animation: 'pulse-ring 2s infinite'
            }}>
              <Activity size={12} /> MOTION
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

        {/* Two-Way Microphone Talk */}
        <button 
          onClick={toggleMic} 
          style={{ background: 'transparent', border: 'none', color: isMicActive ? 'var(--color-danger)' : '#fff', cursor: 'pointer', padding: '4px' }} 
          title={isMicActive ? "Mute Microphone" : "Two-Way Audio Talk"}
        >
          <Mic size={18} style={{ animation: isMicActive ? 'pulse-ring 2s infinite' : 'none' }} />
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
      
      {/* WebRTC performance overlay */}
      {isHovered && isStreaming && (
        <div style={{ position: 'absolute', top: '40px', left: '12px', zIndex: 10, color: 'rgba(255,255,255,0.5)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
          {isMicActive ? 'WebRTC | Bidirectional Audio' : 'WebRTC | Live Stream'}
        </div>
      )}
    </div>
  );
};

export default React.memo(VideoPlayer);
