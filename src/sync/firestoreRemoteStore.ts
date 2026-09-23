import { FirebaseError } from 'firebase/app';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';
import type { PalletEvent } from '../domain/types';
import {
  RemoteCreateError,
  type RemoteCreateResult,
  type RemoteRealtimeEventStore,
  type RemoteUnsubscribe,
} from './types';

function toFirestoreEvent(event: PalletEvent): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: event.id,
    geraetId: event.geraetId,
    sorte: event.sorte,
    art: event.art,
    delta: event.delta,
    buchungszeit: Timestamp.fromDate(new Date(event.buchungszeit)),
    serverzeit: serverTimestamp(),
    konfigVersion: event.konfigVersion,
  };

  if (event.person !== undefined) data.person = event.person;
  if (event.vorgangId !== undefined) data.vorgangId = event.vorgangId;
  if (event.korrigiertId !== undefined) data.korrigiertId = event.korrigiertId;
  if (event.umbuchungId !== undefined) data.umbuchungId = event.umbuchungId;
  if (event.umbuchungPartnerId !== undefined) {
    data.umbuchungPartnerId = event.umbuchungPartnerId;
  }

  return data;
}

function timestampToIso(value: unknown): string | undefined {
  return value instanceof Timestamp ? value.toDate().toISOString() : undefined;
}

function fromFirestoreEvent(data: Record<string, unknown>): PalletEvent {
  const buchungszeit = timestampToIso(data.buchungszeit);
  if (!buchungszeit) throw new Error('invalid-remote-buchungszeit');

  const event: PalletEvent = {
    id: String(data.id),
    geraetId: String(data.geraetId),
    sorte: String(data.sorte),
    art: data.art as PalletEvent['art'],
    delta: Number(data.delta),
    buchungszeit,
    konfigVersion: String(data.konfigVersion),
  };

  const serverzeit = timestampToIso(data.serverzeit);
  if (serverzeit !== undefined) event.serverzeit = serverzeit;
  if (typeof data.person === 'string') event.person = data.person;
  if (typeof data.vorgangId === 'string') event.vorgangId = data.vorgangId;
  if (typeof data.korrigiertId === 'string') event.korrigiertId = data.korrigiertId;
  if (typeof data.umbuchungId === 'string') event.umbuchungId = data.umbuchungId;
  if (typeof data.umbuchungPartnerId === 'string') {
    event.umbuchungPartnerId = data.umbuchungPartnerId;
  }

  return event;
}

function mapFirebaseError(error: unknown): RemoteCreateError {
  if (!(error instanceof FirebaseError)) {
    return new RemoteCreateError('TRANSIENT', 'unknown-remote-error');
  }

  if (error.code === 'resource-exhausted') {
    return new RemoteCreateError('QUOTA_EXHAUSTED', error.message);
  }
  if (error.code === 'unauthenticated') {
    return new RemoteCreateError('UNAUTHENTICATED', error.message);
  }
  if (error.code === 'invalid-argument') {
    return new RemoteCreateError('INVALID_ARGUMENT', error.message);
  }
  if (
    error.code === 'unavailable'
    || error.code === 'deadline-exceeded'
    || error.code === 'aborted'
  ) {
    return new RemoteCreateError('TRANSIENT', error.message);
  }

  return new RemoteCreateError('PERMISSION_DENIED', error.message);
}

export class FirestoreRemoteEventStore implements RemoteRealtimeEventStore {
  constructor(private readonly db: Firestore) {}

  async createEvent(event: PalletEvent): Promise<RemoteCreateResult> {
    const ref = doc(this.db, 'events', event.id);

    try {
      await setDoc(ref, toFirestoreEvent(event));
      return { status: 'CREATED' };
    } catch (error) {
      if (error instanceof FirebaseError && error.code === 'permission-denied') {
        try {
          const existing = await getDoc(ref);
          if (existing.exists()) {
            throw new RemoteCreateError('ALREADY_EXISTS', 'event-already-exists');
          }
        } catch (readError) {
          if (readError instanceof RemoteCreateError) throw readError;
          throw mapFirebaseError(readError);
        }
      }

      throw mapFirebaseError(error);
    }
  }

  async getEvent(id: string): Promise<PalletEvent | undefined> {
    const snapshot = await getDoc(doc(this.db, 'events', id));
    if (!snapshot.exists()) return undefined;
    return fromFirestoreEvent(snapshot.data());
  }

  async listEvents(): Promise<PalletEvent[]> {
    const snapshot = await getDocs(collection(this.db, 'events'));
    return snapshot.docs.map((item) => fromFirestoreEvent(item.data()));
  }

  subscribeEvents(
    onEvent: (event: PalletEvent) => void | Promise<void>,
    onError: (error: unknown) => void,
  ): RemoteUnsubscribe {
    return onSnapshot(
      collection(this.db, 'events'),
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;
          const event = fromFirestoreEvent(change.doc.data());
          void Promise.resolve(onEvent(event)).catch(onError);
        }
      },
      onError,
    );
  }
}
