import type { StoredEvent } from '../domain/types';
import { loadProjection, UphoffLocalDb } from '../persistence/localDb';
import { persistAndQueueEvent } from '../persistence/outbox';
import type { PalletTypeConfig } from './config';
import { effectForTap, type CountMode } from './logic';

export type BookingAction = 'STACK' | 'PLUS_ONE' | 'MINUS_ONE';

const DB_NAME = 'uphoff-paletten';

function getDeviceId(): string {
  const key = 'uphoff-device-id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;

  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

export class LocalBookingController {
  readonly db = new UphoffLocalDb(DB_NAME);
  private queue: Promise<void> = Promise.resolve();

  async initialize() {
    await this.db.open();
    return loadProjection(this.db);
  }

  book(
    mode: CountMode,
    pallet: PalletTypeConfig,
    action: BookingAction,
  ): Promise<{ event: StoredEvent; projection: Awaited<ReturnType<typeof loadProjection>> }> {
    const execute = async () => {
      const now = new Date();
      const event: StoredEvent = {
        id: crypto.randomUUID(),
        geraetId: getDeviceId(),
        sorte: pallet.id,
        art: mode === 'EINGANG' ? 'ZUGANG' : 'ABGANG',
        delta: effectForTap(mode, action, pallet.stackSize),
        buchungszeit: now.toISOString(),
        konfigVersion: 'v1',
        syncState: 'LOCAL_ONLY',
        createdLocalAt: now.toISOString(),
      };

      const result = await persistAndQueueEvent(this.db, event, now.getTime());
      if (result.status !== 'QUEUED') {
        throw new Error(`booking-not-queued:${result.status}`);
      }

      const projection = await loadProjection(this.db);
      return { event: result.event, projection };
    };

    const task = this.queue.then(execute, execute);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
