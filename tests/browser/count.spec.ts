import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('one tap creates exactly one durable local booking', async ({ page }) => {
  const firstRow = page.locator('.pallet-row').first();
  await expect(firstRow.locator('.row-stock strong')).toHaveText('0');

  await firstRow.locator('.stack-button').click();
  await expect(firstRow.locator('.row-stock strong')).toHaveText('15');
  await expect(page.locator('.sync-pill')).toContainText('1 ausstehend');

  await page.reload();

  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('15');
  await expect(page.locator('.sync-pill')).toContainText('1 ausstehend');
});

test('rapid taps are all persisted instead of being dropped', async ({ page }) => {
  const button = page.locator('.pallet-row').first().locator('.adjust-button').last();

  await Promise.all(Array.from({ length: 10 }, () => button.click()));

  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('10');
  await expect(page.locator('.sync-pill')).toContainText('10 ausstehend');

  await page.reload();
  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('10');
});

test('pointer swipe across a booking button does not create a booking', async ({ page }) => {
  const button = page.locator('.pallet-row').first().locator('.stack-button');
  const box = await button.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + 10, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width + 80, box!.y + box!.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('0');
});


test('negative inventory warns without blocking the booking', async ({ page }) => {
  const row = page.locator('.pallet-row').first();

  await row.locator('.adjust-button').first().click();

  await expect(row.locator('.row-stock strong')).toHaveText('-1');
  await expect(row).toHaveAttribute('data-negative', 'true');
  await expect(page.locator('.last-action')).toContainText('VORZEICHEN PRÜFEN');
});

test('zero-net linked process is called out explicitly', async ({ page }) => {
  const row = page.locator('.pallet-row').first();

  await row.locator('.adjust-button').last().click();
  await row.locator('.adjust-button').first().click();

  await expect(row.locator('.row-stock strong')).toHaveText('0');
  await expect(page.locator('.last-action')).toContainText('NETTO 0 PRÜFEN');
});

test('outgoing mode is visually and functionally distinct', async ({ page }) => {
  await page.getByRole('button', { name: 'AUSGANG' }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-mode', 'ausgang');

  const firstRow = page.locator('.pallet-row').first();
  await firstRow.locator('.stack-button').click();
  await expect(firstRow.locator('.row-stock strong')).toHaveText('-15');
  await expect(firstRow.locator('.row-stock span')).toHaveText('NEGATIV');
  await expect(firstRow).toHaveAttribute('data-negative', 'true');
  await expect(firstRow.locator('.stack-button')).toContainText('−15');
});

test('seven pallet rows exist and every booking control has a large hit area', async ({ page }) => {
  const rows = page.locator('.pallet-row');
  await expect(rows).toHaveCount(7);

  for (const button of await page.locator('.pallet-row button').all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(60);
    expect(box!.height).toBeGreaterThanOrEqual(60);
  }
});

test('main tabs switch without page reload', async ({ page }) => {
  await page.getByRole('button', { name: 'STATISTIK' }).click();
  await expect(page.locator('.stat-hero')).toBeVisible();
  await page.getByRole('button', { name: 'ZÄHLEN' }).click();
  await expect(page.locator('.pallet-list')).toBeVisible();
});

test('page does not horizontally overflow', async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('statistics screen uses the same durable events as counting', async ({ page }) => {
  const row = page.locator('.pallet-row').first();

  await row.locator('.stack-button').click();
  await page.getByRole('button', { name: 'AUSGANG' }).click();
  await row.locator('.stack-button').click();

  await page.getByRole('button', { name: 'STATISTIK' }).click();

  await expect(page.locator('.stat-hero strong')).toHaveText('15');
  await expect(page.locator('.stats-grid div').nth(0).locator('strong')).toHaveText('0');
  await expect(page.locator('.stats-grid div').nth(1).locator('strong')).toHaveText('15');
});


test('statistics exposes stock history, metric toggle and all per-sort stock cells', async ({ page }) => {
  const row = page.locator('.pallet-row').first();
  await row.locator('.stack-button').click();

  await page.getByRole('button', { name: 'STATISTIK' }).click();

  await expect(page.locator('.stock-chart-card')).toBeVisible();
  await expect(page.locator('.stock-chart-line')).toHaveAttribute(
    'd',
    /M .*L /,
  );
  await expect(page.locator('.stock-strip > div')).toHaveCount(7);

  await page.getByRole('button', { name: 'DAZU', exact: true }).click();
  await expect(page.locator('.bar-fill').first()).toHaveClass(/incoming/);
});

test('count and statistics pages fit without vertical document scrolling on target viewport', async ({ page }) => {
  const countOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(countOverflow).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'STATISTIK' }).click();
  const statsOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(statsOverflow).toBeLessThanOrEqual(1);
});

test('undo reverses the entire linked process atomically and survives reload', async ({ page }) => {
  const row = page.locator('.pallet-row').first();

  await row.locator('.stack-button').click();
  await row.locator('.adjust-button').first().click();
  await expect(row.locator('.row-stock strong')).toHaveText('14');

  await page.getByRole('button', { name: 'RÜCKGÄNGIG' }).click();
  await expect(row.locator('.row-stock strong')).toHaveText('0');

  await page.reload();
  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('0');
});

test('horizontal swipe changes main page without triggering booking controls', async ({ page }) => {
  const hero = page.locator('.hero-total');
  const box = await hero.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + Math.min(90, box!.width * 0.35), box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 5, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('.stat-hero')).toBeVisible();
});

test('all critical count controls are physically visible inside the portrait viewport', async ({ page }) => {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  for (const locator of [
    page.locator('.pallet-row').last(),
    page.locator('.last-action'),
    page.locator('.bottom-nav'),
  ]) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  }
});

test('statistics content is physically visible inside the portrait viewport', async ({ page }) => {
  await page.getByRole('button', { name: 'STATISTIK' }).click();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  for (const locator of [
    page.locator('.stat-hero'),
    page.locator('.bar-chart'),
    page.locator('.bottom-nav'),
  ]) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  }
});

test('landscape state blocks counting with an explicit portrait instruction', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.orientation-warning')).toBeVisible();
  await expect(page.locator('.orientation-warning')).toContainText('HOCHFORMAT VERWENDEN');
});
