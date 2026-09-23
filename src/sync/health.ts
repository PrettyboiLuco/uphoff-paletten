import type { StoredEvent } from '../domain/types';
import type { UphoffLocalDb } from '../persistence/localDb';

export interface CheckCodeEntry {
  count: number;
  sum: number;
}

export type CheckCode = Record<string, CheckCodeEntry>;

export function computeCheckCode(events: readonly StoredEvent[]): CheckCode {
  const code: CheckCode = {};

  for (const event of events) {
    if (event.syncState !== 'CONFIRMED') continue;

    const current = code[event.sorte] ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += event.delta;
    code[event.sorte] = current;
  }

  return Object.fromEntries(
    Object.entries(code).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export interface SyncHealth {
  state:
    | 'SYNCHRON'
    | 'PENDING'
    | 'REJECTED'
    | 'NEVER_SYNCED';
  pendingCount: number;
  rejectedCount: number;
  lastSuccessfulSyncAt?: string;
  lastRetryError?: string;
}

export async function getSyncHealth(db: UphoffLocalDb): Promise<SyncHealth> {
  const [pendingCount, rejectedCount, meta, outbox] = await Promise.all([
    db.events
      .filter(
        (event) =>
          event.syncState === 'LOCAL_ONLY' || event.syncState === 'PENDING',
      )
      .count(),
    db.events.where('syncState').equals('REJECTED').count(),
    db.meta.get('lastSuccessfulSyncAt'),
    db.outbox.toArray(),
  ]);

  const latestFailed = outbox
    .filter(
      (item) =>
        item.lastError !== undefined
        && item.lastAttemptAt !== undefined,
    )
    .sort(
      (a, b) =>
        (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0),
    )[0];

  const extras = {
    ...(meta ? { lastSuccessfulSyncAt: meta.value } : {}),
    ...(latestFailed?.lastError
      ? { lastRetryError: latestFailed.lastError }
      : {}),
  };

  if (rejectedCount > 0) {
    return {
      state: 'REJECTED',
      pendingCount,
      rejectedCount,
      ...extras,
    };
  }

  if (pendingCount > 0) {
    return {
      state: 'PENDING',
      pendingCount,
      rejectedCount,
      ...extras,
    };
  }

  if (!meta) {
    return {
      state: 'NEVER_SYNCED',
      pendingCount,
      rejectedCount,
      ...extras,
    };
  }

  return {
    state: 'SYNCHRON',
    pendingCount,
    rejectedCount,
    ...extras,
  };
}
