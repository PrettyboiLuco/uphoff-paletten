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
    expect(box!.width).toBeGreaterThanOrEqual(54);
    expect(box!.height).toBeGreaterThanOrEqual(56);
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
