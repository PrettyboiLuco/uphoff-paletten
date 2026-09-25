export interface PalletTypeConfig {
  id: string;
  name: string;
  stackSize: 15 | 17;
}

export const PALLET_CONFIG_VERSION = 'v1';

// Deliberate production release lock. The names are supplied, but the stack
// sizes below are development examples until Luc confirms the real values.
export const PALLET_CONFIG_APPROVED = false;
export const PALLET_STACK_SIZES_APPROVED = false;

export const PALLET_TYPES: readonly PalletTypeConfig[] = [
  { id: 'typ-1', name: 'Europaletten', stackSize: 15 },
  { id: 'typ-2', name: 'Euroersatzpaletten', stackSize: 15 },
  { id: 'typ-3', name: 'CP', stackSize: 15 },
  { id: 'typ-4', name: 'Einweg', stackSize: 15 },
  { id: 'typ-5', name: 'Schachtelt', stackSize: 17 },
  { id: 'typ-6', name: 'Nutra', stackSize: 17 },
  { id: 'typ-7', name: '1200x1000', stackSize: 17 },
] as const;

export const PALLET_CONFIG_READY = (
  PALLET_CONFIG_APPROVED
  && PALLET_STACK_SIZES_APPROVED
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
