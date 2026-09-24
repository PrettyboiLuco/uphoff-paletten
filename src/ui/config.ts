export interface PalletTypeConfig {
  id: string;
  name: string;
  stackSize: 15 | 17;
}

export const PALLET_CONFIG_VERSION = 'v1';

// Deliberate production release lock. Set to true only after Luc has supplied
// and approved all seven real names and fixed stack sizes.
export const PALLET_CONFIG_APPROVED = false;

export const PALLET_TYPES: readonly PalletTypeConfig[] = [
  { id: 'typ-1', name: 'Sorte 1', stackSize: 15 },
  { id: 'typ-2', name: 'Sorte 2', stackSize: 15 },
  { id: 'typ-3', name: 'Sorte 3', stackSize: 15 },
  { id: 'typ-4', name: 'Sorte 4', stackSize: 15 },
  { id: 'typ-5', name: 'Sorte 5', stackSize: 17 },
  { id: 'typ-6', name: 'Sorte 6', stackSize: 17 },
  { id: 'typ-7', name: 'Sorte 7', stackSize: 17 },
] as const;

export const PALLET_CONFIG_READY = (
  PALLET_CONFIG_APPROVED
  && PALLET_TYPES.length === 7
  && PALLET_TYPES.every(
    (type) =>
      type.name.trim().length > 0
      && !/^Sorte\s+\d+$/i.test(type.name.trim()),
  )
);

export const PALLET_CONFIG_SIGNATURE = JSON.stringify({
  version: PALLET_CONFIG_VERSION,
  stackSizes: Object.fromEntries(
    PALLET_TYPES.map((type) => [type.id, type.stackSize]),
  ),
});
