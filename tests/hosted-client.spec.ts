import { test, expect } from '@playwright/test';

test('hosted keys stay in page memory, are isolated between browsers and are excluded from exports', async ({ browser }) => {
  const alice = await browser.newContext(), bob = await browser.newContext();
  const config = { hosted: true, allowedProviderUrls: ['https://api.openai.com/v1'], baseUrl: 'https://api.openai.com/v1', model: '', keyConfigured: false };
  for (const context of [alice, bob]) await context.route('**/api/config', route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: config });
  });
  const page = await alice.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('经 BlotLens 服务器转发');
  await page.getByLabel('模型名', { exact: true }).fill('fixture-model');
  await page.getByLabel('API Key', { exact: true }).fill('alice-test-secret');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '先试试合成示例' }).click();
  let sent = false;
  await page.route('**/api/recognize', route => {
    expect(route.request().postDataJSON().provider).toEqual({ baseUrl: config.baseUrl, model: 'fixture-model', apiKey: 'alice-test-secret' });
    sent = true;
    return route.fulfill({ status: 502, json: { error: { message: 'fixture failure' } } });
  });
  await page.getByRole('button', { name: '自动识别', exact: true }).click();
  await expect.poll(() => sent).toBe(true);
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '可复算分析文件 JSON', exact: true }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).not.toContain('alice-test-secret');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('alice-test-secret');
  const other = await bob.newPage(); await other.goto('/');
  await other.getByRole('button', { name: 'API 设置', exact: true }).click();
  await expect(other.getByLabel('模型名', { exact: true })).toHaveValue('');
  await page.reload();
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await expect(page.getByLabel('模型名', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await alice.close(); await bob.close();
});

test('opt-in restores on refresh, checks current credentials without screenshots, and clears saved keys', async ({ page }) => {
  const config = { hosted: true, allowedProviderUrls: ['https://api.deepseek.com/v1', 'https://api.openai.com/v1'], baseUrl: 'https://api.openai.com/v1', model: '', keyConfigured: false };
  await page.route('**/api/config', route => route.fulfill({ json: config }));
  await page.goto('/');
  const settings = () => page.getByRole('button', { name: 'API 设置', exact: true }).click();
  const save = () => page.getByRole('button', { name: '保存设置', exact: true }).click();
  await settings();
  const remember = page.getByLabel('在此设备记住 API 配置（含密钥）');
  await expect(remember).not.toBeChecked();
  await page.getByLabel('Base URL', { exact: true }).fill('https://api.deepseek.com/v1');
  await page.getByLabel('模型名', { exact: true }).fill('deepseek-flash');
  await page.getByLabel('API Key', { exact: true }).fill('fake-remembered-secret');
  await page.route('**/api/check', route => {
    expect(route.request().postDataJSON()).toEqual({ provider: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'fake-remembered-secret' } });
    return route.fulfill({ json: { modelListed: true, message: '连接验证通过：可访问模型列表，且包含所填模型。尚未验证图片输入能力。' } });
  });
  await page.getByRole('button', { name: '验证连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接验证通过');
  expect(await page.evaluate(() => localStorage.getItem('blotlens.provider.v1'))).toBeNull();
  await remember.check(); await save(); await page.reload(); await settings();
  await expect(page.getByLabel('模型名', { exact: true })).toHaveValue('deepseek-flash');
  await expect(remember).toBeChecked();
  await page.getByRole('button', { name: '验证连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接验证通过');
  await remember.uncheck(); await save();
  expect(await page.evaluate(() => localStorage.getItem('blotlens.provider.v1'))).toBeNull();
  await settings(); await remember.check(); await save();
  await page.reload(); await settings();
  await page.getByLabel('清除当前密钥及此设备保存的密钥（保存后生效）').check(); await save();
  expect(await page.evaluate(() => localStorage.getItem('blotlens.provider.v1'))).toBeNull();
  await page.reload(); await settings();
  await expect(page.getByLabel('模型名', { exact: true })).toHaveValue('');
});
