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


  it('allows exactly one deterministic positive initial-stock event per sort', async () => {
    const adminDb = env.authenticatedContext('ipad-admin').firestore();

    await assertSucceeds(
      setDoc(
        doc(adminDb, 'events/anfang_EURO'),
        eventData('ipad-admin', {
          id: 'anfang_EURO',
          art: 'ANFANGSBESTAND',
          delta: 100,
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(adminDb, 'events/wrong-initial-id'),
        eventData('ipad-admin', {
          id: 'wrong-initial-id',
          art: 'ANFANGSBESTAND',
          delta: 100,
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(adminDb, 'events/anfang_EINWEG'),
        eventData('ipad-admin', {
          id: 'anfang_EINWEG',
          sorte: 'EINWEG',
          art: 'ANFANGSBESTAND',
          delta: 0,
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(adminDb, 'events/anfang_EURO'),
        eventData('ipad-admin', {
          id: 'anfang_EURO',
          art: 'ANFANGSBESTAND',
          delta: 120,
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

  it('prevents a normal device from correcting another device or admin-only adjustments', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'events/foreign-normal'), {
        ...eventData('ipad-admin', {
          id: 'foreign-normal',
          geraetId: 'ipad-admin',
          art: 'ZUGANG',
          delta: 15,
        }),
        serverzeit: Timestamp.now(),
      });
      await setDoc(doc(db, 'events/admin-inventory'), {
        ...eventData('ipad-admin', {
          id: 'admin-inventory',
          geraetId: 'ipad-admin',
          art: 'INVENTUR',
          delta: -3,
        }),
        serverzeit: Timestamp.now(),
      });
      await setDoc(doc(db, 'events/admin-transfer'), {
        ...eventData('ipad-admin', {
          id: 'admin-transfer',
          geraetId: 'ipad-admin',
          art: 'UMBUCHUNG',
          delta: -10,
          umbuchungId: 'seed-transfer',
          umbuchungPartnerId: 'seed-transfer-partner',
        }),
        serverzeit: Timestamp.now(),
      });
    });

    const userDb = env.authenticatedContext('iphone-user').firestore();

    await assertFails(
      setDoc(
        doc(userDb, 'events/korr_foreign-normal'),
        eventData('iphone-user', {
          id: 'korr_foreign-normal',
          art: 'KORREKTUR',
          delta: -15,
          korrigiertId: 'foreign-normal',
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(userDb, 'events/korr_admin-inventory'),
        eventData('iphone-user', {
          id: 'korr_admin-inventory',
          art: 'KORREKTUR',
          delta: 3,
          korrigiertId: 'admin-inventory',
        }),
      ),
    );

    const adminDb = env.authenticatedContext('ipad-admin').firestore();

    await assertSucceeds(
      setDoc(
        doc(adminDb, 'events/korr_foreign-normal'),
        eventData('ipad-admin', {
          id: 'korr_foreign-normal',
          art: 'KORREKTUR',
          delta: -15,
          korrigiertId: 'foreign-normal',
        }),
      ),
    );

    await assertSucceeds(
      setDoc(
        doc(adminDb, 'events/korr_admin-inventory'),
        eventData('ipad-admin', {
          id: 'korr_admin-inventory',
          art: 'KORREKTUR',
          delta: 3,
          korrigiertId: 'admin-inventory',
        }),
      ),
    );

    await assertFails(
      setDoc(
        doc(adminDb, 'events/korr_admin-transfer'),
        eventData('ipad-admin', {
          id: 'korr_admin-transfer',
          art: 'KORREKTUR',
          delta: 10,
          korrigiertId: 'admin-transfer',
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

  it('allows only immutable, complete seven-sort config versions', async () => {
    const adminDb = env.authenticatedContext('ipad-admin').firestore();

    const validConfig = {
      stapel: {
        'typ-1': 15,
        'typ-2': 15,
        'typ-3': 15,
        'typ-4': 18,
        'typ-5': 25,
        'typ-6': 17,
        'typ-7': 17,
      },
    };

    await assertSucceeds(
      setDoc(doc(adminDb, 'configs/v3'), validConfig),
    );

    await assertFails(
      updateDoc(doc(adminDb, 'configs/v3'), {
        'stapel.typ-1': 17,
      }),
    );

    await assertFails(deleteDoc(doc(adminDb, 'configs/v3')));

    await assertFails(
      setDoc(doc(adminDb, 'configs/incomplete'), {
        stapel: {
          'typ-1': 15,
        },
      }),
    );

    await assertFails(
      setDoc(doc(adminDb, 'configs/invalid-stack'), {
        stapel: {
          ...validConfig.stapel,
          'typ-7': 99,
        },
      }),
    );

    const userDb = env.authenticatedContext('iphone-user').firestore();
    await assertFails(
      setDoc(doc(userDb, 'configs/user-created'), validConfig),
    );
  });



  it('rejects zero or mismatched transfer pairs', async () => {
    const db = env.authenticatedContext('ipad-admin').firestore();

    const zero = writeBatch(db);
    zero.set(
      doc(db, 'events/transfer-zero-a'),
      eventData('ipad-admin', {
        id: 'transfer-zero-a',
        art: 'UMBUCHUNG',
        sorte: 'EURO',
        delta: 0,
        umbuchungId: 'u-zero',
        umbuchungPartnerId: 'transfer-zero-b',
      }),
    );
    zero.set(
      doc(db, 'events/transfer-zero-b'),
      eventData('ipad-admin', {
        id: 'transfer-zero-b',
        art: 'UMBUCHUNG',
        sorte: 'EINWEG',
        delta: 0,
        umbuchungId: 'u-zero',
        umbuchungPartnerId: 'transfer-zero-a',
      }),
    );
    await assertFails(zero.commit());

    const versionMismatch = writeBatch(db);
    versionMismatch.set(
      doc(db, 'events/transfer-version-a'),
      eventData('ipad-admin', {
        id: 'transfer-version-a',
        art: 'UMBUCHUNG',
        sorte: 'EURO',
        delta: -10,
        konfigVersion: 'v1',
        umbuchungId: 'u-version',
        umbuchungPartnerId: 'transfer-version-b',
      }),
    );
    versionMismatch.set(
      doc(db, 'events/transfer-version-b'),
      eventData('ipad-admin', {
        id: 'transfer-version-b',
        art: 'UMBUCHUNG',
        sorte: 'EINWEG',
        delta: 10,
        konfigVersion: 'v2',
        umbuchungId: 'u-version',
        umbuchungPartnerId: 'transfer-version-a',
      }),
    );
    await assertFails(versionMismatch.commit());

    const timeMismatch = writeBatch(db);
    timeMismatch.set(
      doc(db, 'events/transfer-time-a'),
      eventData('ipad-admin', {
        id: 'transfer-time-a',
        art: 'UMBUCHUNG',
        sorte: 'EURO',
        delta: -10,
        umbuchungId: 'u-time',
        umbuchungPartnerId: 'transfer-time-b',
        buchungszeit: Timestamp.fromDate(
          new Date('2026-09-23T10:00:00Z'),
        ),
      }),
    );
    timeMismatch.set(
      doc(db, 'events/transfer-time-b'),
      eventData('ipad-admin', {
        id: 'transfer-time-b',
        art: 'UMBUCHUNG',
        sorte: 'EINWEG',
        delta: 10,
        umbuchungId: 'u-time',
        umbuchungPartnerId: 'transfer-time-a',
        buchungszeit: Timestamp.fromDate(
          new Date('2026-09-23T10:00:01Z'),
        ),
      }),
    );
    await assertFails(timeMismatch.commit());
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

  it('lets an authenticated device read only its own enrollment record even when disabled', async () => {
    const blocked = env.authenticatedContext('blocked-user').firestore();

    await assertSucceeds(
      getDoc(doc(blocked, 'devices/blocked-user')),
    );

    await assertFails(
      getDoc(doc(blocked, 'devices/iphone-user')),
    );

    await assertFails(
      getDoc(doc(blocked, 'events/readable')),
    );
  });



  it('allows only active devices to publish their own validated heartbeat', async () => {
    const userDb = env.authenticatedContext('iphone-user').firestore();
    const heartbeat = {
      uid: 'iphone-user',
      lastSeen: serverTimestamp(),
      pendingCount: 0,
      rejectedCount: 0,
      eventCount: 5,
      appVersion: '0.1.0',
      syncState: 'SYNCHRON',
      checkCodeJson: '{"EURO":{"count":5,"sum":45}}',
    };

    await assertSucceeds(
      setDoc(doc(userDb, 'heartbeats/iphone-user'), heartbeat),
    );

    await assertFails(
      setDoc(doc(userDb, 'heartbeats/ipad-admin'), {
        ...heartbeat,
        uid: 'ipad-admin',
      }),
    );

    await assertFails(
      setDoc(doc(userDb, 'heartbeats/iphone-user-invalid'), {
        ...heartbeat,
        uid: 'iphone-user-invalid',
        pendingCount: -1,
      }),
    );

    const blockedDb = env.authenticatedContext('blocked-user').firestore();
    await assertFails(
      setDoc(doc(blockedDb, 'heartbeats/blocked-user'), {
        ...heartbeat,
        uid: 'blocked-user',
      }),
    );
  });

  it('keeps device heartbeat visibility private except for admins', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'heartbeats/iphone-user'), {
        uid: 'iphone-user',
        lastSeen: Timestamp.now(),
        pendingCount: 0,
        rejectedCount: 0,
        eventCount: 2,
        appVersion: '0.1.0',
        syncState: 'SYNCHRON',
        checkCodeJson: '{}',
      });
    });

    const own = env.authenticatedContext('iphone-user').firestore();
    await assertSucceeds(
      getDoc(doc(own, 'heartbeats/iphone-user')),
    );

    const other = env.authenticatedContext('blocked-user').firestore();
    await assertFails(
      getDoc(doc(other, 'heartbeats/iphone-user')),
    );

    const admin = env.authenticatedContext('ipad-admin').firestore();
    await assertSucceeds(
      getDoc(doc(admin, 'heartbeats/iphone-user')),
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
