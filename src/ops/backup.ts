import type { StoredEvent } from '../domain/types';
import {
  immutableEventSignature,
  type SyncConflict,
  type UphoffLocalDb,
} from '../persistence/localDb';
import type { OutboxItem } from '../sync/types';
import type { BackupPackage } from './types';

const syncRank: Record<StoredEvent['syncState'], number> = {
  REJECTED: 0,
  LOCAL_ONLY: 1,
  PENDING: 2,
  CONFIRMED: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredEvent(value: unknown): value is StoredEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.geraetId === 'string'
    && typeof value.sorte === 'string'
    && typeof value.art === 'string'
    && typeof value.delta === 'number'
    && Number.isInteger(value.delta)
    && typeof value.buchungszeit === 'string'
    && typeof value.konfigVersion === 'string'
    && typeof value.syncState === 'string'
    && ['LOCAL_ONLY', 'PENDING', 'CONFIRMED', 'REJECTED'].includes(value.syncState)
    && typeof value.createdLocalAt === 'string'
  );
}

function isOutboxItem(value: unknown): value is OutboxItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.eventId === 'string'
    && (value.status === 'READY' || value.status === 'WAITING')
    && typeof value.attemptCount === 'number'
    && Number.isInteger(value.attemptCount)
    && typeof value.nextAttemptAt === 'number'
  );
}

function isSyncConflict(value: unknown): value is SyncConflict {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.eventId === 'string'
    && typeof value.detectedAt === 'string'
    && value.reason === 'ID_CONTENT_CONFLICT'
    && isStoredEvent(value.localEvent)
    && isStoredEvent(value.remoteEvent)
  );
}

function validateBackup(value: unknown): {
  events: StoredEvent[];
  outbox: OutboxItem[];
  conflicts: SyncConflict[];
} {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    throw new Error('invalid-backup-envelope');
  }

  if (
    value.manifest.schemaVersion !== 1
    || value.manifest.app !== 'uphoff-paletten'
    || !Array.isArray(value.events)
    || !Array.isArray(value.outbox)
    || !Array.isArray(value.conflicts)
  ) {
    throw new Error('unsupported-backup');
  }

  if (!value.events.every(isStoredEvent)) throw new Error('invalid-backup-events');
  if (!value.outbox.every(isOutboxItem)) throw new Error('invalid-backup-outbox');
  if (!value.conflicts.every(isSyncConflict)) throw new Error('invalid-backup-conflicts');

  const eventIds = new Set(value.events.map((event) => event.id));
  if (eventIds.size !== value.events.length) throw new Error('duplicate-event-id-in-backup');

  for (const item of value.outbox) {
    if (!eventIds.has(item.eventId)) throw new Error('orphan-outbox-in-backup');
  }

  return {
    events: value.events,
    outbox: value.outbox,
    conflicts: value.conflicts,
  };
}

export async function createJsonBackup(
  db: UphoffLocalDb,
  exportedAt: string,
): Promise<string> {
  const [events, outbox, conflicts] = await Promise.all([
    db.events.toArray(),
    db.outbox.toArray(),
    db.conflicts.toArray(),
  ]);

  const backup: BackupPackage = {
    manifest: {
      schemaVersion: 1,
      exportedAt,
      app: 'uphoff-paletten',
      eventCount: events.length,
      outboxCount: outbox.length,
      conflictCount: conflicts.length,
    },
    events,
    outbox,
    conflicts,
  };

  return JSON.stringify(backup, null, 2);
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function createCsvAudit(db: UphoffLocalDb): Promise<string> {
  const events = await db.events.orderBy('buchungszeit').toArray();
  const headers = [
    'id',
    'geraetId',
    'person',
    'sorte',
    'art',
    'delta',
    'buchungszeit',
    'serverzeit',
    'konfigVersion',
    'vorgangId',
    'korrigiertId',
    'umbuchungId',
    'syncState',
    'rejectionReason',
  ];

  const lines = [headers.map(csvCell).join(';')];

  for (const event of events) {
    lines.push(
      [
        event.id,
        event.geraetId,
        event.person,
        event.sorte,
        event.art,
        event.delta,
        event.buchungszeit,
        event.serverzeit,
        event.konfigVersion,
        event.vorgangId,
        event.korrigiertId,
        event.umbuchungId,
        event.syncState,
        event.rejectionReason,
      ].map(csvCell).join(';'),
    );
  }

  return lines.join('\n');
}

export interface RestoreResult {
  inserted: number;
  merged: number;
  outboxRestored: number;
  conflictsRestored: number;
}

export async function restoreJsonBackup(
  db: UphoffLocalDb,
  json: string,
): Promise<RestoreResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('invalid-backup-json');
  }

  const backup = validateBackup(parsed);
  const result: RestoreResult = {
    inserted: 0,
    merged: 0,
    outboxRestored: 0,
    conflictsRestored: 0,
  };

  await db.transaction(
    'rw',
    db.events,
    db.outbox,
    db.conflicts,
    async () => {
      for (const incoming of backup.events) {
        const existing = await db.events.get(incoming.id);
        if (!existing) continue;

        if (immutableEventSignature(existing) !== immutableEventSignature(incoming)) {
          throw new Error(`restore-id-content-conflict:${incoming.id}`);
        }
      }

      for (const incoming of backup.conflicts) {
        const existing = await db.conflicts.get(incoming.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(incoming)) {
          throw new Error(`restore-conflict-record-mismatch:${incoming.id}`);
        }
      }

      for (const incoming of backup.events) {
        const existing = await db.events.get(incoming.id);
        if (!existing) {
          await db.events.add(incoming);
          result.inserted += 1;
          continue;
        }

        const chosen = syncRank[incoming.syncState] > syncRank[existing.syncState]
          ? { ...existing, ...incoming }
          : existing;
        await db.events.put(chosen);
        result.merged += 1;
      }

      for (const item of backup.outbox) {
        const event = await db.events.get(item.eventId);
        if (!event || event.syncState === 'CONFIRMED' || event.syncState === 'REJECTED') {
          continue;
        }
        await db.outbox.put(item);
        result.outboxRestored += 1;
      }

      for (const conflict of backup.conflicts) {
        await db.conflicts.put(conflict);
        result.conflictsRestored += 1;
      }
    },
  );

  return result;
}

export async function markExternalBackupDone(
  db: UphoffLocalDb,
  iso: string,
): Promise<void> {
  await db.meta.put({ key: 'lastExternalBackupAt', value: iso });
}

export async function isExternalBackupDue(
  db: UphoffLocalDb,
  nowIso: string,
  maxAgeDays = 7,
): Promise<boolean> {
  const stored = await db.meta.get('lastExternalBackupAt');
  if (!stored) return true;

  const then = Date.parse(stored.value);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return true;
  return now - then >= maxAgeDays * 24 * 60 * 60 * 1000;
}
