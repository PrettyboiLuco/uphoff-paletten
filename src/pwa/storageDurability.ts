export interface StorageDurabilityStatus {
  supported: boolean;
  persisted: boolean | null;
  quota?: number;
  usage?: number;
}

export async function requestDurableStorage(): Promise<StorageDurabilityStatus> {
  const storage = navigator.storage;
  if (!storage) {
    return { supported: false, persisted: null };
  }

  let persisted: boolean | null = null;

  try {
    if (storage.persisted) persisted = await storage.persisted();
    if (!persisted && storage.persist) persisted = await storage.persist();
  } catch {
    persisted = null;
  }

  try {
    const estimate = await storage.estimate();
    return {
      supported: true,
      persisted,
      ...(typeof estimate.quota === 'number' ? { quota: estimate.quota } : {}),
      ...(typeof estimate.usage === 'number' ? { usage: estimate.usage } : {}),
    };
  } catch {
    return {
      supported: true,
      persisted,
    };
  }
}
