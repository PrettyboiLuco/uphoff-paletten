import type { PalletEvent, StoredEvent } from '../domain/types';
import { immutableEventSignature, UphoffLocalDb } from '../persistence/localDb';
import {
  getReadyOutboxItems,
  markConfirmed,
  markRejected,
  restoreRetryableRejections,
  scheduleRetry,
} from '../persistence/outbox';
import {
  REMOTE_ERROR_POLICY,
  RemoteCreateError,
  type RemoteEventStore,
} from './types';

function toRemoteEvent(event: StoredEvent): PalletEvent {
  const {
    syncState: _syncState,
    createdLocalAt: _createdLocalAt,
    rejectionReason: _rejectionReason,
    ...remote
  } = event;
  return remote;
}

function sameRemoteContent(local: StoredEvent, remote: PalletEvent): boolean {
  return immutableEventSignature({
    ...local,
    ...remote,
    syncState: local.syncState,
    createdLocalAt: local.createdLocalAt,
  }) === immutableEventSignature(local);
}

export interface SyncPassResult {
  confirmed: number;
  retried: number;
  rejected: number;
  conflicts: number;
  /** Retried because the server denied the write; the device may be blocked. */
  permissionDenied: number;
}

export async function runSyncPass(
  db: UphoffLocalDb,
  remoteStore: RemoteEventStore,
  now: number,
): Promise<SyncPassResult> {
  const result: SyncPassResult = {
    confirmed: 0,
    retried: 0,
    rejected: 0,
    conflicts: 0,
    permissionDenied: 0,
  };

  await restoreRetryableRejections(db, now);
  const items = await getReadyOutboxItems(db, now);
  const orderedItems = [...items].sort(
    (a, b) => a.nextAttemptAt - b.nextAttemptAt,
  );

  const enriched: Array<{ item: (typeof items)[number]; event: StoredEvent }> = [];
  for (const item of orderedItems) {
    const event = await db.events.get(item.eventId);
    if (!event) {
      // The missing local record needs investigation. Keep its outbox marker
      // visible instead of silently erasing the only trace of the booking.
      await scheduleRetry(db, item, now, 'MISSING_LOCAL_EVENT');
      result.retried += 1;
      continue;
    }
    enriched.push({ item, event });
  }

  enriched.sort((a, b) => {
    if (a.event.art === 'KORREKTUR' && b.event.art !== 'KORREKTUR') return 1;
    if (a.event.art !== 'KORREKTUR' && b.event.art === 'KORREKTUR') return -1;
    return a.item.nextAttemptAt - b.item.nextAttemptAt;
  });

  for (const { item, event: local } of enriched) {
    if (local.art === 'KORREKTUR' && local.korrigiertId) {
      const original = await db.events.get(local.korrigiertId);
      if (!original) {
        // An original may arrive from another device on a later pull.
        await scheduleRetry(db, item, now, 'WAITING_FOR_ORIGINAL');
        result.retried += 1;
        continue;
      }

      if (original.syncState === 'REJECTED') {
        await markRejected(db, local.id, 'ORIGINAL_REJECTED');
        result.rejected += 1;
        continue;
      }

      if (original.syncState !== 'CONFIRMED') {
        await scheduleRetry(
          db,
          item,
          now,
          'WAITING_FOR_ORIGINAL_CONFIRMATION',
        );
        result.retried += 1;
        continue;
      }
    }

    try {
      await remoteStore.createEvent(toRemoteEvent(local));
      await markConfirmed(db, local.id);
      result.confirmed += 1;
      continue;
    } catch (error) {
      if (!(error instanceof RemoteCreateError)) {
        await scheduleRetry(db, item, now, 'UNKNOWN_REMOTE_ERROR');
        result.retried += 1;
        continue;
      }

      const policy = REMOTE_ERROR_POLICY[error.code];

      if (policy === 'VERIFY') {
        let remote: PalletEvent | undefined;
        try {
          remote = await remoteStore.getEvent(local.id);
        } catch (readError) {
          // One unreadable document must not abort the pass for every
          // booking behind it; retry this one with backoff instead.
          await scheduleRetry(
            db,
            item,
            now,
            readError instanceof RemoteCreateError ? readError.code : 'TRANSIENT',
          );
          result.retried += 1;
          continue;
        }

        if (!remote) {
          await scheduleRetry(db, item, now, 'VERIFY_NOT_FOUND');
          result.retried += 1;
        } else if (sameRemoteContent(local, remote)) {
          await markConfirmed(db, local.id, remote.serverzeit);
          result.confirmed += 1;
        } else {
          await markRejected(db, local.id, 'ID_CONTENT_CONFLICT');
          result.conflicts += 1;
        }
        continue;
      }

      // All raw remote codes, including an unknown runtime value, retain the
      // booking. The compile-time map checks every declared error code.
      await scheduleRetry(db, item, now, error.code);
      result.retried += 1;
      if (error.code === 'PERMISSION_DENIED') result.permissionDenied += 1;
    }
  }

  return result;
}

