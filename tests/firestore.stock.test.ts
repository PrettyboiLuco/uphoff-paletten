import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, Timestamp, type Firestore } from 'firebase/firestore';
import { FirestoreRemoteEventStore } from '../src/sync/firestoreRemoteStore';
import { RemoteCreateError } from '../src/sync/types';

let env: RulesTestEnvironment;
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
      enabled: true,
      role: 'USER',
    })));
    await setDoc(doc(db, 'configs/v1'), {
      stapel: Object.fromEntries(sorts.map((sort) => [sort, 15])),
    });
    await Promise.all(sorts.map((sort) => setDoc(doc(db, 'stocks', sort), {
      count: sort === 'typ-1' ? 1 : 0,
      lastEventId: 'bootstrap',
      updatedAt: Timestamp.now(),
    })));
    await setDoc(doc(db, 'system/stockControl'), { phase: 'ACTIVE' });
  });
});

function event(uid: string, id: string, delta: number) {
  return {
    id,
    geraetId: uid,
    sorte: 'typ-1',
    art: delta < 0 ? 'ABGANG' : 'ZUGANG',
    delta,
    buchungszeit: new Date().toISOString(),
    konfigVersion: 'v1',
  } as const;
}

describe('server-side stock floor', () => {
  it('rejects events without their atomic stock update', async () => {
    const db = env.authenticatedContext('a').firestore();
    await assertFails(setDoc(doc(db, 'events/alone'), {
      ...event('a', 'alone', -1),
      buchungszeit: Timestamp.now(),
      serverzeit: serverTimestamp(),
    }));
    expect((await getDoc(doc(db, 'stocks/typ-1'))).data()?.count).toBe(1);
  });

  it('allows one removal to zero and rejects the next one', async () => {
    const db = env.authenticatedContext('a').firestore() as unknown as Firestore;
    const remote = new FirestoreRemoteEventStore(db);
    await expect(remote.createEvent(event('a', 'first', -1))).resolves.toEqual({ status: 'CREATED' });
    await expect(remote.createEvent(event('a', 'second', -1))).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
    expect((await getDoc(doc(db, 'stocks/typ-1'))).data()?.count).toBe(0);
    expect((await getDoc(doc(db, 'events/second'))).exists()).toBe(false);
  });

  it('serializes simultaneous last-pallet removals from two devices', async () => {
    const a = new FirestoreRemoteEventStore(env.authenticatedContext('a').firestore() as unknown as Firestore);
    const b = new FirestoreRemoteEventStore(env.authenticatedContext('b').firestore() as unknown as Firestore);
    const outcomes = await Promise.allSettled([
      a.createEvent(event('a', 'a-removes', -1)),
      b.createEvent(event('b', 'b-removes', -1)),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find((result) => result.status === 'rejected');
    expect(rejection?.reason).toBeInstanceOf(RemoteCreateError);
    expect(rejection?.reason.code).toBe('INSUFFICIENT_STOCK');
    const db = env.authenticatedContext('a').firestore();
    expect((await getDoc(doc(db, 'stocks/typ-1'))).data()?.count).toBe(0);
  });

  it('does not allow a device to forge the counter or switch on stock control', async () => {
    const db = env.authenticatedContext('a').firestore();
    await assertFails(setDoc(doc(db, 'stocks/typ-1'), {
      count: 1000,
      lastEventId: 'forged',
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(db, 'system/stockControl'), { phase: 'ACTIVE' }));
  });
});
