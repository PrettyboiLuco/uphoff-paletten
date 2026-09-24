import { FirebaseError } from 'firebase/app';
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAt,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';
import type { PalletEvent } from '../domain/types';
import {
  RemoteCreateError,
  type RemoteCreateResult,
  type RemoteCursor,
  type RemoteRealtimeEventStore,
  type RemoteUnsubscribe,
} from './types';
const REMOTE_TIMEOUT_MS = 12_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = REMOTE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = globalThis.setTimeout(() => {
          reject(new RemoteCreateError('TRANSIENT', 'remote-timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}


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

function timestampFromExactIso(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

const REMOTE_EVENT_ARTS = new Set<PalletEvent['art']>([
  'ZUGANG',
  'ABGANG',
  'KORREKTUR',
  'ANFANGSBESTAND',
  'INVENTUR',
  'UMBUCHUNG',
]);

function optionalRemoteString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid-remote-${key}`);
  }
  return value;
}

function fromFirestoreEvent(
  data: Record<string, unknown>,
  documentIdValue?: string,
): PalletEvent {
  if (typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error('invalid-remote-id');
  }
  if (documentIdValue !== undefined && data.id !== documentIdValue) {
    throw new Error('remote-id-document-mismatch');
  }
  if (typeof data.geraetId !== 'string' || data.geraetId.length === 0) {
    throw new Error('invalid-remote-geraetId');
  }
  if (typeof data.sorte !== 'string' || data.sorte.length === 0) {
    throw new Error('invalid-remote-sorte');
  }
  if (
    typeof data.art !== 'string'
    || !REMOTE_EVENT_ARTS.has(data.art as PalletEvent['art'])
  ) {
    throw new Error('invalid-remote-art');
  }
  if (typeof data.delta !== 'number' || !Number.isInteger(data.delta)) {
    throw new Error('invalid-remote-delta');
  }
  if (
    typeof data.konfigVersion !== 'string'
    || data.konfigVersion.length === 0
  ) {
    throw new Error('invalid-remote-konfigVersion');
  }

  const buchungszeit = timestampToIso(data.buchungszeit);
  if (!buchungszeit) throw new Error('invalid-remote-buchungszeit');

  const serverzeit = timestampToIso(data.serverzeit);
  if (!serverzeit) throw new Error('invalid-remote-serverzeit');

  const event: PalletEvent = {
    id: data.id,
    geraetId: data.geraetId,
    sorte: data.sorte,
    art: data.art as PalletEvent['art'],
    delta: data.delta,
    buchungszeit,
    serverzeit,
    konfigVersion: data.konfigVersion,
  };

  const person = optionalRemoteString(data, 'person');
  const vorgangId = optionalRemoteString(data, 'vorgangId');
  const korrigiertId = optionalRemoteString(data, 'korrigiertId');
  const umbuchungId = optionalRemoteString(data, 'umbuchungId');
  const umbuchungPartnerId = optionalRemoteString(
    data,
    'umbuchungPartnerId',
  );

  if (person !== undefined) event.person = person;
  if (vorgangId !== undefined) event.vorgangId = vorgangId;
  if (korrigiertId !== undefined) event.korrigiertId = korrigiertId;
  if (umbuchungId !== undefined) event.umbuchungId = umbuchungId;
  if (umbuchungPartnerId !== undefined) {
    event.umbuchungPartnerId = umbuchungPartnerId;
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
      await withTimeout(setDoc(ref, toFirestoreEvent(event)));
      return { status: 'CREATED' };
    } catch (error) {
      if (error instanceof RemoteCreateError) throw error;

      if (error instanceof FirebaseError && error.code === 'permission-denied') {
        try {
          const existing = await withTimeout(getDoc(ref));
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
    const snapshot = await withTimeout(getDoc(doc(this.db, 'events', id)));
    if (!snapshot.exists()) return undefined;
    return fromFirestoreEvent(snapshot.data(), snapshot.id);
  }

  async listEvents(): Promise<PalletEvent[]> {
    const snapshot = await withTimeout(getDocs(
      query(
        collection(this.db, 'events'),
        orderBy('serverzeit', 'asc'),
        orderBy(documentId(), 'asc'),
      ),
    ));
    return snapshot.docs.map((item) => fromFirestoreEvent(item.data(), item.id));
  }

  async listEventsAfter(cursor: RemoteCursor): Promise<PalletEvent[]> {
    const snapshot = await withTimeout(getDocs(
      query(
        collection(this.db, 'events'),
        orderBy('serverzeit', 'asc'),
        orderBy(documentId(), 'asc'),
        startAt(timestampFromExactIso(cursor.serverzeit)),
      ),
    ));
    return snapshot.docs.map((item) => fromFirestoreEvent(item.data(), item.id));
  }

  subscribeEvents(
    onEvent: (event: PalletEvent) => void | Promise<void>,
    onError: (error: unknown) => void,
    after?: RemoteCursor,
  ): RemoteUnsubscribe {
    const source = after
      ? query(
          collection(this.db, 'events'),
          orderBy('serverzeit', 'asc'),
          orderBy(documentId(), 'asc'),
          startAt(timestampFromExactIso(after.serverzeit)),
        )
      : query(
          collection(this.db, 'events'),
          orderBy('serverzeit', 'asc'),
          orderBy(documentId(), 'asc'),
        );

    return onSnapshot(
      source,
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;
          try {
            const event = fromFirestoreEvent(
              change.doc.data(),
              change.doc.id,
            );
            void Promise.resolve(onEvent(event)).catch(onError);
          } catch (error) {
            onError(error);
          }
        }
      },
      onError,
    );
  }
}
