import { describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';

let nextCode = 'internal';

vi.mock('firebase/firestore', async (original) => {
  const actual = await original<typeof import('firebase/firestore')>();
  const fail = async () => {
    throw new FirebaseError(nextCode as never, 'simulated');
  };
  return { ...actual, doc: () => ({}), setDoc: fail, getDoc: fail };
});

const { FirestoreRemoteEventStore } = await import('../src/sync/firestoreRemoteStore');
const { REMOTE_ERROR_POLICY } = await import('../src/sync/types');

const event = {
  id: 'policy-1',
  geraetId: 'a',
  sorte: 'typ-1',
  art: 'ZUGANG' as const,
  delta: 1,
  buchungszeit: '2026-09-27T10:00:00.000Z',
  konfigVersion: 'v1',
};

// Every gRPC status the Firebase SDK can surface. Only content errors may end
// in REJECT; everything else must stay in the outbox (see REMOTE_ERROR_POLICY).
const ALL_FIREBASE_CODES = [
  'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found',
  'already-exists', 'permission-denied', 'resource-exhausted',
  'failed-precondition', 'aborted', 'out-of-range', 'unimplemented',
  'internal', 'unavailable', 'data-loss', 'unauthenticated',
] as const;

describe('remote error policy', () => {
  it.each(ALL_FIREBASE_CODES)('never discards a booking on ambiguous code %s', async (code) => {
    nextCode = code;
    const remote = new FirestoreRemoteEventStore({} as never);

    const caught = await remote.createEvent(event).catch((error: unknown) => error);
    const mapped = (caught as { code: keyof typeof REMOTE_ERROR_POLICY }).code;
    const policy = REMOTE_ERROR_POLICY[mapped];

    expect(policy).toBe(code === 'invalid-argument' ? 'REJECT' : 'RETRY');
  });
});
