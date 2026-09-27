export type CountMode = 'EINGANG' | 'AUSGANG';

export function effectForTap(
  mode: CountMode,
  action: 'STACK' | 'PLUS_ONE' | 'MINUS_ONE',
  stackSize: number,
): number {
  if (mode === 'EINGANG') {
    if (action === 'STACK') return stackSize;
    if (action === 'PLUS_ONE') return 1;
    return -1;
  }

  if (action === 'STACK') return -stackSize;
  if (action === 'PLUS_ONE') return 1;
  return -1;
}

export function modeLabel(mode: CountMode): string {
  return mode === 'EINGANG' ? 'EINGANG' : 'AUSGANG';
}

export function syncLabel(
  state:
    | 'SYNCHRON'
    | 'PENDING'
    | 'REJECTED'
    | 'NEVER_SYNCED'
    | 'STALE',
  pendingCount: number,
): string {
  if (state === 'SYNCHRON') return 'Synchron';
  if (state === 'PENDING') return `${pendingCount} ausstehend`;
  if (state === 'REJECTED') return 'Prüfung nötig';
  if (state === 'STALE') return 'Abgleich veraltet';
  return 'Noch nicht synchronisiert';
}
