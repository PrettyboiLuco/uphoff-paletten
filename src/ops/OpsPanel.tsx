import { useEffect, useState } from 'react';
import type { UphoffLocalDb } from '../persistence/localDb';
import {
  createCsvAudit,
  createJsonBackup,
  isExternalBackupDue,
  markExternalBackupDone,
  restoreJsonBackup,
  type RestoreResult,
} from './backup';
import { logOperationalError, recentOperationalErrors } from './errorLog';
import { localHealthSnapshot, runServerSelfTest, type SelfTestResult } from './selfTest';
import type { RemoteReadableEventStore } from '../sync/types';
import type { DeviceHealthSnapshot, OperationalError } from './types';

interface Props {
  db: UphoffLocalDb;
  remote: RemoteReadableEventStore | null;
  deviceId: string | null;
  onClose: () => void;
  onDataChanged: () => void | Promise<void>;
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function OpsPanel({ db, remote, deviceId, onClose, onDataChanged }: Props) {
  const [health, setHealth] = useState<DeviceHealthSnapshot | null>(null);
  const [backupDue, setBackupDue] = useState(true);
  const [errors, setErrors] = useState<OperationalError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [serverTest, setServerTest] = useState<SelfTestResult | null>(null);

  const refresh = async () => {
    const now = new Date().toISOString();
    const [nextHealth, due, recent] = await Promise.all([
      localHealthSnapshot(db, now),
      isExternalBackupDue(db, now),
      recentOperationalErrors(db, 10),
    ]);
    setHealth(nextHealth);
    setBackupDue(due);
    setErrors(recent);
  };

  useEffect(() => {
    void refresh();
    // db is stable for the lifetime of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  const exportJson = async () => {
    setMessage(null);
    try {
      const now = new Date().toISOString();
      const json = await createJsonBackup(db, now);
      downloadText(
        `uphoff-paletten-backup-${now.slice(0, 10)}.json`,
        json,
        'application/json',
      );
      await markExternalBackupDone(db, now);
      setMessage('JSON-Sicherung erstellt.');
      await refresh();
    } catch (error) {
      await logOperationalError(db, {
        code: 'BACKUP_EXPORT_FAILED',
        severity: 'ERROR',
        message: error instanceof Error ? error.message : 'unknown-backup-error',
        occurredAt: new Date().toISOString(),
      });
      setMessage('Sicherung fehlgeschlagen.');
      await refresh();
    }
  };

  const exportCsv = async () => {
    setMessage(null);
    try {
      const csv = await createCsvAudit(db);
      const now = new Date().toISOString();
      downloadText(
        `uphoff-paletten-audit-${now.slice(0, 10)}.csv`,
        csv,
        'text/csv;charset=utf-8',
      );
      setMessage('CSV-Audit exportiert.');
    } catch (error) {
      await logOperationalError(db, {
        code: 'CSV_EXPORT_FAILED',
        severity: 'ERROR',
        message: error instanceof Error ? error.message : 'unknown-csv-error',
        occurredAt: new Date().toISOString(),
      });
      setMessage('CSV-Export fehlgeschlagen.');
      await refresh();
    }
  };

  const runServerCheck = async () => {
    setMessage(null);
    if (!remote) {
      setMessage('Kein freigegebener Live-Server verbunden.');
      return;
    }

    try {
      const result = await runServerSelfTest(
        db,
        remote,
        new Date().toISOString(),
      );
      setServerTest(result);

      if (result.status === 'MATCH') {
        setMessage('Server-Selbsttest: lokale und bestätigte Serverdaten stimmen überein.');
      } else if (result.status === 'ATTENTION') {
        setMessage('Server-Selbsttest: ausstehende oder fehlerhafte lokale Daten müssen zuerst geklärt werden.');
      } else {
        setMessage('Server-Selbsttest: Abweichung erkannt.');
        await logOperationalError(db, {
          code: 'SERVER_SELF_TEST_MISMATCH',
          severity: 'ERROR',
          message: 'Local and remote count/sum check codes differ.',
          occurredAt: new Date().toISOString(),
        });
      }

      await refresh();
    } catch (error) {
      await logOperationalError(db, {
        code: 'SERVER_SELF_TEST_FAILED',
        severity: 'ERROR',
        message: error instanceof Error ? error.message : 'unknown-self-test-error',
        occurredAt: new Date().toISOString(),
      });
      setMessage('Server-Selbsttest fehlgeschlagen.');
      await refresh();
    }
  };

  const restoreFile = async (file: File) => {
    setMessage(null);
    setRestoreResult(null);

    try {
      const result = await restoreJsonBackup(db, await file.text(), deviceId ?? undefined);
      setRestoreResult(result);
      setMessage('Wiederherstellung geprüft und übernommen.');
      await onDataChanged();
      await refresh();
    } catch (error) {
      await logOperationalError(db, {
        code: 'BACKUP_RESTORE_FAILED',
        severity: 'ERROR',
        message: error instanceof Error ? error.message : 'unknown-restore-error',
        occurredAt: new Date().toISOString(),
      });
      setMessage('Wiederherstellung abgebrochen. Es wurde nichts überschrieben.');
      await refresh();
    }
  };

  return (
    <div className="ops-overlay" role="dialog" aria-modal="true" aria-label="Daten und Betrieb">
      <section className="ops-panel">
        <header>
          <div>
            <span>DATEN & BETRIEB</span>
            <strong>Prüfung und Sicherung</strong>
          </div>
          <button aria-label="Datenpanel schließen" onClick={onClose}>×</button>
        </header>

        <div className={`backup-state ${backupDue ? 'due' : 'ok'}`}>
          <strong>{backupDue ? 'EXTERNE SICHERUNG FÄLLIG' : 'SICHERUNG AKTUELL'}</strong>
          <span>
            Die App kann bei geschlossenem iPhone keine wöchentliche Datei zuverlässig exportieren.
            Deshalb wird die Fälligkeit beim Öffnen geprüft.
          </span>
        </div>

        <div className="health-grid">
          <div><span>BESTÄTIGTE EVENTS</span><strong>{health?.eventCount ?? '–'}</strong></div>
          <div><span>AUSSTEHEND</span><strong>{health?.pendingCount ?? '–'}</strong></div>
          <div><span>ABGELEHNT</span><strong>{health?.rejectedCount ?? '–'}</strong></div>
          <div><span>KONFLIKTE</span><strong>{health?.conflictCount ?? '–'}</strong></div>
        </div>

        <div className="ops-actions">
          <button className="primary" onClick={() => void exportJson()}>JSON SICHERN</button>
          <button onClick={() => void exportCsv()}>CSV EXPORT</button>
          <button disabled={!remote} onClick={() => void runServerCheck()}>SERVER PRÜFEN</button>
          <label className="file-action">
            JSON WIEDERHERSTELLEN
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void restoreFile(file);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </div>

        {message && <div className="ops-message" role="status">{message}</div>}

        {restoreResult && (
          <div className="restore-result">
            <span>Neu: {restoreResult.inserted}</span>
            <span>Vorhanden: {restoreResult.merged}</span>
            <span>Outbox: {restoreResult.outboxRestored}</span>
          </div>
        )}

        <div className="ops-note">
          <strong>SERVER-SELBSTTEST</strong>
          <span>
            {remote
              ? 'Live-Prüfung verfügbar. Sie vergleicht bestätigte lokale Events mit dem Server-Prüfcode.'
              : 'Noch keine freigegebene Firebase-Verbindung aktiv.'}
          </span>
          {deviceId && <span>Gerät: {deviceId}</span>}
          {serverTest && (
            <span>
              Ergebnis: {serverTest.status} · lokal {serverTest.local.eventCount} · Server {serverTest.remoteEventCount}
            </span>
          )}
        </div>

        <div className="error-list">
          <div className="error-list-title">LETZTE BETRIEBSFEHLER</div>
          {errors.length === 0 ? (
            <span className="no-errors">Keine protokollierten Fehler.</span>
          ) : (
            errors.map((error) => (
              <div className="error-row" key={error.id}>
                <strong>{error.code}</strong>
                <span>{error.severity} · {new Date(error.occurredAt).toLocaleString('de-DE')}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
