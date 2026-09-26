import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBookingController } from '../src/ui/bookingController';
import { PALLET_TYPES } from '../src/ui/config';
import { loadProjection } from '../src/persistence/localDb';

const pallet = PALLET_TYPES[0]!;
const controllers: LocalBookingController[] = [];
const saved = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
});

async function controller(): Promise<LocalBookingController> {
  const instance = new LocalBookingController();
  controllers.push(instance);
  await instance.initialize();
  return instance;
}

afterEach(async () => {
  for (const item of controllers.splice(0)) {
    await item.db.delete();
  }
  saved.clear();
});

describe('stock cannot be booked below zero', () => {
  it('rejects a removal at zero without creating an event', async () => {
    const item = await controller();
    await expect(item.book('AUSGANG', pallet, 'STACK')).rejects.toThrow('insufficient-stock');
    await expect(item.book('EINGANG', pallet, 'MINUS_ONE')).rejects.toThrow('insufficient-stock');
    expect(await item.db.events.count()).toBe(0);
  });

  it('serializes fast taps so only available stock is removed', async () => {
    const item = await controller();
    await item.book('EINGANG', pallet, 'PLUS_ONE');
    const results = await Promise.allSettled([
      item.book('AUSGANG', pallet, 'MINUS_ONE'),
      item.book('AUSGANG', pallet, 'MINUS_ONE'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await loadProjection(item.db)).bestandJeSorte[pallet.id]).toBe(0);
    expect(await item.db.events.count()).toBe(2);
  });

  it('keeps stock at zero when two open tabs remove the last pallet together', async () => {
    const first = await controller();
    const second = await controller();
    await first.book('EINGANG', pallet, 'PLUS_ONE');
    const results = await Promise.allSettled([
      first.book('AUSGANG', pallet, 'MINUS_ONE'),
      second.book('AUSGANG', pallet, 'MINUS_ONE'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await loadProjection(first.db)).bestandJeSorte[pallet.id]).toBe(0);
  });

  it('rejects an inventory adjustment or undo that would cross zero', async () => {
    const item = await controller();
    const incoming = await item.book('EINGANG', pallet, 'PLUS_ONE');
    await expect(item.adminAdjustment('INVENTUR', pallet, -2)).rejects.toThrow('insufficient-stock');
    await item.book('AUSGANG', pallet, 'MINUS_ONE');
    await expect(item.undoProcess(incoming.processId)).rejects.toThrow('insufficient-stock');
    expect((await loadProjection(item.db)).bestandJeSorte[pallet.id]).toBe(0);
    expect(await item.db.events.count()).toBe(2);
  });
});
