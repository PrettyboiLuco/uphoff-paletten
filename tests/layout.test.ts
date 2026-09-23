import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { UphoffLocalDb } from '../src/persistence/localDb';
import {
  defaultLayout,
  moveItem,
  resizeItem,
  snap,
  validateLayout,
} from '../src/layout/layout';
import {
  loadLayout,
  restoreDefaultLayout,
  saveLayout,
} from '../src/layout/storage';

const dbNames: string[] = [];

function db(name: string) {
  dbNames.push(name);
  return new UphoffLocalDb(name);
}

afterEach(async () => {
  for (const name of dbNames.splice(0)) {
    const database = new UphoffLocalDb(name);
    await database.delete();
  }
});

describe('E5 layout engine and persistence', () => {
  it('snaps deterministically to integer grid units', () => {
    expect(snap(1.49)).toBe(1);
    expect(snap(1.5)).toBe(2);
    expect(snap(7.8, 2)).toBe(8);
  });

  it('rejects overlap by returning the previous valid layout', () => {
    const initial = defaultLayout('PHONE_PORTRAIT');
    const moved = moveItem(initial, 'TOTAL', 0, 4);

    expect(moved).toEqual(initial);
    expect(validateLayout(moved)).toEqual([]);
  });

  it('rejects out-of-bounds movement', () => {
    const initial = defaultLayout('PHONE_PORTRAIT');
    expect(moveItem(initial, 'TOTAL', -1, 0)).toEqual(initial);
    expect(moveItem(initial, 'LAST_ACTION', 0, 16)).toEqual(initial);
  });

  it('enforces minimum sizes and never saves a smaller interactive block', () => {
    const initial = defaultLayout('PHONE_PORTRAIT');
    const resized = resizeItem(initial, 'TOTAL', 1, 1);

    const total = resized.items.find((item) => item.id === 'TOTAL')!;
    expect(total.w).toBeGreaterThanOrEqual(total.minW);
    expect(total.h).toBeGreaterThanOrEqual(total.minH);
    expect(validateLayout(resized)).toEqual([]);
  });

  it('keeps locked pallet area immovable and unresizable', () => {
    const initial = defaultLayout('PHONE_PORTRAIT');

    expect(moveItem(initial, 'PALLETS', 0, 0)).toEqual(initial);
    expect(resizeItem(initial, 'PALLETS', 5, 5)).toEqual(initial);
  });

  it('persists a valid layout across database reopen', async () => {
    const name = 'e5-persist';
    let database = db(name);

    const initial = defaultLayout('PHONE_PORTRAIT');
    const changed = moveItem(initial, 'TOTAL', 0, 15);
    // This move cannot fit; use a legal swap-free resize instead.
    const valid = resizeItem(initial, 'TOTAL', 10, 2);

    expect(changed).toEqual(initial);
    await saveLayout(database, valid);
    await database.close();

    database = new UphoffLocalDb(name);
    const restored = await loadLayout(database, 'PHONE_PORTRAIT');
    expect(restored).toEqual(valid);
    await database.close();
  });

  it('keeps phone and iPad profiles separate', async () => {
    const database = db('e5-profiles');

    const phone = resizeItem(defaultLayout('PHONE_PORTRAIT'), 'TOTAL', 10, 2);
    const ipad = resizeItem(defaultLayout('IPAD_PORTRAIT'), 'TOTAL', 9, 3);

    await saveLayout(database, phone);
    await saveLayout(database, ipad);

    expect(await loadLayout(database, 'PHONE_PORTRAIT')).toEqual(phone);
    expect(await loadLayout(database, 'IPAD_PORTRAIT')).toEqual(ipad);
    await database.close();
  });

  it('falls back to default for corrupt or invalid stored JSON', async () => {
    const database = db('e5-corrupt');

    await database.meta.put({
      key: 'layout:PHONE_PORTRAIT:v1',
      value: '{"broken":true}',
    });

    expect(await loadLayout(database, 'PHONE_PORTRAIT')).toEqual(
      defaultLayout('PHONE_PORTRAIT'),
    );
    await database.close();
  });

  it('restore default overwrites only the selected profile', async () => {
    const database = db('e5-reset');

    const phoneChanged = resizeItem(
      defaultLayout('PHONE_PORTRAIT'),
      'TOTAL',
      10,
      2,
    );
    const ipadChanged = resizeItem(
      defaultLayout('IPAD_PORTRAIT'),
      'TOTAL',
      9,
      3,
    );

    await saveLayout(database, phoneChanged);
    await saveLayout(database, ipadChanged);
    await restoreDefaultLayout(database, 'PHONE_PORTRAIT');

    expect(await loadLayout(database, 'PHONE_PORTRAIT')).toEqual(
      defaultLayout('PHONE_PORTRAIT'),
    );
    expect(await loadLayout(database, 'IPAD_PORTRAIT')).toEqual(ipadChanged);
    await database.close();
  });

  it('refuses to save invalid overlapping layouts', async () => {
    const database = db('e5-invalid-save');
    const invalid = defaultLayout('PHONE_PORTRAIT');
    invalid.items.find((item) => item.id === 'TOTAL')!.y = 4;

    await expect(saveLayout(database, invalid)).rejects.toThrow('invalid-layout');
    expect(await database.meta.count()).toBe(0);
    await database.close();
  });
});
