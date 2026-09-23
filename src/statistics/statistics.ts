import { Temporal } from '@js-temporal/polyfill';
import type { StoredEvent } from '../domain/types';

export const BUSINESS_TIME_ZONE = 'Europe/Berlin';

export type StatisticsPeriodKind = 'TODAY' | 'FOUR_WEEKS' | 'SIX_MONTHS' | 'ONE_YEAR';

export interface TimeRange {
  start: string;
  end: string;
}

export interface PeriodWindow {
  current: TimeRange;
  previous: TimeRange;
}

export interface EffectiveActivity {
  eventId: string;
  sorte: string;
  sourceArt: StoredEvent['art'];
  delta: number;
  effectiveBookingTime: string;
}

export interface PeriodStatistics {
  dazugekommen: number;
  weggekommen: number;
  inventurdifferenz: number;
  nettoBestandsaenderung: number;
  bySort: Record<
    string,
    {
      dazugekommen: number;
      weggekommen: number;
      inventurdifferenz: number;
      nettoBestandsaenderung: number;
    }
  >;
}

export interface ComparisonMetric {
  current: number;
  previous: number;
  percentChange: number | null;
}

export interface PeriodComparison {
  dazugekommen: ComparisonMetric;
  weggekommen: ComparisonMetric;
  inventurdifferenz: ComparisonMetric;
}

function zonedStartOfDay(iso: string): Temporal.ZonedDateTime {
  return Temporal.Instant.from(iso)
    .toZonedDateTimeISO(BUSINESS_TIME_ZONE)
    .startOfDay();
}

function toRange(start: Temporal.ZonedDateTime, end: Temporal.ZonedDateTime): TimeRange {
  return {
    start: start.toInstant().toString(),
    end: end.toInstant().toString(),
  };
}

export function periodWindow(
  kind: StatisticsPeriodKind,
  nowIso: string,
): PeriodWindow {
  const todayStart = zonedStartOfDay(nowIso);
  const end = todayStart.add({ days: 1 });

  let start: Temporal.ZonedDateTime;
  let previousStart: Temporal.ZonedDateTime;

  switch (kind) {
    case 'TODAY':
      start = todayStart;
      previousStart = start.subtract({ days: 1 });
      break;
    case 'FOUR_WEEKS':
      start = end.subtract({ weeks: 4 });
      previousStart = start.subtract({ weeks: 4 });
      break;
    case 'SIX_MONTHS':
      start = end.subtract({ months: 6 });
      previousStart = start.subtract({ months: 6 });
      break;
    case 'ONE_YEAR':
      start = end.subtract({ years: 1 });
      previousStart = start.subtract({ years: 1 });
      break;
  }

  return {
    current: toRange(start, end),
    previous: toRange(previousStart, start),
  };
}

export function berlinDateKey(iso: string): string {
  return Temporal.Instant.from(iso)
    .toZonedDateTimeISO(BUSINESS_TIME_ZONE)
    .toPlainDate()
    .toString();
}

export function isoWeekKey(iso: string): string {
  const date = Temporal.Instant.from(iso)
    .toZonedDateTimeISO(BUSINESS_TIME_ZONE)
    .toPlainDate();

  return `${date.yearOfWeek}-W${String(date.weekOfYear).padStart(2, '0')}`;
}

function inRange(iso: string, range: TimeRange): boolean {
  const value = Temporal.Instant.from(iso).epochNanoseconds;
  const start = Temporal.Instant.from(range.start).epochNanoseconds;
  const end = Temporal.Instant.from(range.end).epochNanoseconds;
  return value >= start && value < end;
}

function reconcileEvents(events: readonly StoredEvent[]): StoredEvent[] {
  const groups = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (event.syncState === 'REJECTED') continue;
    const current = groups.get(event.id);
    if (current) current.push(event);
    else groups.set(event.id, [event]);
  }

  const result: StoredEvent[] = [];
  for (const group of groups.values()) {
    const signatures = new Set(
      group.map((event) =>
        JSON.stringify({
          id: event.id,
          geraetId: event.geraetId,
          person: event.person ?? null,
          sorte: event.sorte,
          art: event.art,
          delta: event.delta,
          buchungszeit: event.buchungszeit,
          konfigVersion: event.konfigVersion,
          vorgangId: event.vorgangId ?? null,
          korrigiertId: event.korrigiertId ?? null,
          umbuchungId: event.umbuchungId ?? null,
          umbuchungPartnerId: event.umbuchungPartnerId ?? null,
        }),
      ),
    );

    if (signatures.size !== 1) continue;

    const confirmed = group.find((event) => event.syncState === 'CONFIRMED');
    const pending = group.find((event) => event.syncState === 'PENDING');
    const local = group.find((event) => event.syncState === 'LOCAL_ONLY');
    const chosen = confirmed ?? pending ?? local;
    if (chosen) result.push(chosen);
  }

  return result;
}

export function effectiveActivities(
  events: readonly StoredEvent[],
): EffectiveActivity[] {
  const reconciled = reconcileEvents(events);
  const byId = new Map(reconciled.map((event) => [event.id, event] as const));
  const result: EffectiveActivity[] = [];

  for (const event of reconciled) {
    if (event.art !== 'KORREKTUR') {
      result.push({
        eventId: event.id,
        sorte: event.sorte,
        sourceArt: event.art,
        delta: event.delta,
        effectiveBookingTime: event.buchungszeit,
      });
      continue;
    }

    if (!event.korrigiertId) continue;
    const original = byId.get(event.korrigiertId);
    if (!original || original.art === 'KORREKTUR') continue;
    if (event.delta !== -original.delta || event.sorte !== original.sorte) continue;

    result.push({
      eventId: event.id,
      sorte: event.sorte,
      sourceArt: original.art,
      delta: event.delta,
      effectiveBookingTime: original.buchungszeit,
    });
  }

  return result;
}

function emptySortStats() {
  return {
    dazugekommen: 0,
    weggekommen: 0,
    inventurdifferenz: 0,
    nettoBestandsaenderung: 0,
  };
}

export function statisticsForRange(
  events: readonly StoredEvent[],
  range: TimeRange,
  sorte?: string,
): PeriodStatistics {
  const result: PeriodStatistics = {
    dazugekommen: 0,
    weggekommen: 0,
    inventurdifferenz: 0,
    nettoBestandsaenderung: 0,
    bySort: {},
  };

  for (const activity of effectiveActivities(events)) {
    if (sorte && activity.sorte !== sorte) continue;
    if (!inRange(activity.effectiveBookingTime, range)) continue;

    const sortStats = result.bySort[activity.sorte] ?? emptySortStats();

    result.nettoBestandsaenderung += activity.delta;
    sortStats.nettoBestandsaenderung += activity.delta;

    if (activity.sourceArt === 'ZUGANG') {
      result.dazugekommen += activity.delta;
      sortStats.dazugekommen += activity.delta;
    } else if (activity.sourceArt === 'ABGANG') {
      result.weggekommen -= activity.delta;
      sortStats.weggekommen -= activity.delta;
    } else if (activity.sourceArt === 'INVENTUR') {
      result.inventurdifferenz += activity.delta;
      sortStats.inventurdifferenz += activity.delta;
    }

    result.bySort[activity.sorte] = sortStats;
  }

  return result;
}

function comparison(current: number, previous: number): ComparisonMetric {
  if (previous === 0) {
    return {
      current,
      previous,
      percentChange: current === 0 ? 0 : null,
    };
  }

  return {
    current,
    previous,
    percentChange: ((current - previous) / Math.abs(previous)) * 100,
  };
}

export function comparePeriod(
  events: readonly StoredEvent[],
  kind: StatisticsPeriodKind,
  nowIso: string,
  sorte?: string,
): PeriodComparison {
  const windows = periodWindow(kind, nowIso);
  const current = statisticsForRange(events, windows.current, sorte);
  const previous = statisticsForRange(events, windows.previous, sorte);

  return {
    dazugekommen: comparison(current.dazugekommen, previous.dazugekommen),
    weggekommen: comparison(current.weggekommen, previous.weggekommen),
    inventurdifferenz: comparison(
      current.inventurdifferenz,
      previous.inventurdifferenz,
    ),
  };
}

export interface StockPoint {
  at: string;
  bestand: number;
}

export function stockSeries(
  events: readonly StoredEvent[],
  range: TimeRange,
  sorte?: string,
): StockPoint[] {
  const deltasByInstant = new Map<string, number>();

  for (const activity of effectiveActivities(events)) {
    if (sorte && activity.sorte !== sorte) continue;
    const instant = Temporal.Instant.from(activity.effectiveBookingTime).toString();
    deltasByInstant.set(
      instant,
      (deltasByInstant.get(instant) ?? 0) + activity.delta,
    );
  }

  const entries = [...deltasByInstant.entries()].sort(([a], [b]) =>
    Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b)),
  );

  let bestand = 0;
  for (const [at, delta] of entries) {
    if (
      Temporal.Instant.compare(
        Temporal.Instant.from(at),
        Temporal.Instant.from(range.start),
      ) < 0
    ) {
      bestand += delta;
    }
  }

  const points: StockPoint[] = [{ at: range.start, bestand }];

  for (const [at, delta] of entries) {
    if (!inRange(at, range)) continue;
    bestand += delta;
    points.push({ at, bestand });
  }

  points.push({ at: range.end, bestand });
  return points;
}
