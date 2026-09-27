export type LayoutProfile = 'PHONE_PORTRAIT' | 'IPAD_PORTRAIT';

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutItem extends LayoutRect {
  id: 'TOTAL' | 'MODE' | 'PALLETS' | 'LAST_ACTION';
  locked: boolean;
  minW: number;
  minH: number;
}

export interface LayoutDocument {
  version: 1;
  profile: LayoutProfile;
  cols: 12;
  rows: 16;
  items: LayoutItem[];
}

const PHONE_DEFAULT: LayoutDocument = {
  version: 1,
  profile: 'PHONE_PORTRAIT',
  cols: 12,
  rows: 16,
  items: [
    { id: 'TOTAL', x: 0, y: 0, w: 12, h: 2, locked: false, minW: 6, minH: 2 },
    { id: 'MODE', x: 0, y: 2, w: 12, h: 2, locked: false, minW: 6, minH: 2 },
    { id: 'PALLETS', x: 0, y: 4, w: 12, h: 9, locked: true, minW: 12, minH: 9 },
    { id: 'LAST_ACTION', x: 0, y: 13, w: 12, h: 2, locked: false, minW: 6, minH: 2 },
  ],
};

const IPAD_DEFAULT: LayoutDocument = {
  version: 1,
  profile: 'IPAD_PORTRAIT',
  cols: 12,
  rows: 16,
  items: [
    { id: 'TOTAL', x: 0, y: 0, w: 12, h: 3, locked: false, minW: 5, minH: 2 },
    { id: 'MODE', x: 0, y: 3, w: 12, h: 2, locked: false, minW: 5, minH: 2 },
    { id: 'PALLETS', x: 0, y: 5, w: 12, h: 8, locked: true, minW: 12, minH: 8 },
    { id: 'LAST_ACTION', x: 0, y: 13, w: 12, h: 2, locked: false, minW: 5, minH: 2 },
  ],
};

export function defaultLayout(profile: LayoutProfile): LayoutDocument {
  return structuredClone(profile === 'PHONE_PORTRAIT' ? PHONE_DEFAULT : IPAD_DEFAULT);
}

export function profileForViewport(width: number): LayoutProfile {
  return width >= 700 ? 'IPAD_PORTRAIT' : 'PHONE_PORTRAIT';
}

export function snap(value: number, step = 1): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / step) * step;
}

export function overlaps(a: LayoutRect, b: LayoutRect): boolean {
  return (
    a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y
  );
}

export function validateLayout(layout: LayoutDocument): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const item of layout.items) {
    if (ids.has(item.id)) errors.push(`duplicate:${item.id}`);
    ids.add(item.id);

    if (
      !Number.isInteger(item.x)
      || !Number.isInteger(item.y)
      || !Number.isInteger(item.w)
      || !Number.isInteger(item.h)
    ) {
      errors.push(`not-snapped:${item.id}`);
    }

    if (item.w < item.minW || item.h < item.minH) {
      errors.push(`below-minimum:${item.id}`);
    }

    if (
      item.x < 0
      || item.y < 0
      || item.x + item.w > layout.cols
      || item.y + item.h > layout.rows
    ) {
      errors.push(`out-of-bounds:${item.id}`);
    }
  }

  for (let i = 0; i < layout.items.length; i += 1) {
    for (let j = i + 1; j < layout.items.length; j += 1) {
      const a = layout.items[i]!;
      const b = layout.items[j]!;
      if (overlaps(a, b)) errors.push(`overlap:${a.id}:${b.id}`);
    }
  }

  return errors;
}

function mutateItem(
  layout: LayoutDocument,
  itemId: LayoutItem['id'],
  nextRect: LayoutRect,
): LayoutDocument {
  const item = layout.items.find((candidate) => candidate.id === itemId);
  if (!item || item.locked) return structuredClone(layout);

  const candidate = structuredClone(layout);
  const target = candidate.items.find((entry) => entry.id === itemId)!;

  target.x = snap(nextRect.x);
  target.y = snap(nextRect.y);
  target.w = Math.max(target.minW, snap(nextRect.w));
  target.h = Math.max(target.minH, snap(nextRect.h));

  return validateLayout(candidate).length === 0 ? candidate : structuredClone(layout);
}

export function moveItem(
  layout: LayoutDocument,
  itemId: LayoutItem['id'],
  x: number,
  y: number,
): LayoutDocument {
  const item = layout.items.find((candidate) => candidate.id === itemId);
  if (!item) return structuredClone(layout);
  return mutateItem(layout, itemId, { x, y, w: item.w, h: item.h });
}

export function resizeItem(
  layout: LayoutDocument,
  itemId: LayoutItem['id'],
  w: number,
  h: number,
): LayoutDocument {
  const item = layout.items.find((candidate) => candidate.id === itemId);
  if (!item) return structuredClone(layout);
  return mutateItem(layout, itemId, { x: item.x, y: item.y, w, h });
}
