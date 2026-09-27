import type { PalletEvent, StoredEvent } from '../domain/types';
import { listEvents, type UphoffLocalDb } from '../persistence/localDb';
import { computeCheckCode } from '../sync/health';
import type { RemoteReadableEventStore } from '../sync/types';
import type { DeviceHealthSnapshot } from './types';

export async function localHealthSnapshot(
  db: UphoffLocalDb,
  checkedAt: string,
): Promise<DeviceHealthSnapshot> {
  const [events, conflictCount] = await Promise.all([
    listEvents(db),
    db.conflicts.count(),
  ]);

  const confirmed = events.filter((event) => event.syncState === 'CONFIRMED');

  return {
    checkedAt,
    eventCount: confirmed.length,
    pendingCount: events.filter(
      (event) => event.syncState === 'PENDING' || event.syncState === 'LOCAL_ONLY',
    ).length,
    rejectedCount: events.filter((event) => event.syncState === 'REJECTED').length,
    conflictCount,
    checkCode: computeCheckCode(events),
  };
}

function remoteAsStored(event: PalletEvent, checkedAt: string): StoredEvent {
  return {
    ...event,
    syncState: 'CONFIRMED',
    createdLocalAt: checkedAt,
  };
}

export interface SelfTestResult {
  status: 'MATCH' | 'MISMATCH' | 'ATTENTION';
  checkedAt: string;
  local: DeviceHealthSnapshot;
  remoteEventCount: number;
  remoteCheckCode: DeviceHealthSnapshot['checkCode'];
}

export async function runServerSelfTest(
  db: UphoffLocalDb,
  remote: RemoteReadableEventStore,
  checkedAt: string,
): Promise<SelfTestResult> {
  const local = await localHealthSnapshot(db, checkedAt);
  const remoteEvents = await remote.listEvents();
  const remoteStored = remoteEvents.map((event) => remoteAsStored(event, checkedAt));
  const remoteCheckCode = computeCheckCode(remoteStored);

  if (
    local.pendingCount > 0
    || local.rejectedCount > 0
    || local.conflictCount > 0
  ) {
    return {
      status: 'ATTENTION',
      checkedAt,
      local,
      remoteEventCount: remoteEvents.length,
      remoteCheckCode,
    };
  }

  const match = (
    local.eventCount === remoteEvents.length
    && JSON.stringify(local.checkCode) === JSON.stringify(remoteCheckCode)
  );

  return {
    status: match ? 'MATCH' : 'MISMATCH',
    checkedAt,
    local,
    remoteEventCount: remoteEvents.length,
    remoteCheckCode,
  };
}
