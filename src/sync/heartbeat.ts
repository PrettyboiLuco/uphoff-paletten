import {
  doc,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import { listEvents, type UphoffLocalDb } from '../persistence/localDb';
import { computeCheckCode, getSyncHealth } from './health';

const HEARTBEAT_TIMEOUT_MS = 12_000;

async function withHeartbeatTimeout<T>(
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = globalThis.setTimeout(() => {
          reject(new Error('heartbeat-timeout'));
        }, HEARTBEAT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

export async function writeDeviceHeartbeat(
  firestore: Firestore,
  uid: string,
  localDb: UphoffLocalDb,
  appVersion: string,
): Promise<void> {
  const [events, health] = await Promise.all([
    listEvents(localDb),
    getSyncHealth(localDb),
  ]);

  const confirmed = events.filter(
    (event) => event.syncState === 'CONFIRMED',
  );

  await withHeartbeatTimeout(
    setDoc(doc(firestore, 'heartbeats', uid), {
      uid,
      lastSeen: serverTimestamp(),
      pendingCount: health.pendingCount,
      rejectedCount: health.rejectedCount,
      eventCount: confirmed.length,
      appVersion,
      syncState: health.state,
      checkCodeJson: JSON.stringify(computeCheckCode(events)),
    }),
  );
}
