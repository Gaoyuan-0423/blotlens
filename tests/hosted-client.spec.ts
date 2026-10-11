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
