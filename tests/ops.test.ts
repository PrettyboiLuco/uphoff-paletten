import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PalletEvent, StoredEvent } from '../src/domain/types';
import { loadProjection, UphoffLocalDb } from '../src/persistence/localDb';
import { persistAndQueueEvent } from '../src/persistence/outbox';
import {
  createCsvAudit,
  createJsonBackup,
  isExternalBackupDue,
  markExternalBackupDone,
  restoreJsonBackup,
} from '../src/ops/backup';
import {
  logOperationalError,
  recentOperationalErrors,
} from '../src/ops/errorLog';
import {
  localHealthSnapshot,
  runServerSelfTest,
} from '../src/ops/selfTest';
import {
  RemoteCreateError,
  type RemoteCreateResult,
  type RemoteReadableEventStore,
} from '../src/sync/types';

const dbNames: string[] = [];

function db(name: string): UphoffLocalDb {
  dbNames.push(name);
  return new UphoffLocalDb(name);
}

function event(
  id: string,
  delta: number,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return {
    id,
    geraetId: 'ipad',
    sorte: 'EURO',
    art: delta < 0 ? 'ABGANG' : 'ZUGANG',
    delta,
    buchungszeit: '2026-09-23T10:00:00+02:00',
    konfigVersion: 'v1',
    syncState: 'CONFIRMED',
    createdLocalAt: '2026-09-23T10:00:00+02:00',
    ...overrides,
  };
}

class FakeRemote implements RemoteReadableEventStore {
  readonly events = new Map<string, PalletEvent>();

  async createEvent(input: PalletEvent): Promise<RemoteCreateResult> {
    if (this.events.has(input.id)) {
      throw new RemoteCreateError('ALREADY_EXISTS', 'exists');
    }
    this.events.set(input.id, { ...input });
    return { status: 'CREATED' };
  }

  async getEvent(id: string): Promise<PalletEvent | undefined> {
    return this.events.get(id);
  }

  async listEvents(): Promise<PalletEvent[]> {
    return [...this.events.values()].map((item) => ({ ...item }));
  }
}

afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    const database = new UphoffLocalDb(name);
    await database.delete();
  }
});

describe('E6 backup, self-test and operations', () => {
  it('round-trips JSON backup without changing IDs or projection', async () => {
    const source = db('e6-source');
    await source.events.add(event('confirmed', 15));
    await persistAndQueueEvent(
      source,
      event('pending', -15, { syncState: 'LOCAL_ONLY' }),
      1000,
    );

    const before = await loadProjection(source);
    const json = await createJsonBackup(source, '2026-09-23T12:00:00Z');

    const target = db('e6-target');
    const restored = await restoreJsonBackup(target, json);
    const after = await loadProjection(target);

    expect(restored.inserted).toBe(2);
    expect(after).toEqual(before);
    expect(await target.events.count()).toBe(2);
    expect(await target.outbox.count()).toBe(1);
    expect((await target.events.get('confirmed'))?.id).toBe('confirmed');
    expect((await target.events.get('pending'))?.id).toBe('pending');

    await source.close();
    await target.close();
  });

  it('is idempotent when the same backup is restored twice', async () => {
    const source = db('e6-idempotent-source');
    await source.events.add(event('same', 15));
    const json = await createJsonBackup(source, '2026-09-23T12:00:00Z');

    const target = db('e6-idempotent-target');
    await restoreJsonBackup(target, json);
    const second = await restoreJsonBackup(target, json);

    expect(await target.events.count()).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.merged).toBe(1);

    await source.close();
    await target.close();
  });

  it('aborts restore atomically on same-id different-content conflict', async () => {
    const source = db('e6-conflict-source');
    await source.events.bulkAdd([
      event('collision', 15),
      event('should-not-appear', 15),
    ]);
    const json = await createJsonBackup(source, '2026-09-23T12:00:00Z');

    const target = db('e6-conflict-target');
    await target.events.add(event('collision', 17));

    await expect(restoreJsonBackup(target, json)).rejects.toThrow(
      'restore-id-content-conflict:collision',
    );

    expect(await target.events.count()).toBe(1);
    expect(await target.events.get('should-not-appear')).toBeUndefined();
    expect((await target.events.get('collision'))?.delta).toBe(17);

    await source.close();
    await target.close();
  });

  it('rejects malformed backup before writing anything', async () => {
    const target = db('e6-malformed');

    await expect(
      restoreJsonBackup(target, '{"manifest":{"schemaVersion":1,"app":"uphoff-paletten"},"events":[{"id":"x"}],"outbox":[],"conflicts":[]}'),
    ).rejects.toThrow('invalid-backup-events');

    expect(await target.events.count()).toBe(0);
    await target.close();
  });

  it('rejects a structurally valid-looking backup with an unknown event type', async () => {
    const target = db('e6-invalid-art');
    const malformed = {
      manifest: {
        schemaVersion: 1,
        exportedAt: '2026-09-23T12:00:00Z',
        app: 'uphoff-paletten',
        eventCount: 1,
        outboxCount: 0,
        conflictCount: 0,
      },
      events: [
        {
          id: 'bad-art',
          geraetId: 'ipad',
          sorte: 'EURO',
          art: 'MAGIC',
          delta: 999,
          buchungszeit: '2026-09-23T10:00:00Z',
          konfigVersion: 'v1',
          syncState: 'CONFIRMED',
          createdLocalAt: '2026-09-23T10:00:00Z',
        },
      ],
      outbox: [],
      conflicts: [],
    };

    await expect(
      restoreJsonBackup(target, JSON.stringify(malformed)),
    ).rejects.toThrow('invalid-backup-events');

    expect(await target.events.count()).toBe(0);
    await target.close();
  });

  it('rejects backup manifest counts that do not match the actual payload', async () => {
    const target = db('e6-manifest-mismatch');
    const malformed = {
      manifest: {
        schemaVersion: 1,
        exportedAt: '2026-09-23T12:00:00Z',
        app: 'uphoff-paletten',
        eventCount: 2,
        outboxCount: 0,
        conflictCount: 0,
      },
      events: [
        event('only-one', 15),
      ],
      outbox: [],
      conflicts: [],
    };

    await expect(
      restoreJsonBackup(target, JSON.stringify(malformed)),
    ).rejects.toThrow('backup-manifest-count-mismatch');

    expect(await target.events.count()).toBe(0);
    await target.close();
  });


  it('creates semicolon CSV with escaped user-visible values', async () => {
    const database = db('e6-csv');
    await database.events.add(
      event('csv', 15, { person: 'Max "Test"; Nord' }),
    );

    const csv = await createCsvAudit(database);
    expect(csv).toContain('"person"');
    expect(csv).toContain('"Max ""Test""; Nord"');
    expect(csv.split('\n')).toHaveLength(2);
    await database.close();
  });

  it('marks external backup due initially and again after seven days', async () => {
    const database = db('e6-due');

    expect(
      await isExternalBackupDue(database, '2026-09-23T12:00:00Z'),
    ).toBe(true);

    await markExternalBackupDone(database, '2026-09-23T12:00:00Z');
    expect(
      await isExternalBackupDue(database, '2026-09-29T12:00:00Z'),
    ).toBe(false);
    expect(
      await isExternalBackupDue(database, '2026-09-30T12:00:00Z'),
    ).toBe(true);

    await database.close();
  });

  it('persists operational errors in newest-first order', async () => {
    const database = db('e6-errors');
    await logOperationalError(database, {
      code: 'FIRST',
      severity: 'WARNING',
      message: 'first',
      occurredAt: '2026-09-23T10:00:00Z',
    });
    await logOperationalError(database, {
      code: 'SECOND',
      severity: 'ERROR',
      message: 'second',
      occurredAt: '2026-09-23T11:00:00Z',
      context: { eventId: 'e-1' },
    });

    const recent = await recentOperationalErrors(database);
    expect(recent.map((item) => item.code)).toEqual(['SECOND', 'FIRST']);
    await database.close();
  });

  it('reports MATCH only when confirmed local and remote count+sum agree', async () => {
    const database = db('e6-match');
    await database.events.bulkAdd([
      event('a', 15),
      event('b', -15),
    ]);

    const remote = new FakeRemote();
    remote.events.set('a', { ...event('a', 15), syncState: undefined } as unknown as PalletEvent);
    remote.events.set('b', { ...event('b', -15), syncState: undefined } as unknown as PalletEvent);

    const result = await runServerSelfTest(
      database,
      remote,
      '2026-09-23T12:00:00Z',
    );

    expect(result.status).toBe('MATCH');
    expect(result.local.eventCount).toBe(2);
    await database.close();
  });

  it('reports MISMATCH when remote canonical data differs', async () => {
    const database = db('e6-mismatch');
    await database.events.add(event('a', 15));

    const remote = new FakeRemote();
    const remoteEvent: PalletEvent = {
      id: 'a',
      geraetId: 'ipad',
      sorte: 'EURO',
      art: 'ZUGANG',
      delta: 17,
      buchungszeit: '2026-09-23T10:00:00+02:00',
      konfigVersion: 'v1',
    };
    remote.events.set('a', remoteEvent);

    const result = await runServerSelfTest(
      database,
      remote,
      '2026-09-23T12:00:00Z',
    );

    expect(result.status).toBe('MISMATCH');
    await database.close();
  });

  it('reports ATTENTION instead of false green while pending work exists', async () => {
    const database = db('e6-attention');
    await persistAndQueueEvent(
      database,
      event('pending-only', 15, { syncState: 'LOCAL_ONLY' }),
      1000,
    );

    const remote = new FakeRemote();
    const local = await localHealthSnapshot(
      database,
      '2026-09-23T12:00:00Z',
    );
    const result = await runServerSelfTest(
      database,
      remote,
      '2026-09-23T12:00:00Z',
    );

    expect(local.pendingCount).toBe(1);
    expect(result.status).toBe('ATTENTION');
    await database.close();
  });
});
