import { expect, test } from '@playwright/test';

test('production build exposes manifest, icons and an active service worker', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const body = await manifest.json();
  expect(body.name).toBe('UPHOFF Paletten');
  expect(body.display).toBe('standalone');
  expect(body.orientation).toBe('portrait-primary');
  expect(body.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512' }),
    ]),
  );

  await expect.poll(async () =>
    page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.state ?? 'none';
    }),
  ).toBe('activated');
});

test('installed shell reloads while fully offline after first online load', async ({ page, context }) => {
  await page.goto('/');

  await expect.poll(async () =>
    page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    }),
  ).toBe(true);

  await context.setOffline(true);
  await page.evaluate(() => window.location.reload());
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByText('UPHOFF')).toBeVisible();
  await expect(page.getByRole('button', { name: 'EINGANG' })).toBeVisible();
  await expect(page.locator('.sync-pill')).toContainText('Offline');
});

test('offline booking survives an offline page reload from the production service worker', async ({ page, context }) => {
  await page.goto('/');

  await expect.poll(async () =>
    page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    }),
  ).toBe(true);

  await context.setOffline(true);

  const row = page.locator('.pallet-row').first();
  await row.locator('.stack-button').click();
  await expect(row.locator('.row-stock strong')).toHaveText('15');
  await expect(page.locator('.sync-pill')).toContainText('1 ausstehend');

  await page.evaluate(() => window.location.reload());
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('15');
  await expect(page.locator('.sync-pill')).toContainText('1 ausstehend');
});

test('production app has no horizontal overflow and critical controls remain in the viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-ready', 'true');

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  for (const locator of [
    page.locator('.pallet-row').last(),
    page.locator('.bottom-nav'),
  ]) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  }
});
