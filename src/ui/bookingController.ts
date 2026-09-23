import type { StoredEvent } from '../domain/types';
import { correctionId } from '../domain/projection';
import { loadProjection, UphoffLocalDb } from '../persistence/localDb';
import {
  persistAndQueueEvent,
  persistAndQueueEvents,
} from '../persistence/outbox';
import type { PalletTypeConfig } from './config';
import { effectForTap, type CountMode } from './logic';

export type BookingAction = 'STACK' | 'PLUS_ONE' | 'MINUS_ONE';

const DB_NAME = 'uphoff-paletten';
const PROCESS_LINK_WINDOW_MS = 12_000;

function getDeviceId(): string {
  const key = 'uphoff-device-id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;

  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

interface ActiveProcess {
  id: string;
  palletId: string;
  mode: CountMode;
  lastAtMs: number;
}

export class LocalBookingController {
  readonly db = new UphoffLocalDb(DB_NAME);
  private queue: Promise<void> = Promise.resolve();
  private activeProcess: ActiveProcess | null = null;
  private deviceId = getDeviceId();

  async initialize() {
    await this.db.open();
    return loadProjection(this.db);
  }

  setDeviceId(deviceId: string): void {
    this.deviceId = deviceId;
    localStorage.setItem('uphoff-device-id', deviceId);
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  private processForTap(
    mode: CountMode,
    palletId: string,
    action: BookingAction,
    nowMs: number,
  ): string {
    if (
      action !== 'STACK'
      && this.activeProcess
      && this.activeProcess.mode === mode
      && this.activeProcess.palletId === palletId
      && nowMs - this.activeProcess.lastAtMs <= PROCESS_LINK_WINDOW_MS
    ) {
      this.activeProcess.lastAtMs = nowMs;
      return this.activeProcess.id;
    }

    const id = crypto.randomUUID();
    this.activeProcess = {
      id,
      palletId,
      mode,
      lastAtMs: nowMs,
    };
    return id;
  }

  book(
    mode: CountMode,
    pallet: PalletTypeConfig,
    action: BookingAction,
  ): Promise<{
    event: StoredEvent;
    projection: Awaited<ReturnType<typeof loadProjection>>;
    processId: string;
  }> {
    const execute = async () => {
      const now = new Date();
      const processId = this.processForTap(
        mode,
        pallet.id,
        action,
        now.getTime(),
      );
      const event: StoredEvent = {
        id: crypto.randomUUID(),
        geraetId: this.deviceId,
        sorte: pallet.id,
        art: mode === 'EINGANG' ? 'ZUGANG' : 'ABGANG',
        delta: effectForTap(mode, action, pallet.stackSize),
        buchungszeit: now.toISOString(),
        konfigVersion: 'v1',
        vorgangId: processId,
        syncState: 'LOCAL_ONLY',
        createdLocalAt: now.toISOString(),
      };

      const result = await persistAndQueueEvent(this.db, event, now.getTime());
      if (result.status !== 'QUEUED') {
        throw new Error(`booking-not-queued:${result.status}`);
      }

      const projection = await loadProjection(this.db);
      return { event: result.event, projection, processId };
    };

    const task = this.queue.then(execute, execute);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  undoProcess(
    processId: string,
  ): Promise<{ projection: Awaited<ReturnType<typeof loadProjection>>; correctedCount: number }> {
    const execute = async () => {
      const originals = await this.db.events
        .where('vorgangId')
        .equals(processId)
        .filter(
          (event) =>
            event.art !== 'KORREKTUR'
            && event.syncState !== 'REJECTED',
        )
        .toArray();

      const now = new Date();
      const corrections: StoredEvent[] = [];

      for (const original of originals) {
        const id = correctionId(original.id);
        const existing = await this.db.events.get(id);
        if (existing) continue;

        corrections.push({
          id,
          geraetId: this.deviceId,
          sorte: original.sorte,
          art: 'KORREKTUR',
          delta: -original.delta,
          buchungszeit: now.toISOString(),
          konfigVersion: original.konfigVersion,
          vorgangId: `undo_${processId}`,
          korrigiertId: original.id,
          syncState: 'LOCAL_ONLY',
          createdLocalAt: now.toISOString(),
        });
      }

      if (corrections.length > 0) {
        const result = await persistAndQueueEvents(
          this.db,
          corrections,
          now.getTime(),
        );
        if (result.status === 'CONFLICT') {
          throw new Error('undo-correction-conflict');
        }
      }

      this.activeProcess = null;
      return {
        projection: await loadProjection(this.db),
        correctedCount: corrections.length,
      };
    };

    const task = this.queue.then(execute, execute);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
