export function assessActivationReadiness({ eventCount, checkCode, devices, heartbeats, expectedVersion, nowMs }) {
  const issues = [];
  const expected = JSON.stringify(checkCode);
  if (devices.length === 0) issues.push('Kein freigegebenes Gerät vorhanden');

  for (const device of devices) {
    const heartbeat = heartbeats[device];
    if (!heartbeat) {
      issues.push(`${device}: kein Heartbeat vorhanden`);
      continue;
    }
    const seenMs = heartbeat.lastSeen?.toMillis?.();
    if (!Number.isFinite(seenMs) || nowMs - seenMs < 0 || nowMs - seenMs > 5 * 60_000) {
      issues.push(`${device}: letzter Heartbeat älter als 5 Minuten`);
    }
    if (heartbeat.appVersion !== expectedVersion) issues.push(`${device}: App-Version stimmt nicht`);
    if (heartbeat.syncState !== 'SYNCHRON') issues.push(`${device}: nicht synchron`);
    if (heartbeat.pendingCount !== 0 || heartbeat.rejectedCount !== 0) {
      issues.push(`${device}: ausstehende oder abgelehnte Buchungen`);
    }
    if (heartbeat.eventCount !== eventCount || heartbeat.checkCodeJson !== expected) {
      issues.push(`${device}: Ereigniszahl oder Prüfcode weicht vom Server ab`);
    }
  }
  return issues;
}
