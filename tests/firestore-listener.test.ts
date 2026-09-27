import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import type { PalletEvent } from '../src/domain/types';
import { FirestoreRemoteEventStore } from '../src/sync/firestoreRemoteStore';

const listener = vi.hoisted(() => ({
  next: null as null | ((snapshot: unknown) => void),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    collection: () => ({}),
    documentId: () => ({}),
    orderBy: () => ({}),
    query: () => ({}),
    onSnapshot: (
      _source: unknown,
      _options: unknown,
      next: (snapshot: unknown) => void,
    ) => {
      listener.next = next;
      return () => {};
    },
  };
});

describe('Firestore realtime listener', () => {
  it('ignores a pending local timestamp and accepts its server confirmation', () => {
    const received: PalletEvent[] = [];
    const errors: unknown[] = [];
    const remote = new FirestoreRemoteEventStore(
      {} as ConstructorParameters<typeof FirestoreRemoteEventStore>[0],
    );
    remote.subscribeEvents(
      (event) => { received.push(event); },
      (error) => { errors.push(error); },
    );

    const fields = {
      id: 'event-1',
      geraetId: 'phone-a',
      sorte: 'typ-1',
      art: 'ZUGANG',
      delta: 1,
      buchungszeit: Timestamp.fromDate(new Date('2026-09-27T10:00:00Z')),
      konfigVersion: 'v1',
    };
    const changed = (
      type: 'added' | 'modified',
      hasPendingWrites: boolean,
      serverzeit: Timestamp | null,
    ) => ({
      type,
      doc: {
        id: 'event-1',
        metadata: { hasPendingWrites },
        data: () => ({ ...fields, serverzeit }),
      },
    });

    listener.next?.({
      docChanges: () => [changed('added', true, null)],
    });
    expect(errors).toEqual([]);
    expect(received).toEqual([]);

    listener.next?.({
      docChanges: () => [changed(
        'modified',
        false,
        Timestamp.fromDate(new Date('2026-09-27T10:00:01Z')),
      )],
    });
    expect(errors).toEqual([]);
    expect(received).toHaveLength(1);
    expect(received[0]?.serverzeit).toBe('2026-09-27T10:00:01.000Z');
  });
});

