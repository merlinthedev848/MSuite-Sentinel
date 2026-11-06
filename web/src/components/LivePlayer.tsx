import React, { useEffect, useRef, useState } from 'react';
import { apiUrl, go2rtcUrl } from '../lib/endpoints';

export type LiveMode = 'connecting' | 'mse' | 'mjpeg' | 'snapshot' | 'unavailable';

interface LivePlayerProps {
  cameraId: string;
  quality?: 'auto' | 'main' | 'sub';
  muted?: boolean;
  paused?: boolean;
  videoRef?: React.Ref<HTMLVideoElement | null>;
  onMode?: (mode: LiveMode) => void;
  style?: React.CSSProperties;
}

const assignRef = (ref: React.Ref<HTMLVideoElement | null> | undefined, node: HTMLVideoElement | null) => {
  if (!ref) return;
  if (typeof ref === 'function') ref(node);
  else (ref as React.MutableRefObject<HTMLVideoElement | null>).current = node;
};

// go2rtc only matches these exact names when choosing an MSE track.
// H.265 is omitted on purpose: Chrome cannot play it, and the server adds
// an H.264 track for cameras that only offer HEVC.
const mseCodecOffer = () => {
  const videoCodecs = ['avc1.640029', 'avc1.42e01f', 'avc1.4d401f'];
  const audioCodecs = ['mp4a.40.2', 'opus'];

  const supportedVideo = videoCodecs.filter((codec) => {
    try {
      return MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`);
    } catch {
      return false;
    }
  });

  const supportedAudio = audioCodecs.filter((codec) => {
    try {
      return (
        MediaSource.isTypeSupported(`audio/mp4; codecs="${codec}"`) ||
        MediaSource.isTypeSupported(`video/mp4; codecs="avc1.640029,${codec}"`)
      );
    } catch {
      return false;
    }
  });

  return [...supportedVideo, ...supportedAudio].join(',');
};

const liveSocketUrl = (src: string) => {
  const path = go2rtcUrl(`/api/ws?src=${encodeURIComponent(src)}`);
  if (path.startsWith('ws')) return path;
  if (path.startsWith('http')) return path.replace(/^http/, 'ws');
  const origin = window.location.origin.replace(/^http/, 'ws');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
};

/**
 * Continuous live video over go2rtc's fMP4 WebSocket.
 * WebRTC was unusable here because the proxy advertised localhost ICE
 * candidates. HTTP stream.mp4 is one file, and giving up on it left the tile
 * on a JPEG that only changes when the camera emits a keyframe.
 */
const LivePlayer: React.FC<LivePlayerProps> = ({
  cameraId,
  quality = 'auto',
  muted = true,
  paused = false,
  videoRef,
  onMode,
  style,
}) => {
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [poster, setPoster] = useState('');

  useEffect(() => {
    onMode?.(mode);
  }, [mode, onMode]);

  useEffect(() => {
    const video = localVideo.current;
    if (video) {
      video.muted = muted;
      video.defaultMuted = muted;
      if (!muted) {
        video.volume = 1.0;
        video.play().catch(() => {});
      }
    }
  }, [muted]);

  useEffect(() => {
    if (paused) {
      setMode('snapshot');
      setPoster(apiUrl(`/cameras/${encodeURIComponent(cameraId)}/snapshot?t=${Date.now()}`));
      return;
    }
    // One still, so the tile is not black while the first keyframe arrives.
    // It is not refreshed. The video element replaces it and stays there.
    setPoster(apiUrl(`/cameras/${encodeURIComponent(cameraId)}/snapshot?t=${Date.now()}`));
    setMode('connecting');

    let active = true;
    let generation = 0;
    let reconnectTimer = 0;
    let socket: WebSocket | null = null;
    let objectUrl = '';
    let media: MediaSource | null = null;
    let removeVisibilityListener: (() => void) | null = null;

    let edgeGuardTimer = 0;

    const closeMedia = () => {
      if (edgeGuardTimer) {
        window.clearInterval(edgeGuardTimer);
        edgeGuardTimer = 0;
      }
      if (removeVisibilityListener) {
        removeVisibilityListener();
        removeVisibilityListener = null;
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      if (media && media.readyState === 'open') {
        try { media.endOfStream(); } catch { /* already closed */ }
      }
      media = null;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = '';
      }
      const video = localVideo.current;
      if (video) {
        video.removeAttribute('src');
        video.load();
      }
    };

    const scheduleReconnect = (delay: number) => {
      if (!active) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => { void connect(); }, delay);
    };

    const connect = async () => {
      const gen = ++generation;
      if (!active) return;
      closeMedia();
      let src = quality === 'main' ? `${cameraId}_main` : cameraId;
      // Trigger stream registration and hardware keyframe generation in background
      fetch(apiUrl(`/cameras/${encodeURIComponent(cameraId)}/ensure-stream?quality=${quality}`), { method: 'POST' })
        .catch(() => {});

      if (!active || gen !== generation) return;
      const video = localVideo.current;
      if (!video || typeof MediaSource === 'undefined') {
        scheduleReconnect(2000);
        return;
      }

      media = new MediaSource();
      objectUrl = URL.createObjectURL(media);
      video.src = objectUrl;

      let sourceOpen = false;
      let socketOpen = false;
      let offered = false;
      const queue: ArrayBuffer[] = [];
      let sourceBuffer: SourceBuffer | null = null;
      let sawFrame = false;
      let initialEdgeJumped = false;
      let lastHardSeekTime = 0;

      const pump = () => {
        if (!sourceBuffer || sourceBuffer.updating || queue.length === 0 || media?.readyState !== 'open') return;
        const chunk = queue.shift();
        if (!chunk) return;
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch {
          queue.unshift(chunk);
        }
      };

      const sendOffer = () => {
        if (offered || !sourceOpen || !socketOpen || !socket || socket.readyState !== WebSocket.OPEN) return;
        const offer = mseCodecOffer();
        if (!offer) {
          scheduleReconnect(2000);
          return;
        }
        offered = true;
        socket.send(JSON.stringify({ type: 'mse', value: offer }));
      };

      media.addEventListener('sourceopen', () => {
        sourceOpen = true;
        sendOffer();
      }, { once: true });

      const opened = new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(liveSocketUrl(src));
        socket = ws;
        ws.binaryType = 'arraybuffer';
        const failTimer = window.setTimeout(() => reject(new Error('mse-open-timeout')), 15000);
        ws.onopen = () => {
          window.clearTimeout(failTimer);
          resolve(ws);
        };
        ws.onerror = () => {
          window.clearTimeout(failTimer);
          reject(new Error('mse-socket'));
        };
      });

      let ws: WebSocket;
      try {
        ws = await opened;
      } catch {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          socket.onclose = null;
          socket.close();
          socket = null;
        }
        if (active && gen === generation) scheduleReconnect(1500);
        return;
      }
      if (!active || gen !== generation || socket !== ws) {
        ws.close();
        return;
      }
      socketOpen = true;
      sendOffer();

      let idle: number = window.setTimeout(() => {
        if (!sawFrame && active) ws.close();
      }, 15000);

      ws.onmessage = (event) => {
        if (!active) return;
        if (typeof event.data === 'string') {
          let message: { type?: string; value?: string } | null = null;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message?.type === 'error') {
            ws.close();
            return;
          }
          if (message?.type !== 'mse' || !message.value || !media || media.readyState !== 'open') return;
          if (message.value.includes('hvc1') || message.value.includes('hev1')) {
            ws.close();
            return;
          }
          try {
            if (sourceBuffer) return;
            sourceBuffer = media.addSourceBuffer(message.value);
            sourceBuffer.mode = 'segments';
            sourceBuffer.addEventListener('updateend', () => {
              if (!sourceBuffer || media?.readyState !== 'open') return;
              pump();
              try {
                if (!sourceBuffer.buffered.length) return;
                const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                const start = sourceBuffer.buffered.start(0);
                const videoEl = localVideo.current;
                // Keep media buffer lean to prevent decoder presentation lag
                if (end - start > 3.0 && !sourceBuffer.updating && videoEl) {
                  const trimTo = Math.min(end - 0.5, Math.max(start, videoEl.currentTime - 0.5));
                  if (trimTo - start > 0.3) {
                    sourceBuffer.remove(start, trimTo);
                    return;
                  }
                }
                if (videoEl && videoEl.readyState >= 2) {
                  sawFrame = true;
                  window.clearTimeout(idle);
                  setMode('mse');

                  // Initial lock onto live edge instantly upon first decoded frame
                  if (!initialEdgeJumped && !videoEl.seeking) {
                    if (end > 0.15) {
                      videoEl.currentTime = Math.max(0, end - 0.05);
                      initialEdgeJumped = true;
                      lastHardSeekTime = Date.now();
                    }
                  }

                  const lag = end - videoEl.currentTime;
                  const now = Date.now();

                  // Sub-second ultra-low latency live edge synchronization
                  if (lag > 1.8 && !videoEl.seeking && (now - lastHardSeekTime > 2000)) {
                    // Stalled or large lag: hard seek to live edge with debounce
                    videoEl.currentTime = Math.max(0, end - 0.05);
                    videoEl.playbackRate = 1.0;
                    lastHardSeekTime = now;
                  } else if (lag > 0.20) {
                    // Smooth, artifact-free catchup without video stutters or seek cancellations
                    videoEl.playbackRate = 1.14;
                  } else if (lag <= 0.08) {
                    videoEl.playbackRate = 1.0;
                  }

                  videoEl.muted = muted;
                  if (videoEl.paused) {
                    videoEl.play().catch(() => {});
                  }
                }
              } catch {
                /* a trim error is not a reason to drop back to stills */
              }
            });
            pump();
          } catch {
            ws.close();
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer) || !event.data.byteLength) return;
        queue.push(event.data);
        pump();
      };

      const jumpToLiveEdge = () => {
        const videoEl = localVideo.current;
        if (!videoEl || !sourceBuffer || !sourceBuffer.buffered.length || videoEl.seeking) return;
        try {
          const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
          const lag = end - videoEl.currentTime;
          if (lag > 0.15) {
            videoEl.currentTime = Math.max(0, end - 0.05);
            videoEl.playbackRate = 1.0;
            lastHardSeekTime = Date.now();
            initialEdgeJumped = true;
          }
        } catch {}
      };

      video.addEventListener('loadeddata', jumpToLiveEdge, { once: true });
      video.addEventListener('canplay', jumpToLiveEdge, { once: true });

      // Continuous edge-guard interval to smoothly recover from frame drops or clock drift
      edgeGuardTimer = window.setInterval(() => {
        if (!active) return;
        const videoEl = localVideo.current;
        if (!videoEl || videoEl.paused || !sourceBuffer || !sourceBuffer.buffered.length || videoEl.seeking) return;
        try {
          const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
          const lag = end - videoEl.currentTime;
          const now = Date.now();
          if (lag > 1.8 && (now - lastHardSeekTime > 2000)) {
            videoEl.currentTime = Math.max(0, end - 0.05);
            videoEl.playbackRate = 1.0;
            lastHardSeekTime = now;
          }
        } catch {}
      }, 800);

      const handleVisibilityChange = () => {
        if (!active) return;
        if (document.visibilityState === 'visible') {
          const videoEl = localVideo.current;
          if (videoEl && sourceBuffer && sourceBuffer.buffered.length && !videoEl.seeking) {
            try {
              const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
              videoEl.currentTime = Math.max(0, end - 0.05);
              videoEl.playbackRate = 1.0;
              lastHardSeekTime = Date.now();
              videoEl.play().catch(() => {});
            } catch {}
          }
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      removeVisibilityListener = () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };

      ws.onclose = () => {
        if (removeVisibilityListener) {
          removeVisibilityListener();
          removeVisibilityListener = null;
        }
        window.clearTimeout(idle);
        if (active) scheduleReconnect(sawFrame ? 500 : 1500);
      };
    };

    void connect();
    return () => {
      active = false;
      window.clearTimeout(reconnectTimer);
      closeMedia();
    };
  }, [cameraId, quality, paused]);

  const setNode = (node: HTMLVideoElement | null) => {
    localVideo.current = node;
    assignRef(videoRef, node);
  };

  const mediaStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    ...style,
  };

  if (mode === 'unavailable') {
    return <div style={{ position: 'absolute', inset: 0, background: '#05080f' }} />;
  }

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#02050a' }}>
      <video
        ref={setNode}
        autoPlay
        playsInline
        muted={muted}
        poster={poster || undefined}
        style={mediaStyle}
      />
    </div>
  );
};

export default LivePlayer;
