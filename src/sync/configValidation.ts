import {
  doc,
  getDoc,
  type Firestore,
} from 'firebase/firestore';
import {
  PALLET_CONFIG_SIGNATURE,
  PALLET_CONFIG_VERSION,
  PALLET_TYPES,
} from '../ui/config';

export type ServerConfigValidationStatus =
  | 'MATCH'
  | 'MISSING'
  | 'MISMATCH'
  | 'UNAVAILABLE';

export interface ServerConfigValidation {
  status: ServerConfigValidationStatus;
  signature: string;
  reason?: string;
}

const CONFIG_TIMEOUT_MS = 8_000;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = globalThis.setTimeout(() => {
          reject(new Error('config-read-timeout'));
        }, CONFIG_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

function expectedStackMap(): Record<string, number> {
  return Object.fromEntries(
    PALLET_TYPES.map((type) => [type.id, type.stackSize]),
  );
}

function sameStackMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const actual = value as Record<string, unknown>;
  const expected = expectedStackMap();
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();

  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    return false;
  }

  return expectedKeys.every((key) => actual[key] === expected[key]);
}

export async function validateServerPalletConfig(
  db: Firestore,
): Promise<ServerConfigValidation> {
  try {
    const snapshot = await withTimeout(
      getDoc(doc(db, 'configs', PALLET_CONFIG_VERSION)),
    );

    if (!snapshot.exists()) {
      return {
        status: 'MISSING',
        signature: PALLET_CONFIG_SIGNATURE,
        reason: 'config-document-missing',
      };
    }

    if (!sameStackMap(snapshot.data().stapel)) {
      return {
        status: 'MISMATCH',
        signature: PALLET_CONFIG_SIGNATURE,
        reason: 'stack-map-mismatch',
      };
    }

    return {
      status: 'MATCH',
      signature: PALLET_CONFIG_SIGNATURE,
    };
  } catch (error) {
    return {
      status: 'UNAVAILABLE',
      signature: PALLET_CONFIG_SIGNATURE,
      reason: error instanceof Error ? error.message : 'config-read-failed',
    };
  }
}
