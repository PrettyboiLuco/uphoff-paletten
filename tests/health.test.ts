import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { UphoffLocalDb } from '../src/persistence/localDb';
import { getSyncHealth } from '../src/sync/health';
import type { StoredEvent } from '../src/domain/types';

const dbNames: string[] = [];

function db(name: string) {
  dbNames.push(name);
  return new UphoffLocalDb(name);
}

afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    const database = new UphoffLocalDb(name);
    await database.delete();
  }
});

function event(
  id: string,
  syncState: StoredEvent['syncState'],
): StoredEvent {
  return {
    id,
    geraetId: 'device',
    sorte: 'typ-1',
    art: 'ZUGANG',
    delta: 15,
    buchungszeit: '2026-09-24T06:00:00Z',
    konfigVersion: 'v1',
    syncState,
    createdLocalAt: '2026-09-24T06:00:00Z',
  };
}

describe('sync health', () => {
  it('never reports synchronized before the first successful full sync', async () => {
    const database = db('health-never');
    expect((await getSyncHealth(database, Date.parse('2026-09-24T07:00:00Z'))).state)
      .toBe('NEVER_SYNCED');
    await database.close();
  });

  it('reports stale when the last successful reconciliation is too old', async () => {
    const database = db('health-stale');
    await database.meta.put({
      key: 'lastSuccessfulSyncAt',
      value: '2026-09-24T06:00:00Z',
    });

    const health = await getSyncHealth(
      database,
      Date.parse('2026-09-24T06:11:00Z'),
      10 * 60_000,
    );

    expect(health.state).toBe('STALE');
    await database.close();
  });

  it('reports stale when the stored sync timestamp is implausibly far in the future', async () => {
    const database = db('health-future');
    await database.meta.put({
      key: 'lastSuccessfulSyncAt',
      value: '2026-09-24T07:00:00Z',
    });

    const health = await getSyncHealth(
      database,
      Date.parse('2026-09-24T06:40:00Z'),
      10 * 60_000,
    );

    expect(health.state).toBe('STALE');
    await database.close();
  });


  it('keeps pending and rejected states higher priority than staleness', async () => {
    const database = db('health-priority');
    await database.meta.put({
      key: 'lastSuccessfulSyncAt',
      value: '2026-09-24T06:00:00Z',
    });
    await database.events.add(event('pending', 'PENDING'));

    expect(
      (
        await getSyncHealth(
          database,
          Date.parse('2026-09-24T07:00:00Z'),
        )
      ).state,
    ).toBe('PENDING');

    await database.events.put({
      ...event('pending', 'REJECTED'),
      rejectionReason: 'PERMISSION_DENIED',
    });

    expect(
      (
        await getSyncHealth(
          database,
          Date.parse('2026-09-24T07:00:00Z'),
        )
      ).state,
    ).toBe('REJECTED');
    await database.close();
  });

  it('reports synchronized only while the last full sync is fresh', async () => {
    const database = db('health-fresh');
    await database.meta.put({
      key: 'lastSuccessfulSyncAt',
      value: '2026-09-24T06:05:00Z',
    });

    expect(
      (
        await getSyncHealth(
          database,
          Date.parse('2026-09-24T06:10:00Z'),
        )
      ).state,
    ).toBe('SYNCHRON');
    await database.close();
  });
});
