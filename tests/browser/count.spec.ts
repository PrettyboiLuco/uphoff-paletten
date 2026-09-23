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

test('outgoing mode is visually and functionally distinct', async ({ page }) => {
  await page.getByRole('button', { name: 'AUSGANG' }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-mode', 'ausgang');

  const firstRow = page.locator('.pallet-row').first();
  await firstRow.locator('.stack-button').click();
  await expect(firstRow.locator('.row-stock strong')).toHaveText('-15');
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

  await page.mouse.move(box!.x + box!.width - 20, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 20, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('.stat-hero')).toBeVisible();
});
