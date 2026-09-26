import type { OperationAssessment, PalletEvent, Projection, StoredEvent, SyncState } from './types';

const syncRank: Record<SyncState, number> = {
  REJECTED: 0,
  LOCAL_ONLY: 1,
  PENDING: 2,
  CONFIRMED: 3,
};

function immutableSignature(event: PalletEvent): string {
  return JSON.stringify({
    id: event.id,
    geraetId: event.geraetId,
    person: event.person ?? null,
    sorte: event.sorte,
    art: event.art,
    delta: event.delta,
    buchungszeit: event.buchungszeit,
    konfigVersion: event.konfigVersion,
    vorgangId: event.vorgangId ?? null,
    korrigiertId: event.korrigiertId ?? null,
    umbuchungId: event.umbuchungId ?? null,
    umbuchungPartnerId: event.umbuchungPartnerId ?? null,
  });
}

function reconcileById(events: readonly StoredEvent[]): {
  events: StoredEvent[];
  anomalies: string[];
} {
  const groups = new Map<string, StoredEvent[]>();

  for (const event of events) {
    const group = groups.get(event.id);
    if (group) group.push(event);
    else groups.set(event.id, [event]);
  }

  const reconciled: StoredEvent[] = [];
  const anomalies: string[] = [];

  for (const [id, group] of groups) {
    const signatures = new Set(group.map(immutableSignature));

    if (signatures.size > 1) {
      anomalies.push(`${id}:id-content-conflict`);
      continue;
    }

    const chosen = [...group].sort(
      (a, b) => syncRank[b.syncState] - syncRank[a.syncState],
    )[0];

    if (chosen) reconciled.push(chosen);
  }

  return { events: reconciled, anomalies };
}

function validCorrection(
  correction: StoredEvent,
  byId: ReadonlyMap<string, StoredEvent>,
): { valid: boolean; original?: StoredEvent; reason?: string } {
  if (correction.art !== 'KORREKTUR') return { valid: false, reason: 'not-correction' };
  if (!correction.korrigiertId) return { valid: false, reason: 'missing-korrigiertId' };

  const original = byId.get(correction.korrigiertId);
  if (!original) return { valid: false, reason: 'orphan-correction' };
  if (original.art === 'KORREKTUR') return { valid: false, original, reason: 'correction-of-correction' };
  if (original.art === 'UMBUCHUNG') return { valid: false, original, reason: 'correction-of-transfer' };
  if (correction.id !== correctionId(original.id)) {
    return { valid: false, original, reason: 'non-deterministic-correction-id' };
  }
  if (correction.konfigVersion !== original.konfigVersion) {
    return { valid: false, original, reason: 'wrong-correction-config' };
  }
  if (correction.delta !== -original.delta) {
    return { valid: false, original, reason: 'wrong-correction-delta' };
  }
  if (correction.sorte !== original.sorte) {
    return { valid: false, original, reason: 'wrong-correction-sorte' };
  }
  return { valid: true, original };
}

export function project(events: readonly StoredEvent[]): Projection {
  const reconciled = reconcileById(events);
  const deduped = reconciled.events.filter((event) => event.syncState !== 'REJECTED');
  const byId = new Map(deduped.map((event) => [event.id, event] as const));

  const bestandJeSorte: Record<string, number> = {};
  const anomalies = [...reconciled.anomalies];

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
