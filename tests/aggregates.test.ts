import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/domain/types';
import { UphoffLocalDb } from '../src/persistence/localDb';
import { IndexedDbAggregateStore } from '../src/persistence/aggregateStore';
import {
  aggregatesMatchRaw,
  appendAggregateRevision,
  type AggregateRevision,
  type AggregateStore,
} from '../src/statistics/aggregates';

const dbNames: string[] = [];

class MemoryAggregateStore implements AggregateStore {
  readonly revisions: AggregateRevision[] = [];

  async list(
    bucketType: 'DAY' | 'MONTH',
    bucketKey: string,
  ): Promise<AggregateRevision[]> {
    return this.revisions.filter(
      (revision) =>
        revision.bucketType === bucketType
        && revision.bucketKey === bucketKey,
    );
  }

  async append(revision: AggregateRevision): Promise<void> {
    this.revisions.push(revision);
  }
}

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

afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    const database = new UphoffLocalDb(name);
    await database.delete();
  }
  it('persists aggregate revisions across IndexedDB reopen', async () => {
    const name = 'e3-aggregate-persistence';
    dbNames.push(name);
    let database = new UphoffLocalDb(name);
    let store = new IndexedDbAggregateStore(database);
    const events = [
      event('persist-a', 'ZUGANG', 15, '2026-09-10T08:00:00+02:00'),
    ];

    await appendAggregateRevision(
      store,
      'MONTH',
      '2026-09',
      september,
      events,
      '2026-10-01T00:00:00Z',
    );
    await database.close();

    database = new UphoffLocalDb(name);
    store = new IndexedDbAggregateStore(database);
    const revisions = await store.list('MONTH', '2026-09');

    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revision).toBe(1);
    expect(revisions[0]?.stats.dazugekommen).toBe(15);
    await database.close();
  });
});

const september = {
  start: '2026-08-31T22:00:00Z',
  end: '2026-09-30T22:00:00Z',
};

describe('E3 aggregate revisions', () => {
  it('creates the first revision from raw events and verifies it exactly', async () => {
    const store = new MemoryAggregateStore();
    const events = [
      event('start', 'ANFANGSBESTAND', 100, '2026-09-01T08:00:00+02:00'),
      event('in', 'ZUGANG', 15, '2026-09-05T08:00:00+02:00'),
      event('out', 'ABGANG', -15, '2026-09-06T08:00:00+02:00'),
    ];

    const revision = await appendAggregateRevision(
      store,
      'MONTH',
      '2026-09',
      september,
      events,
      '2026-10-01T00:00:00Z',
    );

    expect(revision.revision).toBe(1);
    expect(revision.id).toBe('month_2026-09_r1');
    expect(revision.stats.dazugekommen).toBe(15);
    expect(revision.stats.weggekommen).toBe(15);
    expect(aggregatesMatchRaw(revision, september, events)).toBe(true);
  });

  it('creates a new revision when a late correction changes a closed month', async () => {
    const store = new MemoryAggregateStore();
    const original = event(
      'out-late',
      'ABGANG',
      -15,
      '2026-09-20T08:00:00+02:00',
    );
    const before = [original];

    const r1 = await appendAggregateRevision(
      store,
      'MONTH',
      '2026-09',
      september,
      before,
      '2026-10-01T00:00:00Z',
    );

    expect(r1.stats.weggekommen).toBe(15);

    const correction = event(
      'korr_out-late',
      'KORREKTUR',
      15,
      '2026-10-10T08:00:00+02:00',
      { korrigiertId: 'out-late' },
    );
    const after = [original, correction];

    expect(aggregatesMatchRaw(r1, september, after)).toBe(false);

    const r2 = await appendAggregateRevision(
      store,
      'MONTH',
      '2026-09',
      september,
      after,
      '2026-10-10T08:01:00Z',
    );

    expect(r2.revision).toBe(2);
    expect(r2.id).toBe('month_2026-09_r2');
    expect(r2.stats.weggekommen).toBe(0);
    expect(aggregatesMatchRaw(r2, september, after)).toBe(true);
    expect(store.revisions).toHaveLength(2);
  });

  it('detects raw-data drift through source count/check code/stats', async () => {
    const store = new MemoryAggregateStore();
    const events = [
      event('a', 'ZUGANG', 15, '2026-09-10T08:00:00+02:00'),
      event('b', 'ABGANG', -15, '2026-09-11T08:00:00+02:00'),
    ];

    const revision = await appendAggregateRevision(
      store,
      'MONTH',
      '2026-09',
      september,
      events,
      '2026-10-01T00:00:00Z',
    );

    const changed = [
      ...events,
      event('c', 'ZUGANG', 1, '2026-09-12T08:00:00+02:00'),
    ];

    expect(aggregatesMatchRaw(revision, september, changed)).toBe(false);
  });

  it('keeps a correction tied to the original month even when correction tap is in next month', async () => {
    const store = new MemoryAggregateStore();
    const original = event(
      'in-sep',
      'ZUGANG',
      15,
      '2026-09-30T23:30:00+02:00',
    );
    const correction = event(
      'korr_in-sep',
      'KORREKTUR',
      -15,
      '2026-10-02T08:00:00+02:00',
      { korrigiertId: 'in-sep' },
    );

    const revision = await appendAggregateRevision(
      store,
      'MONTH',
      '2026-09',
      september,
      [original, correction],
      '2026-10-02T08:01:00Z',
    );

    expect(revision.stats.dazugekommen).toBe(0);
    expect(revision.sourceEventCount).toBe(2);
    expect(aggregatesMatchRaw(revision, september, [original, correction])).toBe(true);
  });
});
