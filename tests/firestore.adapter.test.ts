import { readFile } from 'node:fs/promises';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp, type Firestore } from 'firebase/firestore';
import type { PalletEvent } from '../src/domain/types';
import { FirestoreRemoteEventStore } from '../src/sync/firestoreRemoteStore';
import { RemoteCreateError } from '../src/sync/types';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'uphoff-paletten-test',
    firestore: {
      rules: await readFile('firestore.rules', 'utf8'),
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'devices/phone-a'), {
      enabled: true,
      role: 'USER',
      name: 'Phone A',
    });
    await setDoc(doc(db, 'configs/v1'), {
      stapel: {
        'typ-1': 15,
        'typ-2': 15,
        'typ-3': 15,
        'typ-4': 15,
        'typ-5': 17,
        'typ-6': 17,
        'typ-7': 17,
      },
    });
  });
});

function event(overrides: Partial<PalletEvent> = {}): PalletEvent {
  return {
    id: 'adapter-1',
    geraetId: 'phone-a',
    sorte: 'typ-1',
    art: 'ZUGANG',
    delta: 15,
    buchungszeit: '2026-09-23T10:00:00.000Z',
    konfigVersion: 'v1',
    ...overrides,
  };
}

describe('release integration: Firestore adapter + real rules', () => {
  it('creates, reads and lists a valid event through the production adapter', async () => {
    const db = env.authenticatedContext('phone-a').firestore();
    const remote = new FirestoreRemoteEventStore(db as unknown as Firestore);

    await expect(remote.createEvent(event())).resolves.toEqual({
      status: 'CREATED',
    });

    const restored = await remote.getEvent('adapter-1');
    expect(restored?.id).toBe('adapter-1');
    expect(restored?.geraetId).toBe('phone-a');
    expect(restored?.delta).toBe(15);
    expect(restored?.serverzeit).toBeTruthy();

    const all = await remote.listEvents();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('adapter-1');
  });

  it('maps an idempotent second create to ALREADY_EXISTS instead of overwriting', async () => {
    const db = env.authenticatedContext('phone-a').firestore();
    const remote = new FirestoreRemoteEventStore(db as unknown as Firestore);

    await remote.createEvent(event());

    try {
      await remote.createEvent(event());
      throw new Error('expected-second-create-to-fail');
    } catch (caught) {
      expect(caught).toBeInstanceOf(RemoteCreateError);
      expect((caught as RemoteCreateError).code).toBe('ALREADY_EXISTS');
    }

    const all = await remote.listEvents();
    expect(all).toHaveLength(1);
  });


  it('refuses malformed remote documents instead of projecting corrupt data', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'events/malformed'), {
        id: 'malformed',
        geraetId: 'phone-a',
        sorte: 'typ-1',
        art: 'ZUGANG',
        delta: '15',
        buchungszeit: Timestamp.fromDate(
          new Date('2026-09-23T10:00:00Z'),
        ),
        serverzeit: Timestamp.fromDate(
          new Date('2026-09-23T10:00:01Z'),
        ),
        konfigVersion: 'v1',
      });
    });

    const db = env.authenticatedContext('phone-a').firestore();
    const remote = new FirestoreRemoteEventStore(
      db as unknown as Firestore,
    );

    await expect(remote.listEvents()).rejects.toThrow(
      'invalid-remote-delta',
    );
  });

  it('refuses a remote document whose payload id differs from its document id', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'events/path-id'), {
        id: 'payload-id',
        geraetId: 'phone-a',
        sorte: 'typ-1',
        art: 'ZUGANG',
        delta: 15,
        buchungszeit: Timestamp.fromDate(
          new Date('2026-09-23T10:00:00Z'),
        ),
        serverzeit: Timestamp.fromDate(
          new Date('2026-09-23T10:00:01Z'),
        ),
        konfigVersion: 'v1',
      });
    });

    const db = env.authenticatedContext('phone-a').firestore();
    const remote = new FirestoreRemoteEventStore(
      db as unknown as Firestore,
    );

    await expect(remote.listEvents()).rejects.toThrow(
      'remote-id-document-mismatch',
    );
  });

  it('maps a mismatched device identity to a permanent permission error', async () => {
    const db = env.authenticatedContext('phone-a').firestore();
    const remote = new FirestoreRemoteEventStore(db as unknown as Firestore);

    try {
      await remote.createEvent(
        event({
          id: 'wrong-device',
          geraetId: 'someone-else',
        }),
      );
      throw new Error('expected-device-mismatch-to-fail');
    } catch (caught) {
      expect(caught).toBeInstanceOf(RemoteCreateError);
      expect((caught as RemoteCreateError).code).toBe('PERMISSION_DENIED');
    }
  });
});
