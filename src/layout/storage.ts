import type { UphoffLocalDb } from '../persistence/localDb';
import {
  defaultLayout,
  validateLayout,
  type LayoutDocument,
  type LayoutProfile,
} from './layout';

function key(profile: LayoutProfile): string {
  return `layout:${profile}:v1`;
}

export async function loadLayout(
  db: UphoffLocalDb,
  profile: LayoutProfile,
): Promise<LayoutDocument> {
  const stored = await db.meta.get(key(profile));
  if (!stored) return defaultLayout(profile);

  try {
    const parsed = JSON.parse(stored.value) as LayoutDocument;
    if (
      parsed.version !== 1
      || parsed.profile !== profile
      || parsed.cols !== 12
      || parsed.rows !== 16
      || validateLayout(parsed).length > 0
    ) {
      return defaultLayout(profile);
    }

    return parsed;
  } catch {
    return defaultLayout(profile);
  }
}

export async function saveLayout(
  db: UphoffLocalDb,
  layout: LayoutDocument,
): Promise<void> {
  const errors = validateLayout(layout);
  if (errors.length > 0) {
    throw new Error(`invalid-layout:${errors.join(',')}`);
  }

  await db.meta.put({
    key: key(layout.profile),
    value: JSON.stringify(layout),
  });
}

export async function restoreDefaultLayout(
  db: UphoffLocalDb,
  profile: LayoutProfile,
): Promise<LayoutDocument> {
  const layout = defaultLayout(profile);
  await saveLayout(db, layout);
  return layout;
}
