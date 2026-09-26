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


test('zero stock disables removing a single pallet, and one pallet can be removed to zero', async ({ page }) => {
  const row = page.locator('.pallet-row').first();

  await expect(row.locator('.adjust-button').first()).toBeDisabled();
  await row.locator('.adjust-button').last().click();
  await row.locator('.adjust-button').first().click();

  await expect(row.locator('.row-stock strong')).toHaveText('0');
  await expect(row.locator('.adjust-button').first()).toBeDisabled();
  await expect(row).toHaveAttribute('data-negative', 'false');
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
  await expect(firstRow.locator('.stack-button')).toBeDisabled();
  await page.getByRole('button', { name: 'EINGANG' }).click();
  await firstRow.locator('.stack-button').click();
  await page.getByRole('button', { name: 'AUSGANG' }).click();
  await firstRow.locator('.stack-button').click();
  await expect(firstRow.locator('.row-stock strong')).toHaveText('0');
  await expect(firstRow.locator('.stack-button')).toBeDisabled();
  await expect(firstRow).toHaveAttribute('data-negative', 'false');
  await expect(firstRow.locator('.stack-button')).toContainText('−15');
});

test('outgoing stack is unavailable until enough pallets exist', async ({ page }) => {
  const row = page.locator('.pallet-row').first();
  await row.locator('.adjust-button').last().click();
  await page.getByRole('button', { name: 'AUSGANG' }).click();
  await expect(row.locator('.stack-button')).toBeDisabled();
  await expect(row.locator('.adjust-button').first()).toBeEnabled();
});

test('seven pallet rows exist and every booking control has a large hit area', async ({ page }) => {
  const rows = page.locator('.pallet-row');
  await expect(rows).toHaveCount(7);

  for (const button of await page.locator('.pallet-row .stack-button, .pallet-row .adjust-button').all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(60);
    expect(box!.height).toBeGreaterThanOrEqual(60);
  }
});

test('pallet details show a real image slot and confirmed stack size without booking', async ({ page }) => {
  await page.getByRole('button', { name: 'Europaletten ansehen' }).click();
  const detail = page.getByRole('dialog', { name: 'Europaletten ansehen' });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('img', { name: /Europaletten/ })).toBeVisible();
  await expect(detail).toContainText('Paletten je Stapel');
  await expect(detail.locator('.pallet-detail-numbers strong').last()).toHaveText('15');
  await detail.getByRole('button', { name: 'Palettendetails schließen' }).click();
  await expect(page.locator('.pallet-row').first().locator('.row-stock strong')).toHaveText('0');
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

test('last booking and undo remain reachable above fixed navigation', async ({ page }) => {
  await page.locator('.app-shell').evaluate((shell) => {
    shell.scrollTop = shell.scrollHeight;
  });
  const action = await page.locator('.last-action').boundingBox();
  const nav = await page.locator('.bottom-nav').boundingBox();
  expect(action).not.toBeNull();
  expect(nav).not.toBeNull();
  expect(action!.y).toBeGreaterThanOrEqual(0);
  expect(action!.y + action!.height).toBeLessThanOrEqual(nav!.y - 2);
});

test('all statistics content can be scrolled above fixed navigation', async ({ page }) => {
  await page.getByRole('button', { name: 'STATISTIK' }).click();
  await page.locator('.app-shell').evaluate((shell) => {
    shell.scrollTop = shell.scrollHeight;
  });
  const strip = await page.locator('.stock-strip').boundingBox();
  const nav = await page.locator('.bottom-nav').boundingBox();
  expect(strip).not.toBeNull();
  expect(nav).not.toBeNull();
  expect(strip!.y).toBeGreaterThanOrEqual(0);
  expect(strip!.y + strip!.height).toBeLessThanOrEqual(nav!.y - 2);
});

test('landscape state blocks counting with an explicit portrait instruction', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.orientation-warning')).toBeVisible();
  await expect(page.locator('.orientation-warning')).toContainText('HOCHFORMAT VERWENDEN');
});
