import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';

let env: RulesTestEnvironment;

const projectId = 'uphoff-paletten-test';

async function seedBase() {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'devices/ipad-admin'), {
      enabled: true,
      role: 'ADMIN',
      name: 'iPad',
    });
    await setDoc(doc(db, 'devices/iphone-user'), {
      enabled: true,
      role: 'USER',
      name: 'iPhone',
    });
    await setDoc(doc(db, 'devices/blocked-user'), {
      enabled: false,
      role: 'USER',
      name: 'Blocked',
    });

    await setDoc(doc(db, 'configs/v1'), {
      stapel: {
        EURO: 15,
        EINWEG: 17,
      },
    });
    await setDoc(doc(db, 'configs/v2'), {
      stapel: {
        EURO: 17,
        EINWEG: 17,
      },
    });
  });
}

function eventData(
  uid: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'evt-1',
    geraetId: uid,
    sorte: 'EURO',
    art: 'ZUGANG',
    delta: 15,
    buchungszeit: Timestamp.fromDate(new Date('2026-09-23T10:00:00Z')),
    serverzeit: serverTimestamp(),
    konfigVersion: 'v1',
    ...overrides,
  };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId,
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
  await seedBase();
});

describe('E2.3 Firestore security rules', () => {
  it('accepts valid ZUGANG deltas for the configured stack version', async () => {
    const db = env.authenticatedContext('iphone-user').firestore();

    await assertSucceeds(
      setDoc(doc(db, 'events/evt-1'), eventData('iphone-user')),
    );
    await assertSucceeds(
      setDoc(
        doc(db, 'events/evt-2'),
        eventData('iphone-user', { id: 'evt-2', delta: 1 }),
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(db, 'events/evt-3'),
        eventData('iphone-user', { id: 'evt-3', delta: -1 }),
      ),
    );
  });

  it('rejects unknown pallet sorts even for +/-1 adjustments', async () => {
    const db = env.authenticatedContext('iphone-user').firestore();

    await assertFails(
      setDoc(
        doc(db, 'events/unknown-sort'),
        eventData('iphone-user', {
          id: 'unknown-sort',
          sorte: 'NOT_CONFIGURED',
          delta: 1,
        }),
      ),
    );
  });

  it('rejects empty or oversized process identifiers', async () => {
    const db = env.authenticatedContext('iphone-user').firestore();

    await assertFails(
      setDoc(
        doc(db, 'events/empty-process'),
        eventData('iphone-user', {
          id: 'empty-process',
          vorgangId: '',
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(db, 'events/oversized-process'),
        eventData('iphone-user', {
          id: 'oversized-process',
          vorgangId: 'x'.repeat(129),
        }),
      ),
    );
  });

  it('accepts valid ABGANG deltas and rejects invalid signs/deltas', async () => {
    const db = env.authenticatedContext('iphone-user').firestore();

    await assertSucceeds(
      setDoc(
        doc(db, 'events/out-1'),
        eventData('iphone-user', {
          id: 'out-1',
          art: 'ABGANG',
          delta: -15,
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(db, 'events/bad-1'),
        eventData('iphone-user', { id: 'bad-1', delta: 3 }),
      ),
    );

    await assertFails(
      setDoc(
        doc(db, 'events/bad-2'),
        eventData('iphone-user', { id: 'bad-2', delta: -15 }),
      ),
    );
  });

  it('rejects update and delete even for an admin', async () => {
    const db = env.authenticatedContext('ipad-admin').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'events/evt-1'), eventData('ipad-admin')),
    );

    await assertFails(updateDoc(doc(db, 'events/evt-1'), { delta: 17 }));
    await assertFails(deleteDoc(doc(db, 'events/evt-1')));
  });

  it('rejects writes from blocked or mismatched device identities', async () => {
    const blocked = env.authenticatedContext('blocked-user').firestore();
    await assertFails(
      setDoc(doc(blocked, 'events/blocked'), eventData('blocked-user', { id: 'blocked' })),
    );

    const user = env.authenticatedContext('iphone-user').firestore();
    await assertFails(
      setDoc(
        doc(user, 'events/mismatch'),
        eventData('ipad-admin', { id: 'mismatch' }),
      ),
    );
  });

  it('rejects INVENTUR for non-admin and accepts it for admin', async () => {
    const userDb = env.authenticatedContext('iphone-user').firestore();
    await assertFails(
      setDoc(
        doc(userDb, 'events/inv-user'),
        eventData('iphone-user', {
          id: 'inv-user',
          art: 'INVENTUR',
          delta: -3,
        }),
      ),
    );

    const adminDb = env.authenticatedContext('ipad-admin').firestore();
    await assertSucceeds(
      setDoc(
        doc(adminDb, 'events/inv-admin'),
        eventData('ipad-admin', {
          id: 'inv-admin',
          art: 'INVENTUR',
          delta: -3,
        }),
      ),
    );
  });

  it('accepts an old valid configVersion after a newer version exists', async () => {
    const db = env.authenticatedContext('iphone-user').firestore();

    await assertSucceeds(
      setDoc(
        doc(db, 'events/old-config'),
        eventData('iphone-user', {
          id: 'old-config',
          konfigVersion: 'v1',
          delta: 15,
        }),
      ),
    );

    await assertSucceeds(
      setDoc(
        doc(db, 'events/new-config'),
        eventData('iphone-user', {
          id: 'new-config',
          konfigVersion: 'v2',
          delta: 17,
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(db, 'events/unknown-config'),
        eventData('iphone-user', {
          id: 'unknown-config',
          konfigVersion: 'v3',
          delta: 15,
        }),
      ),
    );
  });

  it('accepts exactly one deterministic correction and rejects wrong/double corrections', async () => {
    const db = env.authenticatedContext('iphone-user').firestore();

    await assertSucceeds(
      setDoc(
        doc(db, 'events/original-1'),
        eventData('iphone-user', { id: 'original-1', delta: 15 }),
      ),
    );

    await assertFails(
      setDoc(
        doc(db, 'events/korr_wrong'),
        eventData('iphone-user', {
          id: 'korr_wrong',
          art: 'KORREKTUR',
          delta: -14,
          korrigiertId: 'original-1',
        }),
      ),
    );

    await assertSucceeds(
      setDoc(
        doc(db, 'events/korr_original-1'),
        eventData('iphone-user', {
          id: 'korr_original-1',
          art: 'KORREKTUR',
          delta: -15,
          korrigiertId: 'original-1',
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(db, 'events/korr_original-1'),
        eventData('iphone-user', {
          id: 'korr_original-1',
          art: 'KORREKTUR',
          delta: -15,
          korrigiertId: 'original-1',
        }),
      ),
    );
  });

  it('requires UMBUCHUNG to be an admin atomic pair with sum zero', async () => {
    const db = env.authenticatedContext('ipad-admin').firestore();

    const batch = writeBatch(db);
    batch.set(
      doc(db, 'events/transfer-a'),
      eventData('ipad-admin', {
        id: 'transfer-a',
        art: 'UMBUCHUNG',
        sorte: 'EURO',
        delta: -10,
        umbuchungId: 'u-1',
        umbuchungPartnerId: 'transfer-b',
      }),
    );
    batch.set(
      doc(db, 'events/transfer-b'),
      eventData('ipad-admin', {
        id: 'transfer-b',
        art: 'UMBUCHUNG',
        sorte: 'EINWEG',
        delta: 10,
        umbuchungId: 'u-1',
        umbuchungPartnerId: 'transfer-a',
      }),
    );

    await assertSucceeds(batch.commit());

    await assertFails(
      setDoc(
        doc(db, 'events/lonely-transfer'),
        eventData('ipad-admin', {
          id: 'lonely-transfer',
          art: 'UMBUCHUNG',
          sorte: 'EURO',
          delta: -10,
          umbuchungId: 'u-2',
          umbuchungPartnerId: 'missing-partner',
        }),
      ),
    );
  });

  it('rejects future device time beyond the allowed tolerance but permits old offline booking time', async () => {
    const db = env.authenticatedContext('iphone-user').firestore();

    await assertFails(
      setDoc(
        doc(db, 'events/future'),
        eventData('iphone-user', {
          id: 'future',
          buchungszeit: Timestamp.fromDate(new Date('2099-01-01T00:00:00Z')),
        }),
      ),
    );

    await assertSucceeds(
      setDoc(
        doc(db, 'events/old-offline'),
        eventData('iphone-user', {
          id: 'old-offline',
          buchungszeit: Timestamp.fromDate(new Date('2025-01-01T00:00:00Z')),
        }),
      ),
    );
  });

  it('allows active devices to read events but not blocked devices', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'events/readable'), {
        ...eventData('iphone-user', { id: 'readable' }),
        serverzeit: Timestamp.now(),
      });
    });

    const active = env.authenticatedContext('iphone-user').firestore();
    await assertSucceeds(getDoc(doc(active, 'events/readable')));

    const blocked = env.authenticatedContext('blocked-user').firestore();
    await assertFails(getDoc(doc(blocked, 'events/readable')));
  });
});
