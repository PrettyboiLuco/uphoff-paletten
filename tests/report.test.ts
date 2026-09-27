import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/domain/types';
import { createPeriodPdf, periodReport, reportRange } from '../src/ops/report';

const sample: StoredEvent = {
  id: 'entry-1', geraetId: 'ipad', sorte: 'typ-1', art: 'ZUGANG', delta: 15,
  buchungszeit: '2026-03-29T00:30:00Z', konfigVersion: 'v1',
  syncState: 'CONFIRMED', createdLocalAt: '2026-03-29T00:30:00Z',
};

describe('day and week PDF reports', () => {
  it('uses Berlin calendar boundaries across daylight saving changes', () => {
    expect(reportRange('DAY', '2026-03-29')).toEqual({
      start: '2026-03-28T23:00:00Z', end: '2026-03-29T22:00:00Z',
    });
    expect(reportRange('WEEK', '2026-03-29')).toEqual({
      start: '2026-03-22T23:00:00Z', end: '2026-03-29T22:00:00Z',
    });
  });

  it('includes only bookings inside the selected day and creates a readable PDF', async () => {
    const next = { ...sample, id: 'next', buchungszeit: '2026-03-29T22:00:00Z' };
    const report = periodReport([sample, next], 'DAY', '2026-03-29');
    expect(report.entries.map((event) => event.id)).toEqual(['entry-1']);
    expect(report.statistics.dazugekommen).toBe(15);
    const bytes = await createPeriodPdf([sample], 'DAY', '2026-03-29');
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toContain('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
