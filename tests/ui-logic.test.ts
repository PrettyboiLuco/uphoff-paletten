import { describe, expect, it } from 'vitest';
import { effectForTap, syncLabel } from '../src/ui/logic';

describe('E4 UI logic', () => {
  it('shows correct inventory effect for every count action', () => {
    expect(effectForTap('EINGANG', 'STACK', 15)).toBe(15);
    expect(effectForTap('EINGANG', 'PLUS_ONE', 15)).toBe(1);
    expect(effectForTap('EINGANG', 'MINUS_ONE', 15)).toBe(-1);

    expect(effectForTap('AUSGANG', 'STACK', 17)).toBe(-17);
    expect(effectForTap('AUSGANG', 'PLUS_ONE', 17)).toBe(1);
    expect(effectForTap('AUSGANG', 'MINUS_ONE', 17)).toBe(-1);
  });

  it('never calls pending or rejected state synchronized', () => {
    expect(syncLabel('SYNCHRON', 0)).toBe('Synchron');
    expect(syncLabel('PENDING', 3)).toBe('3 ausstehend');
    expect(syncLabel('REJECTED', 0)).toBe('Prüfung nötig');
    expect(syncLabel('NEVER_SYNCED', 0)).toBe('Noch nicht synchronisiert');
  });
});
