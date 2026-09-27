import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assessActivationReadiness } from './stock-floor-preflight.mjs';

const projectId = process.argv[2];
const mode = process.argv[3];
if (projectId !== 'uphoff-paletten' || !['--dry-run', '--activate'].includes(mode)) {
  throw new Error('Usage: node scripts/activate-stock-floor.mjs uphoff-paletten --dry-run|--activate');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const sorts = ['typ-1', 'typ-2', 'typ-3', 'typ-4', 'typ-5', 'typ-6', 'typ-7'];
const controlRef = db.doc('system/stockControl');
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const revision = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
const expectedVersion = `${packageVersion}+${revision}`;

// Run only after the matching rules have been deployed: until this transaction
// activates stockControl, those rules deny every new event creation.
const result = await db.runTransaction(async (transaction) => {
  const events = await transaction.get(db.collection('events'));
  const devices = await transaction.get(db.collection('devices'));
  const control = await transaction.get(controlRef);
  const refs = sorts.map((sort) => db.doc(`stocks/${sort}`));
  const stockDocs = await Promise.all(refs.map((ref) => transaction.get(ref)));
  const activeDevices = devices.docs.filter((device) => device.data().enabled === true).map((device) => device.id);
  const heartbeatDocs = await Promise.all(activeDevices.map((uid) => transaction.get(db.doc(`heartbeats/${uid}`))));
  const heartbeats = Object.fromEntries(heartbeatDocs.map((snapshot, index) => [
    activeDevices[index], snapshot.exists ? snapshot.data() : null,
  ]));
  const totals = Object.fromEntries(sorts.map((sort) => [sort, 0]));
  const checkCode = {};

  for (const event of events.docs) {
    const { sorte, delta } = event.data();
    if (!Object.hasOwn(totals, sorte) || !Number.isSafeInteger(delta)) {
      throw new Error(`Unknown sort or invalid delta in event ${event.id}`);
    }
    totals[sorte] += delta;
    const entry = checkCode[sorte] ?? { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += delta;
    checkCode[sorte] = entry;
  }
  for (const [sort, count] of Object.entries(totals)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Existing stock for ${sort} is ${count}; resolve this before activation`);
    }
  }

  if (control.exists && control.data().phase === 'ACTIVE') {
    for (let index = 0; index < sorts.length; index += 1) {
      if (stockDocs[index].data()?.count !== totals[sorts[index]]) {
        throw new Error(`Stock ledger mismatch for ${sorts[index]}; no data was changed`);
      }
    }
    return { status: 'already active', eventCount: events.size, totals };
  }

  const readiness = assessActivationReadiness({
    eventCount: events.size,
    checkCode: Object.fromEntries(Object.entries(checkCode).sort(([a], [b]) => a.localeCompare(b))),
    devices: activeDevices,
    heartbeats,
    expectedVersion,
    nowMs: Date.now(),
  });

  if (mode === '--dry-run') {
    return { status: 'dry run; no data changed', eventCount: events.size, totals, expectedVersion, readiness };
  }
  if (readiness.length > 0) {
    throw new Error(`Aktivierung gesperrt: ${readiness.join('; ')}`);
  }

  for (let index = 0; index < sorts.length; index += 1) {
    transaction.set(refs[index], {
      count: totals[sorts[index]],
      lastEventId: 'bootstrap',
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  transaction.set(controlRef, {
    phase: 'ACTIVE',
    eventCountAtActivation: events.size,
    activatedAt: FieldValue.serverTimestamp(),
  });
  return { status: 'activated', eventCount: events.size, totals };
});

console.log(JSON.stringify(result, null, 2));
