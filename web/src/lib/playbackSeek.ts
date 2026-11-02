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

/** A click this close to a segment still lands on it. A gap of hours does not. */
export const MAX_GAP_SNAP_MS = 3 * 60 * 1000;

/**
 * Pick the recording that should play for a timeline instant.
 * A short gap moves to the next segment. A longer gap is empty: jumping to a
 * file hours later played the wrong time and hid the earlier footage.
 * Only a time just past the last segment stays on that segment, at its end.
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
  if (upcoming && upcoming.startTimestamp - targetMs <= MAX_GAP_SNAP_MS) {
    return { ...upcoming, seekMs: upcoming.startTimestamp };
  }
  if (upcoming) return null;

  const last = ordered[ordered.length - 1];
  if (targetMs - last.endTimestamp <= MAX_GAP_SNAP_MS) {
    return {
      ...last,
      seekMs: Math.max(last.startTimestamp, last.endTimestamp - 250),
    };
  }
  return null;
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

export interface EdgeSegment {
  start: string;
  end: string;
  track?: string;
}

export interface EdgePiece {
  startTimestamp: number;
  endTimestamp: number;
  track: string;
}

/** UTC midnights for instants that no local file covers. */
export function uncoveredDays(clips: ClipSpan[], pointsMs: number[]): number[] {
  const days = new Set<number>();
  for (const point of pointsMs) {
    if (!Number.isFinite(point)) continue;
    const inside = clips.some((clip) => point >= clip.startTimestamp && point < clip.endTimestamp);
    if (inside) continue;
    const date = new Date(point);
    days.add(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  return [...days].sort((a, b) => a - b);
}

/** Parts of [start, end) that no clip already covers. */
export function subtractCovered(start: number, end: number, clips: ClipSpan[]): Array<{ start: number; end: number }> {
  if (!(end > start)) return [];
  let cursor = start;
  const pieces: Array<{ start: number; end: number }> = [];
  const ordered = clips
    .filter((clip) => clip.endTimestamp > start && clip.startTimestamp < end)
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
  for (const clip of ordered) {
    const left = Math.max(clip.startTimestamp, start);
    const right = Math.min(clip.endTimestamp, end);
    if (right <= left) continue;
    if (left > cursor) pieces.push({ start: cursor, end: left });
    cursor = Math.max(cursor, right);
  }
  if (cursor < end) pieces.push({ start: cursor, end });
  return pieces.filter((piece) => piece.end - piece.start >= 1000);
}

/** Camera spans that fall in gaps between recorder files. */
export function edgePieces(segments: EdgeSegment[], local: ClipSpan[]): EdgePiece[] {
  const pieces: EdgePiece[] = [];
  for (const segment of segments) {
    const start = Date.parse(segment.start);
    const end = Date.parse(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const track = segment.track && /^\d+$/.test(segment.track) ? segment.track : '101';
    for (const gap of subtractCovered(start, end, local)) {
      pieces.push({ startTimestamp: gap.start, endTimestamp: gap.end, track });
    }
  }
  pieces.sort((a, b) => a.startTimestamp - b.startTimestamp || a.track.localeCompare(b.track));
  return pieces;
}
