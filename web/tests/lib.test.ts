import test from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, mediaUrl, go2rtcUrl, apiBase, go2rtcBase } from '../src/lib/endpoints.ts';
import { getViewPreference, setViewPreference, shouldUseMobileView, isMobileDevice } from '../src/lib/mobileDetect.ts';
import { audioAlerts } from '../src/lib/audioAlerts.ts';

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

test('endpoints: apiBase and go2rtcBase return default strings', () => {
  assert.equal(typeof apiBase(), 'string');
  assert.equal(typeof go2rtcBase(), 'string');
  assert.equal(go2rtcBase(), '/go2rtc');
});

test('mobileDetect: getViewPreference defaults gracefully', () => {
  const pref = getViewPreference();
  assert.ok(pref === 'auto' || pref === 'mobile' || pref === 'desktop');
});

test('mobileDetect: isMobileDevice returns boolean in headless environment', () => {
  assert.equal(typeof isMobileDevice(), 'boolean');
});

test('mobileDetect: shouldUseMobileView returns boolean', () => {
  assert.equal(typeof shouldUseMobileView(), 'boolean');
});

test('audioAlerts: isEnabled returns boolean and toggles cleanly', () => {
  const initial = audioAlerts.isEnabled();
  assert.equal(typeof initial, 'boolean');
  const toggled = audioAlerts.toggle();
  assert.equal(toggled, !initial);
  const reverted = audioAlerts.toggle();
  assert.equal(reverted, initial);
});

test('audioAlerts: playChime handles all signal types safely without crashing', () => {
  assert.doesNotThrow(() => {
    audioAlerts.playChime('info');
    audioAlerts.playChime('threat');
    audioAlerts.playChime('warning');
  });
});
