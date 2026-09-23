import type { OperationAssessment, PalletEvent, Projection } from './types';

function uniqueById(events: readonly PalletEvent[]): PalletEvent[] {
  const map = new Map<string, PalletEvent>();
  for (const event of events) {
    if (!map.has(event.id)) map.set(event.id, event);
  }
  return [...map.values()];
}

function validCorrection(
  correction: PalletEvent,
  byId: ReadonlyMap<string, PalletEvent>,
): { valid: boolean; original?: PalletEvent; reason?: string } {
  if (correction.art !== 'KORREKTUR') return { valid: false, reason: 'not-correction' };
  if (!correction.korrigiertId) return { valid: false, reason: 'missing-korrigiertId' };

  const original = byId.get(correction.korrigiertId);
  if (!original) return { valid: false, reason: 'orphan-correction' };
  if (original.art === 'KORREKTUR') return { valid: false, original, reason: 'correction-of-correction' };
  if (correction.delta !== -original.delta) {
    return { valid: false, original, reason: 'wrong-correction-delta' };
  }
  if (correction.sorte !== original.sorte) {
    return { valid: false, original, reason: 'wrong-correction-sorte' };
  }
  return { valid: true, original };
}

export function project(events: readonly PalletEvent[]): Projection {
  const deduped = uniqueById(events).filter((event) => event.syncState !== 'REJECTED');
  const byId = new Map(deduped.map((event) => [event.id, event] as const));

  const bestandJeSorte: Record<string, number> = {};
  const anomalies: string[] = [];

  let bestandGesamt = 0;
  let dazugekommen = 0;
  let weggekommen = 0;
  let inventurdifferenz = 0;

  for (const event of deduped) {
    if (event.art === 'KORREKTUR') {
      const check = validCorrection(event, byId);
      if (!check.valid || !check.original) {
        anomalies.push(`${event.id}:${check.reason ?? 'invalid-correction'}`);
        continue;
      }

      bestandGesamt += event.delta;
      bestandJeSorte[event.sorte] = (bestandJeSorte[event.sorte] ?? 0) + event.delta;

      if (check.original.art === 'ZUGANG') {
        dazugekommen += event.delta;
      } else if (check.original.art === 'ABGANG') {
        weggekommen -= event.delta;
      }
      continue;
    }

    bestandGesamt += event.delta;
    bestandJeSorte[event.sorte] = (bestandJeSorte[event.sorte] ?? 0) + event.delta;

    if (event.art === 'ZUGANG') {
      dazugekommen += event.delta;
    } else if (event.art === 'ABGANG') {
      weggekommen -= event.delta;
    } else if (event.art === 'INVENTUR') {
      inventurdifferenz += event.delta;
    }
  }

  return {
    bestandGesamt,
    bestandJeSorte,
    dazugekommen,
    weggekommen,
    inventurdifferenz,
    anomalies,
  };
}

export function assessOperation(
  mode: 'EINGANG' | 'AUSGANG',
  deltas: readonly number[],
): OperationAssessment {
  const netDelta = deltas.reduce((sum, delta) => sum + delta, 0);
  if (netDelta === 0) return { netDelta, warning: 'ZERO_NET' };

  const wrongSign =
    (mode === 'EINGANG' && netDelta < 0) ||
    (mode === 'AUSGANG' && netDelta > 0);

  return { netDelta, warning: wrongSign ? 'WRONG_SIGN' : 'NONE' };
}

export function correctionId(originalId: string): string {
  return `korr_${originalId}`;
}
