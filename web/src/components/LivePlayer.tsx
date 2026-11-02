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

const codecMime = (contentType: string | null): string => {
  const header = (contentType || '').trim();
  const kind = header.split(';')[0].trim().toLowerCase();
  if (kind === 'video/mp4' && header.includes('codecs=')) return header;
  return 'video/mp4; codecs="avc1.42E01E"';
};

const supportedMime = (mime: string) => {
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
};

/**
 * Live picture over the API's go2rtc HTTP proxy.
 * WebRTC signaling through that proxy advertises localhost ICE candidates,
 * so the peer never connects. fMP4 via MediaSource, then MJPEG, then a
 * snapshot, all stay on HTTP and can actually be displayed.
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
  const stillRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<LiveMode>('snapshot');

  useEffect(() => {
    onMode?.(mode);
  }, [mode, onMode]);

  useEffect(() => {
    if (paused) {
      setMode('snapshot');
      return;
    }

    let active = true;
    let preferMse = true;
    const abort = new AbortController();
    let objectUrl = '';
    let media: MediaSource | null = null;

    const fail = (next: LiveMode) => {
      preferMse = false;
      if (active) setMode(next);
    };

    const run = async () => {
      // A still goes up immediately. MSE replaces it when the first frame decodes.
      // Staying on "connecting" left the tile blank for a whole GOP, about 5s.
      setMode('snapshot');
      let src = quality === 'main' ? `${cameraId}_main` : cameraId;
      try {
        const registered = await fetch(
          apiUrl(`/cameras/${encodeURIComponent(cameraId)}/ensure-stream?quality=${quality}`),
          { method: 'POST', signal: abort.signal },
        );
        if (registered.status === 400) {
          fail('unavailable');
          return;
        }
        if (registered.ok) {
          const body = await registered.json().catch(() => null);
          if (body?.src) src = String(body.src);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
      if (!active) return;

      try {
        const res = await fetch(go2rtcUrl(`/api/stream.mp4?src=${encodeURIComponent(src)}`), {
          signal: abort.signal,
        });
        const mime = codecMime(res.headers.get('content-type'));
        if (!res.ok || !res.body || !supportedMime(mime)) {
          await res.body?.cancel().catch(() => {});
          fail('mjpeg');
          return;
        }

        media = new MediaSource();
        objectUrl = URL.createObjectURL(media);
        const video = localVideo.current;
        if (!video) {
          await res.body.cancel().catch(() => {});
          fail('mjpeg');
          return;
        }
        video.src = objectUrl;
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('mse-open-timeout')), 4000);
          media!.addEventListener('sourceopen', () => {
            window.clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (!active || !preferMse || media.readyState !== 'open') {
          fail('mjpeg');
          return;
        }

        const sourceBuffer = media.addSourceBuffer(mime);
        sourceBuffer.mode = 'segments';
        const queue: ArrayBuffer[] = [];
        let sawFrame = false;

        const pump = () => {
          if (!preferMse || sourceBuffer.updating || queue.length === 0 || media?.readyState !== 'open') return;
          const chunk = queue.shift();
          if (!chunk) return;
          try {
            sourceBuffer.appendBuffer(chunk);
          } catch {
            fail('mjpeg');
          }
        };

        sourceBuffer.addEventListener('updateend', () => {
          if (!preferMse) return;
          try {
            if (sourceBuffer.buffered.length) {
              const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
              const start = sourceBuffer.buffered.start(0);
              const videoEl = localVideo.current;
              // Jumping to the live edge on every fragment blanks the tile for a
              // frame, which is the once-a-second flash. A short lag is normal.
              // Only catch up when the picture is actually late, and only trim
              // media that is already behind the frame on screen.
              if (videoEl && videoEl.readyState >= 2) {
                sawFrame = true;
                setMode('mse');
                const lag = end - videoEl.currentTime;
                if (lag > 2.5) {
                  videoEl.currentTime = Math.max(0, end - 0.3);
                } else {
                  videoEl.playbackRate = lag > 1.2 ? 1.05 : 1;
                }
                videoEl.play().catch(() => {});
              }
              if (videoEl && end - start > 12 && !sourceBuffer.updating) {
                const trimTo = videoEl.currentTime - 2;
                if (trimTo - start > 1) {
                  sourceBuffer.remove(start, trimTo);
                  return;
                }
              }
            }
          } catch {
            fail('mjpeg');
            return;
          }
          pump();
        });

        const reader = res.body.getReader();
        const giveUp = window.setTimeout(() => {
          if (!sawFrame) {
            reader.cancel().catch(() => {});
            fail('mjpeg');
          }
        }, 2500);
        let checkedCodec = false;

        while (active && preferMse) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          if (!checkedCodec) {
            checkedCodec = true;
            const head = new TextDecoder('latin1').decode(value.subarray(0, Math.min(value.length, 4096)));
            // Chrome MSE cannot play HEVC. A guessed avc1 mime would sit and buffer.
            if (head.includes('hvc1') || head.includes('hev1')) {
              reader.cancel().catch(() => {});
              fail('mjpeg');
              return;
            }
          }
          const buffer = new ArrayBuffer(value.byteLength);
          const copy = new Uint8Array(buffer);
          copy.set(value);
          queue.push(buffer);
          pump();
        }
        window.clearTimeout(giveUp);
        if (active && preferMse && !sawFrame) fail('mjpeg');
      } catch (err) {
        if ((err as Error).name === 'AbortError' || !active) return;
        fail('mjpeg');
      }
    };

    run();
    return () => {
      active = false;
      preferMse = false;
      abort.abort();
      if (media && media.readyState === 'open') {
        try { media.endOfStream(); } catch { /* already closed */ }
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const video = localVideo.current;
      if (video) {
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [cameraId, quality, paused]);

  const holdStill = mode === 'connecting' || mode === 'mjpeg' || mode === 'snapshot';

  useEffect(() => {
    if (!holdStill) return;
    let stop = false;
    let pending = false;
    const paint = () => {
      if (stop || pending) return;
      pending = true;
      const img = new Image();
      img.onload = () => {
        pending = false;
        if (stop) return;
        const canvas = stillRef.current;
        if (!canvas) return;
        const width = img.naturalWidth || canvas.width;
        const height = img.naturalHeight || canvas.height;
        if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
          canvas.width = width;
          canvas.height = height;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx || canvas.width < 1 || canvas.height < 1) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.onerror = () => {
        pending = false;
      };
      // The previous canvas stays until this JPEG has decoded. Replacing the
      // img element, or hiding it on a miss, is what flashed the black tile.
      img.src = apiUrl(`/cameras/${encodeURIComponent(cameraId)}/snapshot?t=${Date.now()}`);
    };
    paint();
    const timer = window.setInterval(paint, 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [holdStill, cameraId]);

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
        style={{ ...mediaStyle, opacity: mode === 'mse' ? 1 : 0 }}
      />
      <canvas
        ref={stillRef}
        style={{ ...mediaStyle, position: 'absolute', inset: 0, visibility: holdStill ? 'visible' : 'hidden' }}
      />
    </div>
  );
};

export default LivePlayer;
