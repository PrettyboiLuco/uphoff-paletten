import { describe, expect, it } from 'vitest';
import { assessActivationReadiness } from '../scripts/stock-floor-preflight.mjs';

const nowMs = Date.parse('2026-09-26T17:00:00Z');
const checkCode = { 'typ-1': { count: 2, sum: 15 } };
const fresh = {
  lastSeen: { toMillis: () => nowMs - 60_000 },
  appVersion: '0.1.0+abc12345', syncState: 'SYNCHRON',
  pendingCount: 0, rejectedCount: 0, eventCount: 2,
  checkCodeJson: JSON.stringify(checkCode),
};

function check(heartbeats: Record<string, typeof fresh | null>) {
  return assessActivationReadiness({
    eventCount: 2, checkCode, devices: ['a', 'b'], heartbeats,
    expectedVersion: '0.1.0+abc12345', nowMs,
  });
}

describe('production stock migration gate', () => {
  it('accepts two fresh, matching devices', () => {
    expect(check({ a: fresh, b: fresh })).toEqual([]);
  });
  it('blocks the observed stale and mismatched second device', () => {
    expect(check({ a: fresh, b: {
      ...fresh, lastSeen: { toMillis: () => nowMs - 60 * 60_000 },
      eventCount: 1, appVersion: '0.1.0', syncState: 'STALE',
    } })).toEqual(expect.arrayContaining([
      expect.stringContaining('älter als 5 Minuten'),
      expect.stringContaining('App-Version'),
      expect.stringContaining('nicht synchron'),
      expect.stringContaining('Prüfcode'),
    ]));
  });
  it('blocks offline work and missing device heartbeats', () => {
    expect(check({ a: { ...fresh, pendingCount: 1 }, b: null }))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('ausstehende'),
        expect.stringContaining('kein Heartbeat'),
      ]));
  });
});
