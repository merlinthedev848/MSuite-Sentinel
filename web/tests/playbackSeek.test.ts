import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  resolvePlaybackTarget, 
  resolveLoadedSeek, 
  timelineMs, 
  uncoveredDays, 
  MAX_GAP_SNAP_MS 
} from '../src/lib/playbackSeek.ts';

test('resolvePlaybackTarget: returns clip when target is inside', () => {
  const clips = [
    { url: '/rec/1.mp4', startTimestamp: 1000, endTimestamp: 5000 },
    { url: '/rec/2.mp4', startTimestamp: 6000, endTimestamp: 10000 },
  ];
  const target = resolvePlaybackTarget(clips, 2500, false);
  assert.ok(target);
  assert.equal(target.url, '/rec/1.mp4');
  assert.equal(target.seekMs, 2500);
});

test('resolvePlaybackTarget: snaps to nearest segment within 24 hours', () => {
  const clips = [
    { url: '/rec/1.mp4', startTimestamp: 1000, endTimestamp: 5000 },
    { url: '/rec/2.mp4', startTimestamp: 20000, endTimestamp: 30000 },
  ];
  const target = resolvePlaybackTarget(clips, 12000, true);
  assert.ok(target);
  assert.equal(target.url, '/rec/1.mp4');
});

test('resolveLoadedSeek: handles seeking inside known duration', () => {
  const res = resolveLoadedSeek(15, 60);
  assert.equal(res.timeBaseSec, 0);
  assert.equal(res.mediaSeekSec, 15);
});

test('resolveLoadedSeek: handles zero-offset or live slice', () => {
  const res = resolveLoadedSeek(75, 60);
  assert.equal(res.timeBaseSec, 75);
  assert.equal(res.mediaSeekSec, null);
});

test('timelineMs: accurately calculates wall clock milliseconds', () => {
  const start = 1700000000000;
  const time = timelineMs(start, 10, 5);
  assert.equal(time, start + 15000);
});

test('uncoveredDays: finds distinct midnights needing edge queries', () => {
  const clips = [
    { url: '/rec/1.mp4', startTimestamp: 10000, endTimestamp: 20000 },
  ];
  const points = [15000, 86400000 * 5];
  const days = uncoveredDays(clips, points);
  assert.equal(days.length, 1);
  assert.equal(days[0], 86400000 * 5);
});

test('MAX_GAP_SNAP_MS is 24 hours', () => {
  assert.equal(MAX_GAP_SNAP_MS, 24 * 60 * 60 * 1000);
});
