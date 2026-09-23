import type { StoredEvent } from '../domain/types';
import type { OutboxItem } from '../sync/types';
import { immutableEventSignature, UphoffLocalDb } from './localDb';

export type QueueResult =
  | { status: 'QUEUED'; event: StoredEvent; outbox: OutboxItem }
  | { status: 'ALREADY_QUEUED'; event: StoredEvent; outbox?: OutboxItem }
  | { status: 'CONFLICT'; existing: StoredEvent; incoming: StoredEvent };

export async function persistAndQueueEvent(
  db: UphoffLocalDb,
  incoming: StoredEvent,
  now: number,
): Promise<QueueResult> {
  return db.transaction('rw', db.events, db.outbox, async () => {
    const existing = await db.events.get(incoming.id);

    if (existing) {
      if (immutableEventSignature(existing) !== immutableEventSignature(incoming)) {
        return { status: 'CONFLICT', existing, incoming };
      }

      const outbox = await db.outbox.get(incoming.id);
      return outbox
        ? { status: 'ALREADY_QUEUED', event: existing, outbox }
        : { status: 'ALREADY_QUEUED', event: existing };
    }

    const event: StoredEvent = { ...incoming, syncState: 'PENDING' };
    const outbox: OutboxItem = {
      eventId: event.id,
      status: 'READY',
      attemptCount: 0,
      nextAttemptAt: now,
    };

    await db.events.add(event);
    await db.outbox.add(outbox);

    return { status: 'QUEUED', event, outbox };
  });
}

export async function getReadyOutboxItems(
  db: UphoffLocalDb,
  now: number,
  limit = 50,
): Promise<OutboxItem[]> {
  return db.outbox
    .where('nextAttemptAt')
    .belowOrEqual(now)
    .limit(limit)
    .toArray();
}

export async function markConfirmed(
  db: UphoffLocalDb,
  eventId: string,
  serverzeit?: string,
): Promise<void> {
  await db.transaction('rw', db.events, db.outbox, async () => {
    const event = await db.events.get(eventId);
    if (!event) throw new Error(`missing-local-event:${eventId}`);

    await db.events.put({
      ...event,
      syncState: 'CONFIRMED',
      ...(serverzeit ? { serverzeit } : {}),
    });
    await db.outbox.delete(eventId);
  });
}

export async function markRejected(
  db: UphoffLocalDb,
  eventId: string,
  reason: string,
): Promise<void> {
  await db.transaction('rw', db.events, db.outbox, async () => {
    const event = await db.events.get(eventId);
    if (!event) throw new Error(`missing-local-event:${eventId}`);

    await db.events.put({
      ...event,
      syncState: 'REJECTED',
      rejectionReason: reason,
    });
    await db.outbox.delete(eventId);
  });
}

export async function scheduleRetry(
  db: UphoffLocalDb,
  item: OutboxItem,
  now: number,
  error: string,
): Promise<void> {
  const attemptCount = item.attemptCount + 1;
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attemptCount - 1, 6));

  await db.outbox.put({
    ...item,
    status: 'WAITING',
    attemptCount,
    lastAttemptAt: now,
    lastError: error,
    nextAttemptAt: now + delayMs,
  });
}
