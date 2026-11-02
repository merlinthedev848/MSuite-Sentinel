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
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [streamName, setStreamName] = useState('');
  const [snapshotSrc, setSnapshotSrc] = useState('');
  const [mjpegTries, setMjpegTries] = useState(0);

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
      setMode('connecting');
      let src = quality === 'sub' ? `${cameraId}_sub` : `${cameraId}_main`;
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
      setStreamName(src);
      setMjpegTries(0);

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
              if (end - start > 12 && !sourceBuffer.updating) {
                sourceBuffer.remove(start, end - 8);
                return;
              }
              if (videoEl && end - videoEl.currentTime > 1.5) {
                videoEl.currentTime = Math.max(0, end - 0.3);
              }
              if (videoEl && videoEl.readyState >= 2) {
                sawFrame = true;
                setMode('mse');
                videoEl.play().catch(() => {});
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
        }, 5000);

        while (active && preferMse) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
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

  useEffect(() => {
    if (mode === 'mjpeg' && mjpegTries > 2) setMode('snapshot');
  }, [mode, mjpegTries]);

  useEffect(() => {
    if (mode !== 'snapshot' && mode !== 'connecting') return;
    let stop = false;
    const tick = () => {
      if (stop) return;
      setSnapshotSrc(apiUrl(`/cameras/${encodeURIComponent(cameraId)}/snapshot?t=${Date.now()}`));
    };
    tick();
    const timer = mode === 'snapshot' ? window.setInterval(tick, 2000) : 0;
    return () => {
      stop = true;
      if (timer) window.clearInterval(timer);
    };
  }, [mode, cameraId]);

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
      {mode === 'mjpeg' && streamName && mjpegTries <= 2 && (
        <img
          key={mjpegTries}
          src={go2rtcUrl(`/api/stream.mjpeg?src=${encodeURIComponent(streamName)}`)}
          alt=""
          style={{ ...mediaStyle, position: 'absolute', inset: 0 }}
          onError={() => setMjpegTries(tries => tries + 1)}
        />
      )}
      {(mode === 'connecting' || mode === 'snapshot') && snapshotSrc && (
        <img
          src={snapshotSrc}
          alt=""
          style={{ ...mediaStyle, position: 'absolute', inset: 0 }}
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      )}
    </div>
  );
};

export default LivePlayer;
