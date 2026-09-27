import type { PalletEvent, StoredEvent } from '../domain/types';
import {
  immutableEventSignature,
  type SyncConflict,
  UphoffLocalDb,
} from '../persistence/localDb';
import type {
  RemoteCursor,
  RemoteReadableEventStore,
  RemoteRealtimeEventStore,
  RemoteUnsubscribe,
} from './types';
import { runSyncPass, type SyncPassResult } from './syncEngine';

const CLOCK_SKEW_MARK_MS = 10 * 60 * 1000;
const REMOTE_CURSOR_KEY = 'remoteCursor:v1';

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

function cursorForEvent(event: PalletEvent): RemoteCursor | undefined {
  if (!event.serverzeit) return undefined;
  return {
    serverzeit: event.serverzeit,
    id: event.id,
  };
}

function compareCursor(a: RemoteCursor, b: RemoteCursor): number {
  const aMs = Date.parse(a.serverzeit);
  const bMs = Date.parse(b.serverzeit);

  if (aMs !== bMs) return aMs - bMs;

  // If JavaScript Date precision is equal, the exact RFC3339 fraction still
  // sorts lexicographically because both timestamps are normalized UTC strings.
  if (a.serverzeit !== b.serverzeit) {
    return a.serverzeit.localeCompare(b.serverzeit);
  }

  return a.id.localeCompare(b.id);
}

export async function loadRemoteCursor(
  db: UphoffLocalDb,
): Promise<RemoteCursor | undefined> {
  const stored = await db.meta.get(REMOTE_CURSOR_KEY);
  if (!stored) return undefined;

  try {
    const parsed = JSON.parse(stored.value) as Partial<RemoteCursor>;
    if (
      typeof parsed.serverzeit !== 'string'
      || typeof parsed.id !== 'string'
      || !Number.isFinite(Date.parse(parsed.serverzeit))
    ) {
      return undefined;
    }

    return {
      serverzeit: parsed.serverzeit,
      id: parsed.id,
    };
  } catch {
    return undefined;
  }
}

async function saveRemoteCursor(
  db: UphoffLocalDb,
  candidate: RemoteCursor,
): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    const existing = await loadRemoteCursor(db);
    if (existing && compareCursor(existing, candidate) >= 0) return;

    await db.meta.put({
      key: REMOTE_CURSOR_KEY,
      value: JSON.stringify(candidate),
    });
  });
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
  const cursor = await loadRemoteCursor(db);
  const remoteEvents =
    cursor && remoteStore.listEventsAfter
      ? await remoteStore.listEventsAfter(cursor)
      : await remoteStore.listEvents();

  const ordered = [...remoteEvents].sort((a, b) => {
    const aCursor = cursorForEvent(a);
    const bCursor = cursorForEvent(b);
    if (!aCursor && !bCursor) return a.id.localeCompare(b.id);
    if (!aCursor) return -1;
    if (!bCursor) return 1;
    return compareCursor(aCursor, bCursor);
  });

  const result: PullResult = {
    added: 0,
    confirmedExisting: 0,
    conflicts: 0,
  };

  for (const remoteEvent of ordered) {
    const applied = await applyRemoteEvent(db, remoteEvent, nowIso);
    if (applied.status === 'ADDED') result.added += 1;
    if (applied.status === 'CONFIRMED_EXISTING') {
      result.confirmedExisting += 1;
    }
    if (applied.status === 'CONFLICT') result.conflicts += 1;

    const nextCursor = cursorForEvent(remoteEvent);
    if (nextCursor) await saveRemoteCursor(db, nextCursor);
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

export async function startRealtimeSync(
  db: UphoffLocalDb,
  remoteStore: RemoteRealtimeEventStore,
  nowIso: () => string,
  onError: (error: unknown) => void,
  onApplied?: (
    result: ApplyRemoteResult,
    event: PalletEvent,
  ) => void | Promise<void>,
): Promise<RemoteUnsubscribe> {
  const cursor = await loadRemoteCursor(db);
  let pending = Promise.resolve();
  let failed = false;

  const reportError = (error: unknown) => {
    if (failed) return;
    failed = true;
    onError(error);
  };

  // Snapshot callbacks may overlap. A later cursor must never pass an event
  // whose local write is still pending or has failed.
  return remoteStore.subscribeEvents(
    (event) => {
      if (failed) return Promise.resolve();
      const next = pending.then(async () => {
        if (failed) return;
        const result = await applyRemoteEvent(db, event, nowIso());
        const nextCursor = cursorForEvent(event);
        if (nextCursor) await saveRemoteCursor(db, nextCursor);
        if (onApplied) await onApplied(result, event);
      });
      pending = next.catch(reportError);
      return next;
    },
    reportError,
    cursor,
  );
}
