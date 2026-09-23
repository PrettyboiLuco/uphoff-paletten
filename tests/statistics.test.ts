import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/domain/types';
import {
  berlinDateKey,
  comparePeriod,
  effectiveActivities,
  isoWeekKey,
  periodWindow,
  statisticsForRange,
  stockSeries,
} from '../src/statistics/statistics';

function event(
  id: string,
  art: StoredEvent['art'],
  delta: number,
  buchungszeit: string,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return {
    id,
    geraetId: 'ipad',
    sorte: 'EURO',
    art,
    delta,
    buchungszeit,
    konfigVersion: 'v1',
    syncState: 'CONFIRMED',
    createdLocalAt: buchungszeit,
    ...overrides,
  };
}

describe('E3 statistics and calendar correctness', () => {
  it('uses Europe/Berlin calendar day rather than UTC day', () => {
    expect(berlinDateKey('2026-03-28T23:30:00Z')).toBe('2026-03-29');
    expect(berlinDateKey('2026-10-24T22:30:00Z')).toBe('2026-10-25');
  });

  it('handles DST spring-forward day without losing events', () => {
    const window = periodWindow('TODAY', '2026-03-29T12:00:00Z');
    const events = [
      event('before-gap', 'ZUGANG', 15, '2026-03-29T00:30:00Z'),
      event('after-gap', 'ZUGANG', 15, '2026-03-29T01:30:00Z'),
      event('next-day', 'ZUGANG', 15, '2026-03-29T22:30:00Z'),
    ];

    const stats = statisticsForRange(events, window.current);
    expect(stats.dazugekommen).toBe(30);
  });

  it('handles repeated DST autumn hour without double counting', () => {
    const window = periodWindow('TODAY', '2026-10-25T12:00:00Z');
    const events = [
      event('first-0230', 'ZUGANG', 15, '2026-10-25T00:30:00Z'),
      event('second-0230', 'ZUGANG', 15, '2026-10-25T01:30:00Z'),
    ];

    const stats = statisticsForRange(events, window.current);
    expect(stats.dazugekommen).toBe(30);
  });

  it('produces correct ISO week keys across year boundaries', () => {
    expect(isoWeekKey('2020-12-31T12:00:00Z')).toBe('2020-W53');
    expect(isoWeekKey('2021-01-01T12:00:00Z')).toBe('2020-W53');
    expect(isoWeekKey('2021-01-04T12:00:00Z')).toBe('2021-W01');
  });

  it('assigns corrections to the original booking period', () => {
    const original = event(
      'out-1',
      'ABGANG',
      -15,
      '2026-08-31T10:00:00+02:00',
    );
    const correction = event(
      'korr_out-1',
      'KORREKTUR',
      15,
      '2026-09-10T10:00:00+02:00',
      { korrigiertId: 'out-1' },
    );

    const august = {
      start: '2026-07-31T22:00:00Z',
      end: '2026-08-31T22:00:00Z',
    };
    const september = {
      start: '2026-08-31T22:00:00Z',
      end: '2026-09-30T22:00:00Z',
    };

    expect(statisticsForRange([original, correction], august).weggekommen).toBe(0);
    expect(statisticsForRange([original, correction], september).weggekommen).toBe(0);
  });

  it('keeps Anfangsbestand and Umbuchung out of access/egress metrics', () => {
    const events = [
      event('start', 'ANFANGSBESTAND', 100, '2026-09-01T08:00:00+02:00'),
      event('transfer-a', 'UMBUCHUNG', -10, '2026-09-02T08:00:00+02:00', {
        umbuchungId: 'u1',
        umbuchungPartnerId: 'transfer-b',
      }),
      event('transfer-b', 'UMBUCHUNG', 10, '2026-09-02T08:00:00+02:00', {
        sorte: 'EINWEG',
        umbuchungId: 'u1',
        umbuchungPartnerId: 'transfer-a',
      }),
      event('inventory', 'INVENTUR', -3, '2026-09-03T08:00:00+02:00'),
    ];

    const range = {
      start: '2026-08-31T22:00:00Z',
      end: '2026-09-30T22:00:00Z',
    };
    const stats = statisticsForRange(events, range);

    expect(stats.dazugekommen).toBe(0);
    expect(stats.weggekommen).toBe(0);
    expect(stats.inventurdifferenz).toBe(-3);
    expect(stats.nettoBestandsaenderung).toBe(97);
  });

  it('calculates a stock series from opening stock plus in-period activity', () => {
    const events = [
      event('start', 'ANFANGSBESTAND', 100, '2026-09-01T08:00:00+02:00'),
      event('in', 'ZUGANG', 15, '2026-09-10T08:00:00+02:00'),
      event('out', 'ABGANG', -15, '2026-09-11T08:00:00+02:00'),
    ];

    const range = {
      start: '2026-09-09T22:00:00Z',
      end: '2026-09-12T22:00:00Z',
    };

    const series = stockSeries(events, range);
    expect(series[0]?.bestand).toBe(100);
    expect(series.map((point) => point.bestand)).toEqual([100, 115, 100, 100]);
  });

  it('filters by sort without affecting other sorts', () => {
    const events = [
      event('euro', 'ZUGANG', 15, '2026-09-10T08:00:00+02:00'),
      event('einweg', 'ZUGANG', 17, '2026-09-10T08:00:00+02:00', {
        sorte: 'EINWEG',
      }),
    ];

    const range = {
      start: '2026-09-09T22:00:00Z',
      end: '2026-09-10T22:00:00Z',
    };

    expect(statisticsForRange(events, range, 'EURO').dazugekommen).toBe(15);
    expect(statisticsForRange(events, range, 'EINWEG').dazugekommen).toBe(17);
  });

  it('computes previous-period percentage change and handles zero base safely', () => {
    const events = [
      event('yesterday', 'ABGANG', -10, '2026-09-22T10:00:00+02:00'),
      event('today', 'ABGANG', -15, '2026-09-23T10:00:00+02:00'),
    ];

    const comparison = comparePeriod(
      events,
      'TODAY',
      '2026-09-23T12:00:00+02:00',
    );

    expect(comparison.weggekommen.current).toBe(15);
    expect(comparison.weggekommen.previous).toBe(10);
    expect(comparison.weggekommen.percentChange).toBe(50);
    expect(comparison.dazugekommen.percentChange).toBe(0);
  });

  it('uses calendar months and years instead of fixed millisecond durations', () => {
    const sixMonths = periodWindow(
      'SIX_MONTHS',
      '2026-09-23T12:00:00+02:00',
    );
    const oneYear = periodWindow(
      'ONE_YEAR',
      '2026-09-23T12:00:00+02:00',
    );

    expect(berlinDateKey(sixMonths.current.start)).toBe('2026-03-24');
    expect(berlinDateKey(sixMonths.current.end)).toBe('2026-09-24');
    expect(berlinDateKey(oneYear.current.start)).toBe('2025-09-24');
    expect(berlinDateKey(oneYear.current.end)).toBe('2026-09-24');
  });

  it('deduplicates exact retries and ignores rejected events', () => {
    const original = event('dup', 'ZUGANG', 15, '2026-09-23T10:00:00+02:00');
    const duplicate = { ...original, syncState: 'PENDING' as const };
    const rejected = event('rejected', 'ZUGANG', 15, '2026-09-23T10:00:00+02:00', {
      syncState: 'REJECTED',
    });

    const activities = effectiveActivities([original, duplicate, rejected]);
    expect(activities).toHaveLength(1);
    expect(activities[0]?.delta).toBe(15);
  });
});
