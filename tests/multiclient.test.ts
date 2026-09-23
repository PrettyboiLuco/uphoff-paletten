import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PalletEvent, StoredEvent } from '../src/domain/types';
import { UphoffLocalDb, listEvents, loadProjection } from '../src/persistence/localDb';
import { persistAndQueueEvent } from '../src/persistence/outbox';
import { computeCheckCode, getSyncHealth } from '../src/sync/health';
import { runFullSync, startRealtimeSync } from '../src/sync/reconcile';
import {
  RemoteCreateError,
  type RemoteCreateResult,
  type RemoteRealtimeEventStore,
  type RemoteUnsubscribe,
} from '../src/sync/types';

const dbNames: string[] = [];

function db(name: string): UphoffLocalDb {
  dbNames.push(name);
  return new UphoffLocalDb(name);
}

function event(
  id: string,
  device: string,
  delta: number,
  bookingTime = '2026-09-23T10:00:00+02:00',
): StoredEvent {
  return {
    id,
    geraetId: device,
    sorte: 'EURO',
    art: delta < 0 ? 'ABGANG' : 'ZUGANG',
    delta,
    buchungszeit: bookingTime,
    konfigVersion: 'v1',
    syncState: 'LOCAL_ONLY',
    createdLocalAt: bookingTime,
  };
}

class SharedRemote implements RemoteRealtimeEventStore {
  readonly events = new Map<string, PalletEvent>();
  readonly loseConfirmationOnce = new Set<string>();
  private readonly subscribers = new Set<{
    onEvent: (event: PalletEvent) => void | Promise<void>;
    onError: (error: unknown) => void;
  }>();
  reverseReads = false;
  serverClockIso = '2026-09-23T10:00:01.000Z';

  async createEvent(input: PalletEvent): Promise<RemoteCreateResult> {
    if (this.events.has(input.id)) {
      throw new RemoteCreateError('ALREADY_EXISTS', 'exists');
    }

    const stored = {
      ...input,
      serverzeit: this.serverClockIso,
    };
    this.events.set(input.id, stored);

    for (const subscriber of this.subscribers) {
      try {
        await subscriber.onEvent({ ...stored });
      } catch (error) {
        subscriber.onError(error);
      }
    }

    if (this.loseConfirmationOnce.delete(input.id)) {
      throw new RemoteCreateError('TRANSIENT', 'confirmation-lost');
    }

    return { status: 'CREATED' };
  }

  async getEvent(id: string): Promise<PalletEvent | undefined> {
    return this.events.get(id);
  }

  async listEvents(): Promise<PalletEvent[]> {
    const result = [...this.events.values()].map((item) => ({ ...item }));
    return this.reverseReads ? result.reverse() : result;
  }

  subscribeEvents(
    onEvent: (event: PalletEvent) => void | Promise<void>,
    onError: (error: unknown) => void,
  ): RemoteUnsubscribe {
    const subscriber = { onEvent, onError };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}

afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    const database = new UphoffLocalDb(name);
    await database.delete();
  }
});

describe('E2.4 multi-client convergence and fault injection', () => {
  it('delivers a foreign booking automatically to a subscribed device without a manual refresh', async () => {
    const remote = new SharedRemote();
    const phoneA = db('e24-realtime-a');
    const phoneB = db('e24-realtime-b');
    const errors: unknown[] = [];

    const unsubscribe = startRealtimeSync(
      phoneB,
      remote,
      () => '2026-09-23T10:00:02Z',
      (error) => errors.push(error),
    );

    await persistAndQueueEvent(
      phoneA,
      event('realtime-1', 'phone-a', 15),
      1000,
    );
    await runFullSync(
      phoneA,
      remote,
      1000,
      '2026-09-23T10:00:01Z',
    );

    const received = await phoneB.events.get('realtime-1');
    expect(received?.syncState).toBe('CONFIRMED');
    expect(received?.delta).toBe(15);
    expect(errors).toEqual([]);

    unsubscribe();
  });

  it('converges three independent clients after simultaneous bookings', async () => {
    const remote = new SharedRemote();
    const ipad = db('e24-ipad');
    const phoneA = db('e24-phone-a');
    const phoneB = db('e24-phone-b');

    await persistAndQueueEvent(ipad, event('ipad-1', 'ipad', 15), 1000);
    await persistAndQueueEvent(phoneA, event('a-1', 'phone-a', 15), 1000);
    await persistAndQueueEvent(phoneB, event('b-1', 'phone-b', -15), 1000);

    await runFullSync(ipad, remote, 1000, '2026-09-23T10:00:01Z');
    await runFullSync(phoneA, remote, 1000, '2026-09-23T10:00:02Z');
    await runFullSync(phoneB, remote, 1000, '2026-09-23T10:00:03Z');

    remote.reverseReads = true;
    await runFullSync(ipad, remote, 2000, '2026-09-23T10:00:04Z');
    await runFullSync(phoneA, remote, 2000, '2026-09-23T10:00:05Z');
    await runFullSync(phoneB, remote, 2000, '2026-09-23T10:00:06Z');

    const projections = await Promise.all([
      loadProjection(ipad),
      loadProjection(phoneA),
      loadProjection(phoneB),
    ]);

    expect(projections[0]).toEqual(projections[1]);
    expect(projections[1]).toEqual(projections[2]);
    expect(projections[0].bestandGesamt).toBe(15);

    const codes = await Promise.all([
      computeCheckCode(await listEvents(ipad)),
      computeCheckCode(await listEvents(phoneA)),
      computeCheckCode(await listEvents(phoneB)),
    ]);

    expect(codes[0]).toEqual(codes[1]);
    expect(codes[1]).toEqual(codes[2]);
    expect(remote.events.size).toBe(3);
  });

  it('converges correctly even when a correction is received before its original', async () => {
    const remote = new SharedRemote();
    remote.events.set('original-order', {
      id: 'original-order',
      geraetId: 'phone-a',
      sorte: 'EURO',
      art: 'ZUGANG',
      delta: 15,
      buchungszeit: '2026-09-23T10:00:00+02:00',
      serverzeit: '2026-09-23T10:00:01Z',
      konfigVersion: 'v1',
    });
    remote.events.set('korr_original-order', {
      id: 'korr_original-order',
      geraetId: 'phone-a',
      sorte: 'EURO',
      art: 'KORREKTUR',
      delta: -15,
      buchungszeit: '2026-09-23T10:00:02+02:00',
      serverzeit: '2026-09-23T10:00:03Z',
      konfigVersion: 'v1',
      korrigiertId: 'original-order',
    });
    remote.reverseReads = true;

    const client = db('e24-correction-order');
    await runFullSync(
      client,
      remote,
      1000,
      '2026-09-23T10:00:04Z',
    );

    const projection = await loadProjection(client);
    expect(projection.bestandGesamt).toBe(0);
    expect(projection.dazugekommen).toBe(0);
    expect(projection.anomalies).toEqual([]);
  });

  it('keeps 50 offline bookings across app kill and later converges them to another device', async () => {
    const remote = new SharedRemote();
    const name = 'e24-offline-kill';
    let phone = db(name);

    for (let i = 0; i < 50; i += 1) {
      await persistAndQueueEvent(
        phone,
        event(
          `offline-${i}`,
          'phone-a',
          i % 5 === 0 ? -15 : 15,
          `2026-09-23T11:${String(i % 60).padStart(2, '0')}:00+02:00`,
        ),
        1000 + i,
      );
    }

    expect(await phone.events.count()).toBe(50);
    expect(await phone.outbox.count()).toBe(50);
    await phone.close();

    phone = new UphoffLocalDb(name);
    expect(await phone.events.count()).toBe(50);
    expect(await phone.outbox.count()).toBe(50);

    await runFullSync(phone, remote, 10_000, '2026-09-23T12:00:00Z');
    expect(remote.events.size).toBe(50);
    expect(await phone.outbox.count()).toBe(0);

    const ipad = db('e24-offline-ipad');
    await runFullSync(ipad, remote, 10_001, '2026-09-23T12:00:01Z');

    expect(await ipad.events.count()).toBe(50);
    expect(await loadProjection(ipad)).toEqual(await loadProjection(phone));
    expect(computeCheckCode(await listEvents(ipad))).toEqual(
      computeCheckCode(await listEvents(phone)),
    );

    await phone.close();
  });

  it('recovers a server-accepted write whose acknowledgement was lost', async () => {
    const remote = new SharedRemote();
    const phone = db('e24-lost-ack');

    remote.loseConfirmationOnce.add('lost-ack');
    await persistAndQueueEvent(
      phone,
      event('lost-ack', 'phone-a', 15),
      1000,
    );

    const result = await runFullSync(
      phone,
      remote,
      1000,
      '2026-09-23T10:00:02Z',
    );

    expect(result.push.retried).toBe(1);
    expect(result.pull.confirmedExisting).toBe(1);
    expect(remote.events.size).toBe(1);
    expect(await phone.outbox.count()).toBe(0);
    expect((await phone.events.get('lost-ack'))?.syncState).toBe('CONFIRMED');
  });

  it('preserves booking time when syncing after midnight', async () => {
    const remote = new SharedRemote();
    remote.serverClockIso = '2026-09-23T22:10:00.000Z';
    const phone = db('e24-midnight');

    const bookingTime = '2026-09-23T23:59:50+02:00';
    await persistAndQueueEvent(
      phone,
      event('midnight', 'phone-a', 15, bookingTime),
      1000,
    );

    await runFullSync(
      phone,
      remote,
      1000,
      '2026-09-24T00:10:00+02:00',
    );

    expect(remote.events.get('midnight')?.buchungszeit).toBe(bookingTime);
    expect((await phone.events.get('midnight'))?.buchungszeit).toBe(bookingTime);
  });

  it('marks a large booking/server time deviation for audit without changing the booking time', async () => {
    const remote = new SharedRemote();
    remote.serverClockIso = '2026-09-23T15:00:00.000Z';
    const phone = db('e24-clock-skew');

    const bookingTime = '2026-09-23T10:00:00+02:00';
    await persistAndQueueEvent(
      phone,
      event('clock-skew', 'phone-a', 15, bookingTime),
      1000,
    );

    await runFullSync(
      phone,
      remote,
      1000,
      '2026-09-23T15:00:01Z',
    );

    const stored = await phone.events.get('clock-skew');
    expect(stored?.buchungszeit).toBe(bookingTime);
    expect(stored?.clockSkewFlag).toBe(true);
  });

  it('never reports SYNCHRON while work is pending and reports it after convergence', async () => {
    const remote = new SharedRemote();
    const phone = db('e24-health');

    expect((await getSyncHealth(phone)).state).toBe('NEVER_SYNCED');

    await persistAndQueueEvent(phone, event('health-1', 'phone-a', 15), 1000);
    const pending = await getSyncHealth(phone);
    expect(pending.state).toBe('PENDING');
    expect(pending.pendingCount).toBe(1);

    await runFullSync(
      phone,
      remote,
      1000,
      '2026-09-23T10:00:01Z',
    );

    const healthy = await getSyncHealth(phone);
    expect(healthy.state).toBe('SYNCHRON');
    expect(healthy.pendingCount).toBe(0);
    expect(healthy.rejectedCount).toBe(0);
  });

  it('preserves the conflicting local attempt for audit and adopts the server canonical event', async () => {
    const remote = new SharedRemote();
    remote.events.set('collision', {
      id: 'collision',
      geraetId: 'phone-b',
      sorte: 'EURO',
      art: 'ZUGANG',
      delta: 17,
      buchungszeit: '2026-09-23T10:00:00+02:00',
      serverzeit: '2026-09-23T10:00:01Z',
      konfigVersion: 'v1',
    });

    const phone = db('e24-conflict-audit');
    await persistAndQueueEvent(
      phone,
      event('collision', 'phone-a', 15),
      1000,
    );

    const sync = await runFullSync(
      phone,
      remote,
      1000,
      '2026-09-23T10:00:02Z',
    );

    expect(sync.push.conflicts).toBe(1);
    expect(sync.pull.conflicts).toBe(1);

    const canonical = await phone.events.get('collision');
    expect(canonical?.delta).toBe(17);
    expect(canonical?.geraetId).toBe('phone-b');
    expect(canonical?.syncState).toBe('CONFIRMED');

    const conflict = await phone.conflicts.get('conflict_collision');
    expect(conflict?.localEvent.delta).toBe(15);
    expect(conflict?.remoteEvent.delta).toBe(17);
    expect(await phone.outbox.count()).toBe(0);
  });
});
