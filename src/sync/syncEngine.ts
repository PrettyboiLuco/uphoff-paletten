import type { PalletEvent, StoredEvent } from '../domain/types';
import { immutableEventSignature, UphoffLocalDb } from '../persistence/localDb';
import {
  getReadyOutboxItems,
  markConfirmed,
  markRejected,
  scheduleRetry,
} from '../persistence/outbox';
import {
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
  };

  const items = await getReadyOutboxItems(db, now);

  for (const item of items) {
    const local = await db.events.get(item.eventId);
    if (!local) {
      await db.outbox.delete(item.eventId);
      continue;
    }

    try {
      await remoteStore.createEvent(toRemoteEvent(local));
      await markConfirmed(db, local.id);
      result.confirmed += 1;
      continue;
    } catch (error) {
      if (!(error instanceof RemoteCreateError)) throw error;

      if (error.code === 'ALREADY_EXISTS') {
        const remote = await remoteStore.getEvent(local.id);

        if (remote && sameRemoteContent(local, remote)) {
          await markConfirmed(db, local.id, remote.serverzeit);
          result.confirmed += 1;
        } else {
          await markRejected(db, local.id, 'ID_CONTENT_CONFLICT');
          result.conflicts += 1;
        }
        continue;
      }

      if (
        error.code === 'TRANSIENT' ||
        error.code === 'UNAUTHENTICATED' ||
        error.code === 'QUOTA_EXHAUSTED'
      ) {
        await scheduleRetry(db, item, now, error.code);
        result.retried += 1;
        continue;
      }

      await markRejected(db, local.id, error.code);
      result.rejected += 1;
    }
  }

  return result;
}
