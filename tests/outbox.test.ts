import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PalletEvent, StoredEvent } from '../src/domain/types';
import { UphoffLocalDb } from '../src/persistence/localDb';
import { persistAndQueueEvent } from '../src/persistence/outbox';
import { runSyncPass } from '../src/sync/syncEngine';
import {
  RemoteCreateError,
  type RemoteCreateResult,
  type RemoteEventStore,
} from '../src/sync/types';

const dbNames: string[] = [];

function makeDb(name: string): UphoffLocalDb {
  dbNames.push(name);
  return new UphoffLocalDb(name);
}

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'event-1',
    geraetId: 'ipad',
    sorte: 'EURO',
    art: 'ZUGANG',
    delta: 15,
    buchungszeit: '2026-09-23T12:00:00+02:00',
    konfigVersion: 'v1',
    syncState: 'LOCAL_ONLY',
    createdLocalAt: '2026-09-23T12:00:00+02:00',
    ...overrides,
  };
}

class FakeRemote implements RemoteEventStore {
  readonly events = new Map<string, PalletEvent>();
  mode:
    | 'NORMAL'
    | 'TRANSIENT'
    | 'LOST_CONFIRMATION'
    | 'PERMISSION_DENIED'
    | 'UNAUTHENTICATED'
    | 'QUOTA_EXHAUSTED' = 'NORMAL';

  async createEvent(event: PalletEvent): Promise<RemoteCreateResult> {
    if (this.mode === 'TRANSIENT') {
      throw new RemoteCreateError('TRANSIENT', 'offline');
    }
    if (this.mode === 'PERMISSION_DENIED') {
      throw new RemoteCreateError('PERMISSION_DENIED', 'denied');
    }
    if (this.mode === 'UNAUTHENTICATED') {
      throw new RemoteCreateError('UNAUTHENTICATED', 'expired');
    }
    if (this.mode === 'QUOTA_EXHAUSTED') {
      throw new RemoteCreateError('QUOTA_EXHAUSTED', 'quota');
    }

    if (this.events.has(event.id)) {
      throw new RemoteCreateError('ALREADY_EXISTS', 'exists');
    }

    this.events.set(event.id, {
      ...event,
      serverzeit: '2026-09-23T10:00:01Z',
    });

    if (this.mode === 'LOST_CONFIRMATION') {
      throw new RemoteCreateError('TRANSIENT', 'response-lost');
    }

    return { status: 'CREATED' };
  }

  async getEvent(id: string): Promise<PalletEvent | undefined> {
    return this.events.get(id);
  }
}

afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    const db = new UphoffLocalDb(name);
    await db.delete();
  }
});

describe('E2.2 outbox and retry', () => {
  it('atomically persists the event and its outbox item', async () => {
    const db = makeDb('e22-atomic');
    const result = await persistAndQueueEvent(db, makeEvent(), 1000);

    expect(result.status).toBe('QUEUED');
    expect(await db.events.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);

    const stored = await db.events.get('event-1');
    expect(stored?.syncState).toBe('PENDING');
    await db.close();
  });

  it('survives restart with its pending outbox work intact', async () => {
    const name = 'e22-restart';
    let db = makeDb(name);
    await persistAndQueueEvent(db, makeEvent(), 1000);
    await db.close();

    db = new UphoffLocalDb(name);
    expect(await db.events.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
    expect((await db.events.get('event-1'))?.syncState).toBe('PENDING');
    await db.close();
  });

  it('confirms a successfully created remote event and removes it from outbox', async () => {
    const db = makeDb('e22-confirm');
    const remote = new FakeRemote();
    await persistAndQueueEvent(db, makeEvent(), 1000);

    const result = await runSyncPass(db, remote, 1000);

    expect(result.confirmed).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.events.get('event-1'))?.syncState).toBe('CONFIRMED');
    expect(remote.events.size).toBe(1);
    await db.close();
  });

  it('keeps a transient failure pending and applies bounded backoff', async () => {
    const db = makeDb('e22-retry');
    const remote = new FakeRemote();
    remote.mode = 'TRANSIENT';
    await persistAndQueueEvent(db, makeEvent(), 1000);

    const first = await runSyncPass(db, remote, 1000);
    expect(first.retried).toBe(1);

    const item = await db.outbox.get('event-1');
    expect(item?.attemptCount).toBe(1);
    expect(item?.nextAttemptAt).toBe(2000);
    expect((await db.events.get('event-1'))?.syncState).toBe('PENDING');

    const tooEarly = await runSyncPass(db, remote, 1500);
    expect(tooEarly.retried).toBe(0);
    expect((await db.outbox.get('event-1'))?.attemptCount).toBe(1);
    await db.close();
  });

  it('recovers a lost server confirmation without creating a duplicate', async () => {
    const db = makeDb('e22-lost-confirmation');
    const remote = new FakeRemote();
    remote.mode = 'LOST_CONFIRMATION';
    await persistAndQueueEvent(db, makeEvent(), 1000);

    const first = await runSyncPass(db, remote, 1000);
    expect(first.retried).toBe(1);
    expect(remote.events.size).toBe(1);

    remote.mode = 'NORMAL';
    const second = await runSyncPass(db, remote, 2000);

    expect(second.confirmed).toBe(1);
    expect(remote.events.size).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.events.get('event-1'))?.syncState).toBe('CONFIRMED');
    await db.close();
  });

  it('rejects same-id remote content conflict instead of overwriting it', async () => {
    const db = makeDb('e22-conflict');
    const remote = new FakeRemote();

    remote.events.set('event-1', {
      id: 'event-1',
      geraetId: 'ipad',
      sorte: 'EURO',
      art: 'ZUGANG',
      delta: 17,
      buchungszeit: '2026-09-23T12:00:00+02:00',
      konfigVersion: 'v1',
    });

    await persistAndQueueEvent(db, makeEvent({ delta: 15 }), 1000);
    const result = await runSyncPass(db, remote, 1000);

    expect(result.conflicts).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    const stored = await db.events.get('event-1');
    expect(stored?.syncState).toBe('REJECTED');
    expect(stored?.rejectionReason).toBe('ID_CONTENT_CONFLICT');
    expect(remote.events.get('event-1')?.delta).toBe(17);
    await db.close();
  });

  it('marks permanent permission errors rejected and does not silently retry forever', async () => {
    const db = makeDb('e22-permission');
    const remote = new FakeRemote();
    remote.mode = 'PERMISSION_DENIED';
    await persistAndQueueEvent(db, makeEvent(), 1000);

    const result = await runSyncPass(db, remote, 1000);

    expect(result.rejected).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.events.get('event-1'))?.syncState).toBe('REJECTED');
    expect((await db.events.get('event-1'))?.rejectionReason).toBe('PERMISSION_DENIED');
    await db.close();
  });

  it('keeps auth and quota failures visible as pending retryable work', async () => {
    for (const mode of ['UNAUTHENTICATED', 'QUOTA_EXHAUSTED'] as const) {
      const db = makeDb(`e22-${mode}`);
      const remote = new FakeRemote();
      remote.mode = mode;
      await persistAndQueueEvent(db, makeEvent({ id: mode }), 1000);

      const result = await runSyncPass(db, remote, 1000);
      expect(result.retried).toBe(1);
      expect((await db.events.get(mode))?.syncState).toBe('PENDING');
      expect((await db.outbox.get(mode))?.lastError).toBe(mode);
      await db.close();
    }
  });

  it('never creates a second local event when the same tap is queued twice', async () => {
    const db = makeDb('e22-local-idempotence');
    const e = makeEvent();

    expect((await persistAndQueueEvent(db, e, 1000)).status).toBe('QUEUED');
    expect((await persistAndQueueEvent(db, { ...e }, 1001)).status).toBe('ALREADY_QUEUED');

    expect(await db.events.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
    await db.close();
  });
});
