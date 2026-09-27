import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import type { StoredEvent } from '../src/domain/types';
import { loadProjection, UphoffLocalDb } from '../src/persistence/localDb';
import { persistAndQueueEvent } from '../src/persistence/outbox';
import { FirestoreRemoteEventStore } from '../src/sync/firestoreRemoteStore';
import { runSyncPass } from '../src/sync/syncEngine';

// End-to-end regressions against the real rules: a booking that the server
// denies for a recoverable reason must arrive once the reason is gone.
let env: RulesTestEnvironment;
let dbCounter = 0;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'uphoff-paletten-test',
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await setDevice(true);
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'configs/v1'), {
      stapel: { 'typ-1': 15 },
    });
  });
});

function setDevice(enabled: boolean) {
  return env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'devices/phone-a'), {
      enabled,
      role: 'USER',
    });
  });
}

function booking(buchungszeit = new Date().toISOString()): StoredEvent {
  dbCounter += 1;
  return {
    id: `recovery-${dbCounter}`,
    geraetId: 'phone-a',
    sorte: 'typ-1',
    art: 'ZUGANG',
    delta: 15,
    buchungszeit,
    konfigVersion: 'v1',
    syncState: 'LOCAL_ONLY',
    createdLocalAt: buchungszeit,
  };
}

async function onServer(id: string): Promise<boolean> {
  let exists = false;
  await env.withSecurityRulesDisabled(async (context) => {
    exists = (await getDoc(doc(context.firestore(), 'events', id))).exists();
  });
  return exists;
}

function remote() {
  return new FirestoreRemoteEventStore(
    env.authenticatedContext('phone-a').firestore() as unknown as Firestore,
  );
}

describe('release integration: recoverable server denials', () => {
  it('keeps a booking through a temporary device lock and uploads it after re-enable', async () => {
    const local = new UphoffLocalDb(`recovery-lock-${dbCounter}`);
    const event = booking();
    await persistAndQueueEvent(local, event, Date.now());

    await setDevice(false);
    const denied = await runSyncPass(local, remote(), Date.now());
    expect(denied).toMatchObject({ rejected: 0, permissionDenied: 1 });
    expect((await loadProjection(local)).bestandJeSorte['typ-1']).toBe(15);

    await setDevice(true);
    const recovered = await runSyncPass(local, remote(), Date.now() + 120_000);
    expect(recovered.confirmed).toBe(1);
    expect(await onServer(event.id)).toBe(true);
    await local.close();
  });

  it('uploads a booking from a device whose clock runs minutes ahead', async () => {
    const local = new UphoffLocalDb(`recovery-clock-${dbCounter}`);
    const event = booking(new Date(Date.now() + 6 * 60_000).toISOString());
    await persistAndQueueEvent(local, event, Date.now());

    const result = await runSyncPass(local, remote(), Date.now());
    expect(result.confirmed).toBe(1);
    expect(await onServer(event.id)).toBe(true);
    await local.close();
  });
});
