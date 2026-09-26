import { describe, expect, it } from 'vitest';
import { assessOperation, correctionId, project } from '../src/domain/projection';
import type { EventArt, StoredEvent } from '../src/domain/types';

let seq = 0;

function event(
  art: EventArt,
  delta: number,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  seq += 1;
  const id = overrides.id ?? `e-${seq}`;
  return {
    id,
    geraetId: 'test-device',
    sorte: 'EURO',
    art,
    delta,
    buchungszeit: '2026-09-23T10:00:00+02:00',
    konfigVersion: 'v1',
    syncState: 'CONFIRMED',
    createdLocalAt: '2026-09-23T10:00:00+02:00',
    ...overrides,
  };
}

describe('E1 domain correctness', () => {
  it('E1a: Eingang 15 - 2 ergibt Zugang 13 und Abgang 0', () => {
    const events = [
      event('ZUGANG', 15),
      event('ZUGANG', -1),
      event('ZUGANG', -1),
    ];
    const p = project(events);
    expect(p.dazugekommen).toBe(13);
    expect(p.weggekommen).toBe(0);
    expect(p.bestandGesamt).toBe(13);
  });

  it('E1a: Ausgang 15 - 2 ergibt Abgang 13 und Zugang 0', () => {
    const events = [
      event('ABGANG', -15),
      event('ABGANG', 1),
      event('ABGANG', 1),
    ];
    const p = project(events);
    expect(p.weggekommen).toBe(13);
    expect(p.dazugekommen).toBe(0);
    expect(p.bestandGesamt).toBe(-13);
  });

  it('E1b: Vorgangs-Rückgängig neutralisiert alle Events des Vorgangs', () => {
    const originals = [
      event('ZUGANG', 15, { id: 'stack', vorgangId: 'v1' }),
      event('ZUGANG', -1, { id: 'adj1', vorgangId: 'v1' }),
      event('ZUGANG', -1, { id: 'adj2', vorgangId: 'v1' }),
    ];
    const corrections = originals.map((original) =>
      event('KORREKTUR', -original.delta, {
        id: correctionId(original.id),
        korrigiertId: original.id,
        vorgangId: 'undo-v1',
      }),
    );

    const p = project([...originals, ...corrections]);
    expect(p.bestandGesamt).toBe(0);
    expect(p.dazugekommen).toBe(0);
    expect(p.weggekommen).toBe(0);
    expect(p.anomalies).toEqual([]);
  });

  it('E1c: Storno eines Abgangs senkt weggekommen im Zeitraum des Originals', () => {
    const original = event('ABGANG', -15, { id: 'out-1' });
    const correction = event('KORREKTUR', 15, {
      id: correctionId(original.id),
      korrigiertId: original.id,
    });

    const p = project([original, correction]);
    expect(p.weggekommen).toBe(0);
    expect(p.bestandGesamt).toBe(0);
  });

  it('E1d: Anfangsbestand, Umbuchung und Inventur zählen nicht als Zugang/Abgang', () => {
    const events = [
      event('ANFANGSBESTAND', 100, { sorte: 'EURO' }),
      event('UMBUCHUNG', -10, { sorte: 'EURO', umbuchungId: 'u1' }),
      event('UMBUCHUNG', 10, { sorte: 'EINWEG', umbuchungId: 'u1' }),
      event('INVENTUR', -3, { sorte: 'EURO' }),
    ];

    const p = project(events);
    expect(p.dazugekommen).toBe(0);
    expect(p.weggekommen).toBe(0);
    expect(p.inventurdifferenz).toBe(-3);
    expect(p.bestandGesamt).toBe(97);
  });

  it('E1e: warnt bei netto 0 und falschem Vorzeichen', () => {
    expect(assessOperation('EINGANG', [15, -15]).warning).toBe('ZERO_NET');
    expect(assessOperation('EINGANG', [-1]).warning).toBe('WRONG_SIGN');
    expect(assessOperation('AUSGANG', [1]).warning).toBe('WRONG_SIGN');
    expect(assessOperation('EINGANG', [15, -1, -1]).warning).toBe('NONE');
    expect(assessOperation('AUSGANG', [-15, 1, 1]).warning).toBe('NONE');
  });

  it('quarantines an orphan correction until its original exists', () => {
    const correction = event('KORREKTUR', 15, {
      id: 'korr_missing',
      korrigiertId: 'missing',
    });

    const p = project([correction]);
    expect(p.bestandGesamt).toBe(0);
    expect(p.anomalies).toEqual(['korr_missing:orphan-correction']);
  });

  it('quarantines corrections that violate deterministic id, config, or transfer rules', () => {
    const original = event('ZUGANG', 15, {
      id: 'strict-original',
      konfigVersion: 'v1',
    });
    const wrongId = event('KORREKTUR', -15, {
      id: 'manual-correction-id',
      korrigiertId: original.id,
      konfigVersion: 'v1',
    });
    const wrongConfig = event('KORREKTUR', -15, {
      id: correctionId(original.id),
      korrigiertId: original.id,
      konfigVersion: 'v2',
    });
    const transfer = event('UMBUCHUNG', -10, {
      id: 'transfer-original',
      sorte: 'EURO',
      umbuchungId: 'u1',
      umbuchungPartnerId: 'transfer-partner',
    });
    const transferCorrection = event('KORREKTUR', 10, {
      id: correctionId(transfer.id),
      korrigiertId: transfer.id,
      sorte: 'EURO',
    });

    const wrongIdProjection = project([original, wrongId]);
    expect(wrongIdProjection.bestandGesamt).toBe(15);
    expect(wrongIdProjection.anomalies).toContain(
      'manual-correction-id:non-deterministic-correction-id',
    );

    const wrongConfigProjection = project([original, wrongConfig]);
    expect(wrongConfigProjection.bestandGesamt).toBe(15);
    expect(wrongConfigProjection.anomalies).toContain(
      'korr_strict-original:wrong-correction-config',
    );

    const transferProjection = project([transfer, transferCorrection]);
    expect(transferProjection.bestandGesamt).toBe(-10);
    expect(transferProjection.anomalies).toContain(
      'korr_transfer-original:correction-of-transfer',
    );
  });


  it('quarantines same-id events whose immutable content conflicts', () => {
    const a = event('ZUGANG', 15, { id: 'same-id' });
    const b = event('ZUGANG', 17, { id: 'same-id' });

    const p = project([a, b]);
    expect(p.bestandGesamt).toBe(0);
    expect(p.anomalies).toEqual(['same-id:id-content-conflict']);
  });

  it('accepts an exact same-id retry once and prefers its confirmed sync state', () => {
    const pending = event('ZUGANG', 15, { id: 'retry', syncState: 'PENDING' });
    const confirmed = { ...pending, syncState: 'CONFIRMED' as const };

    const p = project([pending, confirmed]);
    expect(p.bestandGesamt).toBe(15);
    expect(p.anomalies).toEqual([]);
  });

  it('E1f: 10,000 randomized events remain exact under duplicates and arbitrary order', () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    const base: StoredEvent[] = [];
    const expectedBySort: Record<string, number> = {};
    let expectedTotal = 0;
    let expectedZugang = 0;
    let expectedAbgang = 0;
    let expectedInventur = 0;
    const sorts = ['EURO', 'EINWEG', 'CHEMIE', 'DUESSELDORF'];

    for (let i = 0; i < 10_000; i += 1) {
      const sorte = sorts[Math.floor(random() * sorts.length)] ?? 'EURO';
      const pick = Math.floor(random() * 5);
      const art: Exclude<EventArt, 'KORREKTUR'> =
        pick === 0
          ? 'ZUGANG'
          : pick === 1
            ? 'ABGANG'
            : pick === 2
              ? 'ANFANGSBESTAND'
              : pick === 3
                ? 'INVENTUR'
                : 'UMBUCHUNG';

      let delta: number;
      if (art === 'ZUGANG') delta = random() < 0.8 ? 15 : -1;
      else if (art === 'ABGANG') delta = random() < 0.8 ? -15 : 1;
      else if (art === 'INVENTUR') delta = Math.floor(random() * 11) - 5;
      else if (art === 'UMBUCHUNG') delta = random() < 0.5 ? -1 : 1;
      else delta = Math.floor(random() * 50);

      const e = event(art, delta, { id: `fuzz-${i}`, sorte });
      base.push(e);
      expectedTotal += delta;
      expectedBySort[sorte] = (expectedBySort[sorte] ?? 0) + delta;
      if (art === 'ZUGANG') expectedZugang += delta;
      if (art === 'ABGANG') expectedAbgang -= delta;
      if (art === 'INVENTUR') expectedInventur += delta;
    }

    const noisy: StoredEvent[] = [];
    for (const e of base) {
      noisy.push(e);
      if (random() < 0.35) noisy.push({ ...e });
      if (random() < 0.1) noisy.push({ ...e });
    }

    for (let i = noisy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const tmp = noisy[i]!;
      noisy[i] = noisy[j]!;
      noisy[j] = tmp;
    }

    const p = project(noisy);
    expect(p.bestandGesamt).toBe(expectedTotal);
    expect(p.bestandJeSorte).toEqual(expectedBySort);
    expect(p.dazugekommen).toBe(expectedZugang);
    expect(p.weggekommen).toBe(expectedAbgang);
    expect(p.inventurdifferenz).toBe(expectedInventur);
    expect(p.anomalies).toEqual([]);
  });
});
