import type { StoredEvent } from '../domain/types';
import { computeCheckCode } from '../sync/health';
import {
  berlinDateKey,
  effectiveActivities,
  statisticsForRange,
  type PeriodStatistics,
  type TimeRange,
} from './statistics';

export interface AggregateRevision {
  id: string;
  bucketType: 'DAY' | 'MONTH';
  bucketKey: string;
  revision: number;
  generatedAt: string;
  sourceEventCount: number;
  checkCode: ReturnType<typeof computeCheckCode>;
  stats: PeriodStatistics;
}

export interface AggregateStore {
  list(bucketType: 'DAY' | 'MONTH', bucketKey: string): Promise<AggregateRevision[]>;
  append(revision: AggregateRevision): Promise<void>;
}

export function monthKey(iso: string): string {
  return berlinDateKey(iso).slice(0, 7);
}

export function eventsAffectingRange(
  events: readonly StoredEvent[],
  range: TimeRange,
): StoredEvent[] {
  const effectiveIds = new Set(
    effectiveActivities(events)
      .filter((activity) => {
        const t = Date.parse(activity.effectiveBookingTime);
        return t >= Date.parse(range.start) && t < Date.parse(range.end);
      })
      .map((activity) => activity.eventId),
  );

  return events.filter(
    (event) => effectiveIds.has(event.id) || (
      event.art === 'KORREKTUR'
      && event.korrigiertId !== undefined
      && events.some(
        (candidate) =>
          candidate.id === event.korrigiertId
          && effectiveIds.has(candidate.id),
      )
    ),
  );
}

export async function appendAggregateRevision(
  store: AggregateStore,
  bucketType: 'DAY' | 'MONTH',
  bucketKey: string,
  range: TimeRange,
  events: readonly StoredEvent[],
  generatedAt: string,
): Promise<AggregateRevision> {
  const prior = await store.list(bucketType, bucketKey);
  const affected = eventsAffectingRange(events, range);

  const revision: AggregateRevision = {
    id: `${bucketType.toLowerCase()}_${bucketKey}_r${prior.length + 1}`,
    bucketType,
    bucketKey,
    revision: prior.length + 1,
    generatedAt,
    sourceEventCount: affected.length,
    checkCode: computeCheckCode(affected),
    stats: statisticsForRange(events, range),
  };

  await store.append(revision);
  return revision;
}

export function aggregatesMatchRaw(
  revision: AggregateRevision,
  range: TimeRange,
  events: readonly StoredEvent[],
): boolean {
  const affected = eventsAffectingRange(events, range);
  return JSON.stringify({
    sourceEventCount: revision.sourceEventCount,
    checkCode: revision.checkCode,
    stats: revision.stats,
  }) === JSON.stringify({
    sourceEventCount: affected.length,
    checkCode: computeCheckCode(affected),
    stats: statisticsForRange(events, range),
  });
}
