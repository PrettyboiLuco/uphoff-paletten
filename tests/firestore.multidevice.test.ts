import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, Timestamp, type Firestore } from 'firebase/firestore';
import { loadProjection, UphoffLocalDb } from '../src/persistence/localDb';
import { persistAndQueueEvent } from '../src/persistence/outbox';
import { FirestoreRemoteEventStore } from '../src/sync/firestoreRemoteStore';
import { runFullSync } from '../src/sync/reconcile';
import type { StoredEvent } from '../src/domain/types';

let env: RulesTestEnvironment;
const dbNames: string[] = [];
const sorts = ['typ-1', 'typ-2', 'typ-3', 'typ-4', 'typ-5', 'typ-6', 'typ-7'];

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'uphoff-paletten-test',
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all(['a', 'b'].map((uid) => setDoc(doc(db, 'devices', uid), {
      enabled: true, role: 'USER',
    })));
    await setDoc(doc(db, 'configs/v1'), {
      stapel: Object.fromEntries(sorts.map((sort) => [sort, 15])),
    });
    await Promise.all(sorts.map((sort) => setDoc(doc(db, 'stocks', sort), {
      count: 0, lastEventId: 'bootstrap', updatedAt: Timestamp.now(),
    })));
    await setDoc(doc(db, 'system/stockControl'), { phase: 'ACTIVE' });
  });
});
afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    await new UphoffLocalDb(name).delete();
  }
});

function device(uid: 'a' | 'b') {
  const local = new UphoffLocalDb(`two-device-${uid}-${crypto.randomUUID()}`);
  dbNames.push(local.name);
  const firestore = env.authenticatedContext(uid).firestore() as unknown as Firestore;
  return { local, firestore, remote: new FirestoreRemoteEventStore(firestore) };
}

async function book(local: UphoffLocalDb, uid: 'a' | 'b', id: string, delta: number) {
  const event: StoredEvent = {
    id, geraetId: uid, sorte: 'typ-1', art: delta < 0 ? 'ABGANG' : 'ZUGANG',
    delta, buchungszeit: new Date().toISOString(), konfigVersion: 'v1',
    createdLocalAt: new Date().toISOString(), syncState: 'LOCAL_ONLY',
  };
  expect((await persistAndQueueEvent(local, event, Date.now())).status).toBe('QUEUED');
}

async function sync(client: ReturnType<typeof device>) {
  const now = new Date();
  return runFullSync(client.local, client.remote, now.getTime(), now.toISOString());
}

async function stock(client: ReturnType<typeof device>) {
  return (await loadProjection(client.local)).bestandJeSorte['typ-1'] ?? 0;
}

describe('real Firestore rules: repeated two-device exchange', () => {
  it('converges after five bookings A→B and five bookings B→A, including reopening a device', async () => {
    const a = device('a');
    const b = device('b');

    for (let round = 0; round < 5; round += 1) {
      await book(a.local, 'a', `a-in-${round}`, 15);
      expect((await sync(a)).push.confirmed).toBe(1);
      expect((await sync(b)).pull.added).toBe(1);
      expect(await stock(b)).toBe(15);

      await book(b.local, 'b', `b-out-${round}`, -15);
      expect((await sync(b)).push.confirmed).toBe(1);
      expect((await sync(a)).pull.added).toBe(1);
      expect(await stock(a)).toBe(0);
      expect(await stock(b)).toBe(0);
    }

    await a.local.close();
    const reopened = new UphoffLocalDb(a.local.name);
    await runFullSync(reopened, a.remote, Date.now(), new Date().toISOString());
    expect((await loadProjection(reopened)).bestandJeSorte['typ-1']).toBe(0);
    expect(await reopened.events.count()).toBe(10);
    expect((await getDoc(doc(a.firestore, 'stocks/typ-1'))).data()?.count).toBe(0);
    await reopened.close();
    await b.local.close();
  });

  it('converges after the reverse direction B→A then A→B, also with offline queued work', async () => {
    const a = device('a');
    const b = device('b');

    for (let round = 0; round < 4; round += 1) {
      await book(b.local, 'b', `b-in-${round}`, 15);
      await sync(b);
      await sync(a);
      expect(await stock(a)).toBe(15);

      // A queues the departure while offline. On reconnection the same
      // outbox event is pushed and then mirrored back to B exactly once.
      await book(a.local, 'a', `a-offline-out-${round}`, -15);
      expect(await a.local.outbox.count()).toBe(1);
      await sync(a);
      await sync(b);
      expect(await stock(a)).toBe(0);
      expect(await stock(b)).toBe(0);
      expect(await a.local.outbox.count()).toBe(0);
    }

    expect(await a.local.events.count()).toBe(8);
    expect(await b.local.events.count()).toBe(8);
    expect((await getDoc(doc(b.firestore, 'stocks/typ-1'))).data()?.count).toBe(0);
    await a.local.close();
    await b.local.close();
  });

  it('rejects the losing device when both try to take the last stack offline', async () => {
    const a = device('a');
    const b = device('b');
    await book(a.local, 'a', 'initial-stack', 15);
    await sync(a);
    await sync(b);

    await book(a.local, 'a', 'a-last', -15);
    await book(b.local, 'b', 'b-last', -15);
    const outcomes = await Promise.all([sync(a), sync(b)]);
    expect(outcomes.reduce((count, outcome) => count + outcome.push.confirmed, 0)).toBe(1);
    expect(outcomes.reduce((count, outcome) => count + outcome.push.rejected, 0)).toBe(1);

    await sync(a);
    await sync(b);
    expect(await stock(a)).toBe(0);
    expect(await stock(b)).toBe(0);
    expect(await a.local.outbox.count()).toBe(0);
    expect(await b.local.outbox.count()).toBe(0);
    expect((await getDoc(doc(a.firestore, 'stocks/typ-1'))).data()?.count).toBe(0);
    await a.local.close();
    await b.local.close();
  });
});
