import { test, expect } from '@playwright/test';

test('switches live without changing measurements or labels, localizes SVG and persists the preference', async ({ page }) => {
  await page.goto('/');
  const language = page.getByLabel('Language / 语言', { exact: true });
  await language.selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Try the synthetic example' })).toBeVisible();
  await page.getByRole('button', { name: 'API settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Vision API settings');
  await expect(page.getByRole('dialog')).not.toContainText('视觉');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Try the synthetic example' }).click();
  const before = await page.locator('#result-chart rect').evaluateAll(els => els.map(el => [el.getAttribute('x'),el.getAttribute('y'),el.getAttribute('height')]));
  await expect(page.locator('#result-chart')).toContainText('Relative intensity estimated from screenshot grayscale');
  await expect(page.getByRole('table')).toContainText('Mean background');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Chart SVG', exact: true }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk);
  const svg = Buffer.concat(chunks).toString();
  expect(svg).toContain('Relative intensity estimated from screenshot grayscale');
  expect(svg).toContain('COMP');
  await language.selectOption('zh');
  await expect(page.getByRole('table')).toContainText('背景均值');
  expect(await page.locator('#result-chart rect').evaluateAll(els => els.map(el => [el.getAttribute('x'),el.getAttribute('y'),el.getAttribute('height')]))).toEqual(before);
  await language.selectOption('en'); await page.reload();
  await expect(language).toHaveValue('en');
  await expect(page).toHaveTitle('BlotLens · WB Trend Review');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(language).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('connection results and opt-in settings are translated in hosted mode', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { hosted: true, baseUrl: 'https://api.deepseek.com/v1', model: '', keyConfigured: false, allowedProviderUrls: ['https://api.deepseek.com/v1'] } }));
  await page.route('**/api/check', route => route.fulfill({ status: 502, json: { error: { message: '公网识别需要有效 API Key' } } }));
  await page.goto('/');
  await page.getByLabel('Language / 语言', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'API settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Remember API settings on this device');
  await page.getByLabel('Model name', { exact: true }).fill('deepseek-flash');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-key');
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByRole('alert')).toContainText('The hosted service requires a valid API key');
});
