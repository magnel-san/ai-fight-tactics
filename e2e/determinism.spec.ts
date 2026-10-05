// ブラウザ間の決定性テスト:Chromium・Firefox・WebKit で計算したハッシュが、Node で計算した値と一致すること
import { expect, test } from '@playwright/test';
import { initRapier } from '../src/core/physics/rapier';
import { determinismReport } from '../src/core/sim/determinism';

let expected: Record<string, string>;

test.beforeAll(async () => {
  expected = determinismReport(await initRapier());
});

test('物理・移動トレーニング・バトルの結果がNodeと一致する', async ({ page }) => {
  await page.goto('/determinism.html');
  const result = page.locator('#result[data-done="1"]');
  await expect(result).toBeVisible({ timeout: 120_000 });
  const text = (await result.textContent()) ?? '';
  expect(text.startsWith('ERROR')).toBe(false);
  expect(JSON.parse(text)).toEqual(expected);
});
