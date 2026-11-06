import test from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, mediaUrl, go2rtcUrl } from '../src/lib/endpoints.ts';

test('endpoints: apiUrl correctly normalizes paths', () => {
  assert.equal(apiUrl('/cameras'), '/cameras');
  assert.equal(apiUrl('cameras'), '/cameras');
  assert.equal(apiUrl('/system/health'), '/system/health');
});

test('endpoints: mediaUrl produces standard api path', () => {
  assert.equal(mediaUrl('/static/thumb.jpg'), '/static/thumb.jpg');
});

test('endpoints: go2rtcUrl joins path under go2rtc prefix', () => {
  assert.equal(go2rtcUrl('/api/streams'), '/go2rtc/api/streams');
  assert.equal(go2rtcUrl('api/streams'), '/go2rtc/api/streams');
});
