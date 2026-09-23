import type { PalletEvent, StoredEvent } from '../domain/types';
import {
  immutableEventSignature,
  type SyncConflict,
  UphoffLocalDb,
} from '../persistence/localDb';
import type {
  RemoteReadableEventStore,
  RemoteRealtimeEventStore,
  RemoteUnsubscribe,
} from './types';
import { runSyncPass, type SyncPassResult } from './syncEngine';

const CLOCK_SKEW_MARK_MS = 10 * 60 * 1000;

function toConfirmedStoredEvent(
  remote: PalletEvent,
  createdLocalAt: string,
): StoredEvent {
  const event: StoredEvent = {
    ...remote,
    syncState: 'CONFIRMED',
    createdLocalAt,
  };

  if (remote.serverzeit) {
    const bookingMs = Date.parse(remote.buchungszeit);
    const serverMs = Date.parse(remote.serverzeit);
    if (
      Number.isFinite(bookingMs)
      && Number.isFinite(serverMs)
      && Math.abs(serverMs - bookingMs) > CLOCK_SKEW_MARK_MS
    ) {
      event.clockSkewFlag = true;
    }
  }

  return event;
}

export type ApplyRemoteResult =
  | { status: 'ADDED' }
  | { status: 'CONFIRMED_EXISTING' }
  | { status: 'CONFLICT' };

export async function applyRemoteEvent(
  db: UphoffLocalDb,
  remoteEvent: PalletEvent,
  nowIso: string,
): Promise<ApplyRemoteResult> {
  return db.transaction(
    'rw',
    db.events,
    db.outbox,
    db.conflicts,
    async () => {
      const canonical = toConfirmedStoredEvent(remoteEvent, nowIso);
      const existing = await db.events.get(remoteEvent.id);

      if (!existing) {
        await db.events.add(canonical);
        return { status: 'ADDED' };
      }

      if (
        immutableEventSignature(existing)
        === immutableEventSignature(canonical)
      ) {
        await db.events.put({
          ...canonical,
          createdLocalAt: existing.createdLocalAt,
        });
        await db.outbox.delete(remoteEvent.id);
        return { status: 'CONFIRMED_EXISTING' };
      }

      const conflict: SyncConflict = {
        id: `conflict_${remoteEvent.id}`,
        eventId: remoteEvent.id,
        detectedAt: nowIso,
        reason: 'ID_CONTENT_CONFLICT',
        localEvent: existing,
        remoteEvent: canonical,
      };

      await db.conflicts.put(conflict);
      await db.events.put(canonical);
      await db.outbox.delete(remoteEvent.id);
      return { status: 'CONFLICT' };
    },
  );
}

export interface PullResult {
  added: number;
  confirmedExisting: number;
  conflicts: number;
}

export async function pullRemoteEvents(
  db: UphoffLocalDb,
  remoteStore: RemoteReadableEventStore,
  nowIso: string,
): Promise<PullResult> {
  const remoteEvents = await remoteStore.listEvents();
  const result: PullResult = {
    added: 0,
    confirmedExisting: 0,
    conflicts: 0,
  };

  for (const remoteEvent of remoteEvents) {
    const applied = await applyRemoteEvent(db, remoteEvent, nowIso);
    if (applied.status === 'ADDED') result.added += 1;
    if (applied.status === 'CONFIRMED_EXISTING') {
      result.confirmedExisting += 1;
    }
    if (applied.status === 'CONFLICT') result.conflicts += 1;
  }

  return result;
}

export interface FullSyncResult {
  push: SyncPassResult;
  pull: PullResult;
}

export async function runFullSync(
  db: UphoffLocalDb,
  remoteStore: RemoteReadableEventStore,
  nowMs: number,
  nowIso: string,
): Promise<FullSyncResult> {
  const push = await runSyncPass(db, remoteStore, nowMs);
  const pull = await pullRemoteEvents(db, remoteStore, nowIso);

  await db.meta.put({
    key: 'lastSuccessfulSyncAt',
    value: nowIso,
  });

  return { push, pull };
}

export function startRealtimeSync(
  db: UphoffLocalDb,
  remoteStore: RemoteRealtimeEventStore,
  nowIso: () => string,
  onError: (error: unknown) => void,
): RemoteUnsubscribe {
  return remoteStore.subscribeEvents(
    async (event) => {
      await applyRemoteEvent(db, event, nowIso());
    },
    onError,
  );
}
