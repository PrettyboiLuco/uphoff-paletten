import type { StoredEvent } from '../domain/types';
import { assessOperation, correctionId } from '../domain/projection';
import { loadProjection, UphoffLocalDb } from '../persistence/localDb';
import {
  persistAndQueueEvent,
  persistAndQueueEvents,
} from '../persistence/outbox';
import { PALLET_CONFIG_VERSION, type PalletTypeConfig } from './config';
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
    operationWarning: 'NONE' | 'ZERO_NET' | 'WRONG_SIGN';
  }> {
    const tappedAt = new Date();
    const eventId = crypto.randomUUID();

    const execute = async () => {
      const delta = effectForTap(mode, action, pallet.stackSize);
      const processId = this.processForTap(
        mode,
        pallet.id,
        action,
        tappedAt.getTime(),
      );
      const event: StoredEvent = {
        id: eventId,
        geraetId: this.deviceId,
        sorte: pallet.id,
        art: mode === 'EINGANG' ? 'ZUGANG' : 'ABGANG',
        delta,
        buchungszeit: tappedAt.toISOString(),
        konfigVersion: PALLET_CONFIG_VERSION,
        vorgangId: processId,
        syncState: 'LOCAL_ONLY',
        createdLocalAt: tappedAt.toISOString(),
      };

      const result = await this.db.transaction('rw', this.db.events, this.db.outbox, async () => {
        const current = (await loadProjection(this.db)).bestandJeSorte[pallet.id] ?? 0;
        if (current + delta < 0) throw new Error('insufficient-stock');
        return persistAndQueueEvent(this.db, event, tappedAt.getTime());
      });
      if (result.status !== 'QUEUED') {
        throw new Error(`booking-not-queued:${result.status}`);
      }

      const processEvents = await this.db.events
        .where('vorgangId')
        .equals(processId)
        .filter(
          (candidate) =>
            candidate.art !== 'KORREKTUR'
            && candidate.syncState !== 'REJECTED',
        )
        .toArray();

      const assessment = assessOperation(
        mode,
        processEvents.map((candidate) => candidate.delta),
      );

      const projection = await loadProjection(this.db);
      return {
        event: result.event,
        projection,
        processId,
        operationWarning: assessment.warning,
      };
    };

    const task = this.queue.then(execute, execute);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  adminAdjustment(
    art: 'ANFANGSBESTAND' | 'INVENTUR',
    pallet: PalletTypeConfig,
    delta: number,
  ): Promise<{
    event: StoredEvent;
    projection: Awaited<ReturnType<typeof loadProjection>>;
  }> {
    if (!Number.isInteger(delta) || delta === 0) {
      return Promise.reject(new Error('invalid-admin-delta'));
    }
    if (art === 'ANFANGSBESTAND' && delta < 0) {
      return Promise.reject(new Error('invalid-initial-stock'));
    }

    const tappedAt = new Date();
    const id =
      art === 'ANFANGSBESTAND'
        ? `anfang_${pallet.id}`
        : crypto.randomUUID();

    const execute = async () => {
      const event: StoredEvent = {
        id,
        geraetId: this.deviceId,
        sorte: pallet.id,
        art,
        delta,
        buchungszeit: tappedAt.toISOString(),
        konfigVersion: PALLET_CONFIG_VERSION,
        vorgangId: `admin_${id}`,
        syncState: 'LOCAL_ONLY',
        createdLocalAt: tappedAt.toISOString(),
      };

      const result = await this.db.transaction('rw', this.db.events, this.db.outbox, async () => {
        const current = (await loadProjection(this.db)).bestandJeSorte[pallet.id] ?? 0;
        if (current + delta < 0) throw new Error('insufficient-stock');
        return persistAndQueueEvent(this.db, event, tappedAt.getTime());
      });
      if (result.status !== 'QUEUED') {
        throw new Error(
          art === 'ANFANGSBESTAND'
            ? 'initial-stock-already-exists'
            : `admin-adjustment-not-queued:${result.status}`,
        );
      }

      this.activeProcess = null;
      return {
        event: result.event,
        projection: await loadProjection(this.db),
      };
    };

    const task = this.queue.then(execute, execute);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  undoProcess(
    processId: string,
  ): Promise<{ projection: Awaited<ReturnType<typeof loadProjection>>; correctedCount: number }> {
    const execute = async () => this.db.transaction('rw', this.db.events, this.db.outbox, async () => {
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
        const projection = await loadProjection(this.db);
        const correctionsBySort = new Map<string, number>();
        for (const correction of corrections) {
          correctionsBySort.set(
            correction.sorte,
            (correctionsBySort.get(correction.sorte) ?? 0) + correction.delta,
          );
        }
        for (const [sort, delta] of correctionsBySort) {
          if ((projection.bestandJeSorte[sort] ?? 0) + delta < 0) {
            throw new Error('insufficient-stock');
          }
        }

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
    });

    const task = this.queue.then(execute, execute);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
