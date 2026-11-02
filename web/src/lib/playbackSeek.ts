export interface ClipSpan {
  url: string;
  startTimestamp: number;
  endTimestamp: number;
}

export interface ResolvedClip {
  url: string;
  startTimestamp: number;
  endTimestamp: number;
  seekMs: number;
}

/**
 * Pick the recording that should play for a timeline instant.
 * A time that falls in a gap moves forward to the next segment.
 * Only a time past the last segment stays on that segment, at its end.
 */
export function resolvePlaybackTarget(
  clips: ClipSpan[],
  targetMs: number,
  findNearest = false,
): ResolvedClip | null {
  if (!Number.isFinite(targetMs) || clips.length === 0) return null;
  const ordered = [...clips].sort((a, b) => a.startTimestamp - b.startTimestamp);

  const inside = ordered.find(
    (clip) => targetMs >= clip.startTimestamp && targetMs < clip.endTimestamp,
  );
  if (inside) {
    const seekMs = Math.min(targetMs, Math.max(inside.startTimestamp, inside.endTimestamp - 250));
    return { ...inside, seekMs };
  }
  if (!findNearest) return null;

  const upcoming = ordered.find((clip) => clip.startTimestamp >= targetMs);
  if (upcoming) return { ...upcoming, seekMs: upcoming.startTimestamp };

  const last = ordered[ordered.length - 1];
  return {
    ...last,
    seekMs: Math.max(last.startTimestamp, last.endTimestamp - 250),
  };
}

export interface LoadedSeek {
  /** Added to media currentTime when converting back to a wall-clock instant. */
  timeBaseSec: number;
  /** Browser seek, or null when the response already starts at the offset. */
  mediaSeekSec: number | null;
}

/**
 * A finite duration that can hold the offset is a whole file and can be seeked.
 * An empty duration, or a file shorter than the offset, means the server started
 * at that offset. Media time 0 is then the requested instant, not the segment start.
 */
export function resolveLoadedSeek(offsetSec: number, durationSec: number): LoadedSeek {
  const want = Math.max(0, offsetSec);
  if (Number.isFinite(durationSec) && durationSec > 1 && want <= durationSec + 0.25) {
    return {
      timeBaseSec: 0,
      mediaSeekSec: Math.min(want, Math.max(0, durationSec - 0.25)),
    };
  }
  return { timeBaseSec: want, mediaSeekSec: null };
}

export function timelineMs(startTimestamp: number, timeBaseSec: number, mediaTimeSec: number): number {
  return startTimestamp + (timeBaseSec + Math.max(0, mediaTimeSec)) * 1000;
}
