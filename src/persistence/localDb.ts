import Dexie, { type EntityTable } from 'dexie';
import type { StoredEvent } from '../domain/types';
import type { OutboxItem } from '../sync/types';
import { project } from '../domain/projection';

export interface LocalMeta {
  key: string;
  value: string;
}

export class UphoffLocalDb extends Dexie {
  events!: EntityTable<StoredEvent, 'id'>;
  meta!: EntityTable<LocalMeta, 'key'>;
  outbox!: EntityTable<OutboxItem, 'eventId'>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      events: '&id, buchungszeit, sorte, art, syncState, geraetId, konfigVersion',
      meta: '&key',
      outbox: '&eventId, status, nextAttemptAt, attemptCount',
    });
  }
}

export function immutableEventSignature(event: StoredEvent): string {
  return JSON.stringify({
    id: event.id,
    geraetId: event.geraetId,
    person: event.person ?? null,
    sorte: event.sorte,
    art: event.art,
    delta: event.delta,
    buchungszeit: event.buchungszeit,
    konfigVersion: event.konfigVersion,
    vorgangId: event.vorgangId ?? null,
    korrigiertId: event.korrigiertId ?? null,
    umbuchungId: event.umbuchungId ?? null,
    umbuchungPartnerId: event.umbuchungPartnerId ?? null,
  });
}

export type PersistResult =
  | { status: 'CREATED'; event: StoredEvent }
  | { status: 'ALREADY_EXISTS'; event: StoredEvent }
  | { status: 'CONFLICT'; existing: StoredEvent; incoming: StoredEvent };

export async function persistEvent(
  db: UphoffLocalDb,
  incoming: StoredEvent,
): Promise<PersistResult> {
  return db.transaction('rw', db.events, async () => {
    const existing = await db.events.get(incoming.id);

    if (!existing) {
      await db.events.add(incoming);
      return { status: 'CREATED', event: incoming };
    }

    if (immutableEventSignature(existing) === immutableEventSignature(incoming)) {
      return { status: 'ALREADY_EXISTS', event: existing };
    }

    return { status: 'CONFLICT', existing, incoming };
  });
}

export async function loadProjection(db: UphoffLocalDb) {
  const events = await db.events.toArray();
  return project(events);
}

export async function listEvents(db: UphoffLocalDb): Promise<StoredEvent[]> {
  return db.events.toArray();
}
