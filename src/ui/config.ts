export interface PalletTypeConfig {
  id: string;
  name: string;
  stackSize: number;
  /** Optional public photo; falls back to the bundled pallet illustration. */
  imageUrl?: string;
}

// Replace this file with your own logo when artwork is available.
export const BRAND_IMAGE_URL = '/images/uphoff-mark.svg';
export const PALLET_FALLBACK_IMAGE_URL = '/images/pallet.svg';

export const PALLET_CONFIG_VERSION = 'v1';

// All seven sizes are confirmed. Production still requires a matching server
// config and an explicitly approved device before bookings can be made.
export const PALLET_CONFIG_APPROVED = true;
export const PALLET_STACK_SIZES_APPROVED = true;

export const PALLET_TYPES: readonly PalletTypeConfig[] = [
  { id: 'typ-1', name: 'Europaletten', stackSize: 15 },
  { id: 'typ-2', name: 'Euroersatzpaletten', stackSize: 15 },
  { id: 'typ-3', name: 'CP', stackSize: 15 },
  { id: 'typ-4', name: 'Einweg', stackSize: 18 },
  { id: 'typ-5', name: 'Schachtelt', stackSize: 25 },
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
