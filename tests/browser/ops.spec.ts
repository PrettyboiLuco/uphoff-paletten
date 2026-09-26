import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-ready', 'true');
  await page.getByRole('button', { name: 'DATEN', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Daten und Betrieb' })).toBeVisible();
});

test('shows backup due and truthful local health counts', async ({ page }) => {
  await expect(page.locator('.backup-state')).toContainText('EXTERNE SICHERUNG FÄLLIG');
  await expect(page.locator('.health-grid')).toContainText('BESTÄTIGTE EVENTS');
  await expect(page.locator('.health-grid')).toContainText('AUSSTEHEND');
});

test('JSON download stays due until external storage is confirmed', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON SICHERN' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^uphoff-paletten-backup-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.locator('.backup-state')).toContainText('EXTERNE SICHERUNG FÄLLIG');
  await page.getByRole('button', { name: 'SICHERUNG ABGELEGT' }).click();
  await expect(page.locator('.backup-state')).toContainText('SICHERUNG AKTUELL');
  await expect(page.getByRole('status')).toContainText('als abgelegt bestätigt');
});

test('CSV audit export downloads a readable audit file', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV EXPORT' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^uphoff-paletten-audit-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('valid JSON restore changes the same durable event store used by counting', async ({ page }) => {
  const backup = {
    manifest: {
      schemaVersion: 1,
      exportedAt: '2026-09-23T12:00:00Z',
      app: 'uphoff-paletten',
      eventCount: 1,
      outboxCount: 0,
      conflictCount: 0,
    },
    events: [
      {
        id: 'restore-1',
        geraetId: 'backup-device',
        sorte: 'typ-1',
        art: 'ZUGANG',
        delta: 15,
        buchungszeit: '2026-09-23T10:00:00+02:00',
        konfigVersion: 'v1',
        syncState: 'CONFIRMED',
        createdLocalAt: '2026-09-23T10:00:00+02:00',
      },
    ],
    outbox: [],
    conflicts: [],
  };

  await page.locator('.file-action input').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  await expect(page.getByRole('status')).toContainText('Wiederherstellung geprüft');
  await page.getByRole('button', { name: 'Datenpanel schließen' }).click();

  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('15');

  await page.reload();
  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('15');
});

test('conflicting restore aborts and preserves existing event', async ({ page }) => {
  await page.getByRole('button', { name: 'Datenpanel schließen' }).click();

  const row = page.locator('.pallet-row').first();
  await row.locator('.stack-button').click();
  await expect(row.locator('.row-stock strong')).toHaveText('15');

  // Get the generated local event id directly from IndexedDB.
  const eventId = await page.evaluate(async () => {
    const request = indexedDB.open('uphoff-paletten');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction('events', 'readonly');
    const getAll = tx.objectStore('events').getAll();
    const events = await new Promise<any[]>((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    database.close();
    return events[0].id as string;
  });

  await page.getByRole('button', { name: 'DATEN', exact: true }).click();

  const conflictBackup = {
    manifest: {
      schemaVersion: 1,
      exportedAt: '2026-09-23T12:00:00Z',
      app: 'uphoff-paletten',
      eventCount: 2,
      outboxCount: 0,
      conflictCount: 0,
    },
    events: [
      {
        id: eventId,
        geraetId: 'other-device',
        sorte: 'typ-1',
        art: 'ZUGANG',
        delta: 17,
        buchungszeit: '2026-09-23T10:00:00+02:00',
        konfigVersion: 'v1',
        syncState: 'CONFIRMED',
        createdLocalAt: '2026-09-23T10:00:00+02:00',
      },
      {
        id: 'must-not-be-inserted',
        geraetId: 'other-device',
        sorte: 'typ-1',
        art: 'ZUGANG',
        delta: 15,
        buchungszeit: '2026-09-23T10:00:00+02:00',
        konfigVersion: 'v1',
        syncState: 'CONFIRMED',
        createdLocalAt: '2026-09-23T10:00:00+02:00',
      },
    ],
    outbox: [],
    conflicts: [],
  };

  await page.locator('.file-action input').setInputFiles({
    name: 'conflict.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(conflictBackup)),
  });

  await expect(page.getByRole('status')).toContainText('nichts überschrieben');
  await page.getByRole('button', { name: 'Datenpanel schließen' }).click();

  await expect(row.locator('.row-stock strong')).toHaveText('15');
});
