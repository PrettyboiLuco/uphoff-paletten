import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { UphoffLocalDb, listEvents, loadProjection, persistEvent } from '../src/persistence/localDb';
import type { StoredEvent } from '../src/domain/types';

const dbNames: string[] = [];

function makeDb(name: string): UphoffLocalDb {
  dbNames.push(name);
  return new UphoffLocalDb(name);
}

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'event-1',
    geraetId: 'ipad',
    sorte: 'EURO',
    art: 'ZUGANG',
    delta: 15,
    buchungszeit: '2026-09-23T12:00:00+02:00',
    konfigVersion: 1,
    syncState: 'LOCAL_ONLY',
    createdLocalAt: '2026-09-23T12:00:00+02:00',
    ...overrides,
  };
}

afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    await DexieCleanup(name);
  }
});

async function DexieCleanup(name: string): Promise<void> {
  const db = new UphoffLocalDb(name);
  await db.delete();
}

describe('E2.1 local journal', () => {
  it('persists an event and restores it after closing/reopening the database', async () => {
    const dbName = 'e21-reopen';
    let db = makeDb(dbName);

    const result = await persistEvent(db, makeEvent());
    expect(result.status).toBe('CREATED');

    await db.close();

    db = new UphoffLocalDb(dbName);
    const events = await listEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('event-1');
    expect(events[0]?.delta).toBe(15);
    await db.close();
  });

  it('reconstructs the exact same projection after restart', async () => {
    const dbName = 'e21-projection';
    let db = makeDb(dbName);

    await persistEvent(db, makeEvent({ id: 'a', delta: 15 }));
    await persistEvent(db, makeEvent({ id: 'b', delta: -1 }));
    await persistEvent(db, makeEvent({ id: 'c', delta: -1 }));

    const before = await loadProjection(db);
    await db.close();

    db = new UphoffLocalDb(dbName);
    const after = await loadProjection(db);

    expect(after).toEqual(before);
    expect(after.bestandGesamt).toBe(13);
    expect(after.dazugekommen).toBe(13);
    await db.close();
  });

  it('treats exact same-id retry as idempotent', async () => {
    const db = makeDb('e21-idempotent');
    const event = makeEvent();

    expect((await persistEvent(db, event)).status).toBe('CREATED');
    expect((await persistEvent(db, { ...event })).status).toBe('ALREADY_EXISTS');

    const events = await listEvents(db);
    expect(events).toHaveLength(1);
    expect((await loadProjection(db)).bestandGesamt).toBe(15);
    await db.close();
  });

  it('quarantines same-id conflicting content by refusing the second write', async () => {
    const db = makeDb('e21-conflict');
    const original = makeEvent({ id: 'conflict', delta: 15 });
    const conflict = makeEvent({ id: 'conflict', delta: 17 });

    expect((await persistEvent(db, original)).status).toBe('CREATED');
    const result = await persistEvent(db, conflict);

    expect(result.status).toBe('CONFLICT');
    const events = await listEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]?.delta).toBe(15);
    await db.close();
  });

  it('does not leave a partial visible event when an IndexedDB transaction aborts', async () => {
    const db = makeDb('e21-abort');

    await expect(
      db.transaction('rw', db.events, async () => {
        await db.events.add(makeEvent({ id: 'will-abort' }));
        throw new Error('simulated-crash-before-commit');
      }),
    ).rejects.toThrow('simulated-crash-before-commit');

    expect(await listEvents(db)).toHaveLength(0);
    expect((await loadProjection(db)).bestandGesamt).toBe(0);
    await db.close();
  });

  it('keeps 250 offline events intact across reopen', async () => {
    const dbName = 'e21-offline-burst';
    let db = makeDb(dbName);

    for (let i = 0; i < 250; i += 1) {
      await persistEvent(
        db,
        makeEvent({
          id: `offline-${i}`,
          delta: i % 2 === 0 ? 15 : -1,
          buchungszeit: `2026-09-23T12:${String(i % 60).padStart(2, '0')}:00+02:00`,
        }),
      );
    }

    const before = await loadProjection(db);
    await db.close();

    db = new UphoffLocalDb(dbName);
    const events = await listEvents(db);
    const after = await loadProjection(db);

    expect(events).toHaveLength(250);
    expect(after).toEqual(before);
    await db.close();
  });
});
