import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'LAYOUT', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Layout bearbeiten' })).toBeVisible();
  await page.getByRole('button', { name: 'BEARBEITEN' }).click();
  await expect(page.getByRole('dialog', { name: 'Layout Editor' })).toBeVisible();
  await expect(page.locator('.layout-canvas')).toHaveAttribute('data-loaded', 'true');
});

test('requires explicit confirmation before editing', async ({ page }) => {
  // beforeEach has already confirmed; close and reopen to prove the guard returns.
  await page.getByRole('button', { name: 'Layout Editor schließen' }).click();
  await page.getByRole('button', { name: 'LAYOUT', exact: true }).click();
  await expect(page.getByRole('button', { name: 'BEARBEITEN' })).toBeVisible();
});

test('locked pallet block cannot be resized', async ({ page }) => {
  const pallets = page.locator('[data-layout-id="PALLETS"]');
  await expect(pallets).toContainText('GESPERRT');
  await expect(
    pallets.getByRole('button', { name: /Größe ändern/ }),
  ).toHaveCount(0);
});

test('resize, save, reopen and apply custom width to the live count screen', async ({ page }) => {
  const total = page.locator('[data-layout-id="TOTAL"]');
  const handle = total.getByRole('button', { name: 'Gesamtbestand Größe ändern' });
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x - 70, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();

  await page.getByRole('button', { name: 'SPEICHERN' }).click();
  await expect(page.getByRole('dialog', { name: 'Layout Editor' })).toHaveCount(0);

  const hero = page.locator('.hero-total');
  const shell = page.locator('.count-page');
  const heroBox = await hero.boundingBox();
  const shellBox = await shell.boundingBox();
  expect(heroBox).not.toBeNull();
  expect(shellBox).not.toBeNull();
  expect(heroBox!.width).toBeLessThan(shellBox!.width);

  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-ready', 'true');
  const reloadedHero = await page.locator('.hero-total').boundingBox();
  const reloadedShell = await page.locator('.count-page').boundingBox();
  expect(reloadedHero!.width).toBeLessThan(reloadedShell!.width);
});

test('cancel discards draft changes', async ({ page }) => {
  const total = page.locator('[data-layout-id="TOTAL"]');
  const before = await total.boundingBox();
  const handle = total.getByRole('button', { name: 'Gesamtbestand Größe ändern' });
  const handleBox = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + 5, handleBox!.y + 5);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x - 60, handleBox!.y + 5, { steps: 6 });
  await page.mouse.up();

  const changed = await total.boundingBox();
  expect(changed!.width).toBeLessThan(before!.width);

  await page.getByRole('button', { name: 'ABBRECHEN' }).last().click();
  await page.getByRole('button', { name: 'LAYOUT', exact: true }).click();
  await page.getByRole('button', { name: 'BEARBEITEN' }).click();

  const reopened = await page.locator('[data-layout-id="TOTAL"]').boundingBox();
  expect(Math.round(reopened!.width)).toBe(Math.round(before!.width));
});

test('standard restores default layout after a custom save', async ({ page }) => {
  const total = page.locator('[data-layout-id="TOTAL"]');
  const handle = total.getByRole('button', { name: 'Gesamtbestand Größe ändern' });
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + 5, box!.y + 5);
  await page.mouse.down();
  await page.mouse.move(box!.x - 60, box!.y + 5, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'SPEICHERN' }).click();

  await page.getByRole('button', { name: 'LAYOUT', exact: true }).click();
  await page.getByRole('button', { name: 'BEARBEITEN' }).click();
  await page.getByRole('button', { name: 'STANDARD' }).click();
  await page.getByRole('button', { name: 'SPEICHERN' }).click();

  const hero = await page.locator('.hero-total').boundingBox();
  const shell = await page.locator('.count-page').boundingBox();
  expect(Math.round(hero!.width)).toBe(Math.round(shell!.width));
});
