import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import example1 from './fixtures/example1-detection.json' with { type: 'json' };
import example2 from './fixtures/example2-detection.json' with { type: 'json' };
import type { Detection, RecognitionResult, ReviewSession } from '../src/core/types';

const origin = 'http://127.0.0.1:4318';
const secret = 'e2e-only-secret-never-real';
const fixtureMetadata = { providerBaseUrl: 'https://fixture.invalid/v1', model: 'human-authored-mock', promptVersion: 'e2e-fixture-not-live-model', createdAt: '2026-10-10T00:00:00.000Z' };
const responseFor = (detection: Detection): RecognitionResult => ({ ...fixtureMetadata, detection, rawResponse: JSON.stringify(detection) });
const measuredRows = (page: Page) => page.locator('#measurements tbody tr');
const relativeValues = (page: Page) => page.locator('#measurements .relative-value').allTextContents();
const numericValues = (values: string[]) => values.filter((value) => value !== '—' && Number.isFinite(Number(value)));

async function download(page: Page, label: string) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const item = await pending;
  expect(await item.failure()).toBeNull();
  const path = await item.path();
  if (!path) throw new Error('Download path is unavailable');
  return { name: item.suggestedFilename(), bytes: await readFile(path) };
}
async function project(page: Page) {
  const output = await download(page, '可复算分析文件 JSON');
  return { ...output, value: JSON.parse(output.bytes.toString('utf8')) as ReviewSession };
}
async function loadExample(page: Page) {
  await page.getByRole('button', { name: '先试试合成示例' }).click();
  await expect(measuredRows(page)).toHaveCount(15);
}
async function uploadSource(page: Page, value: ReviewSession, name = 'uploaded-synthetic.png') {
  await page.getByLabel('导入截图', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(value.source.dataUrl.split(',')[1], 'base64') });
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function saveSettings(page: Page) {
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.getByLabel('Base URL', { exact: true }).fill(fixtureMetadata.providerBaseUrl);
  await page.getByLabel('模型名', { exact: true }).fill(fixtureMetadata.model);
  await page.getByLabel('API Key', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** Generate entirely synthetic pixels at the human-authored layout coordinates.
 * The optional real screenshots below are separate; no real image is bundled. */
async function syntheticFixtureImage(page: Page, fixture: typeof example1 | typeof example2, chartColor = '#111111') {
  const dataUrl = await page.evaluate(({ fixture, chartColor }) => {
    const canvas = document.createElement('canvas');
    canvas.width = fixture.sourceWidth; canvas.height = fixture.sourceHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const panel = fixture.detection.panel;
    ctx.fillStyle = '#eeeeee'; ctx.fillRect(panel.x * canvas.width, panel.y * canvas.height, panel.width * canvas.width, panel.height * canvas.height);
    fixture.detection.rows.forEach((row, r) => row.bands.forEach((band, l) => {
      const rect = band.rect;
      const intensity = r === 4 ? 100 : 65 + l * 22;
      ctx.fillStyle = `rgb(${intensity},${intensity},${intensity})`;
      ctx.fillRect(Math.round(rect.x * canvas.width) + 3, Math.round(rect.y * canvas.height) + 5, Math.round(rect.width * canvas.width) - 6, Math.round(rect.height * canvas.height) - 10);
    }));
    // Deliberately strong chart-like pixels outside the WB panel.
    ctx.fillStyle = chartColor;
    if (fixture.detection.lanes.length === 2) {
      for (let i = 0; i < 7; i++) ctx.fillRect(290 + i * 37, 180 - i * 8, 22, 110 + i * 8);
    } else {
      for (let i = 0; i < 8; i++) ctx.fillRect(70 + i * 58, 490 - i * 5, 30, 140 + i * 5);
    }
    return canvas.toDataURL('image/png');
  }, { fixture, chartColor });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

test.beforeEach(async ({ page, request }) => {
  // Reset server memory across tests, and intercept every recognition request.
  // A missing test-specific fixture fails visibly instead of making a paid call.
  const response = await request.post('/api/config', { headers: { Origin: origin }, data: { baseUrl: fixtureMetadata.providerBaseUrl, model: fixtureMetadata.model, apiKey: '' } });
  expect(response.ok()).toBeTruthy();
  await page.route('**/api/recognize', (route) => route.fulfill({ status: 502, json: { error: { code: 'test_guard', message: 'TEST GUARD: no recognition fixture registered; external calls disabled' } } }));
  await page.goto('/');
});

test('landing and synthetic example calculate twelve target values; contrast changes display only', async ({ page }) => {
  let calls = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/recognize')) calls++; });
  await expect(page.getByRole('heading', { name: /让条带的趋势，\s*更容易核对。/ })).toBeVisible();
  await loadExample(page);
  const values = await relativeValues(page);
  expect(numericValues(values)).toHaveLength(12);
  expect(values.slice(12)).toEqual(['—', '—', '—']);
  expect(Number(values[1])).toBeCloseTo(1.6, 1);
  expect(Number(values[10])).toBeCloseTo(0.53, 1);
  await expect(page.getByRole('img', { name: '截图灰度估计的相对强度柱状图' })).toBeVisible();
  const before = await page.locator('#measurements tbody').innerText();
  await page.getByLabel('预览对比度', { exact: true }).focus();
  await page.getByLabel('预览对比度', { exact: true }).press('End');
  await expect(page.getByLabel('预览对比度', { exact: true })).toHaveValue('200');
  await expect(page.locator('#source-stage image')).toHaveAttribute('style', 'filter: contrast(200%);');
  expect(await page.locator('#measurements tbody').innerText()).toBe(before);
  expect(calls).toBe(0);
});

test('numeric ROI edits recalculate the signal and synchronize dimensions in that protein row', async ({ page }) => {
  await loadExample(page);
  const before = await measuredRows(page).nth(1).locator('td').nth(4).innerText();
  await page.getByRole('button', { name: 'COMP Treatment 条带', exact: true }).focus();
  await page.getByLabel('ROI width', { exact: true }).fill('96');
  await page.getByLabel('ROI width', { exact: true }).press('Enter');
  for (const lane of ['Ctrl', 'Treatment', 'Rescue']) await expect(page.getByRole('button', { name: `COMP ${lane} 条带`, exact: true })).toHaveAttribute('width', '96');
  await expect(page.getByRole('button', { name: 'β-actin Ctrl 条带', exact: true })).toHaveAttribute('width', '118');
  await expect(measuredRows(page).nth(1).locator('td').nth(4)).not.toHaveText(before);
  const value = (await project(page)).value;
  expect(value.rows[0].bands.map((band) => band.rect.width)).toEqual([96, 96, 96]);
  expect(value.history.at(-1)?.action).toContain('同步同一蛋白行尺寸');
});

test('clearing a reference pairing marks only that protein unavailable and can be restored', async ({ page }) => {
  await loadExample(page);
  await page.getByRole('button', { name: '蛋白与分组', exact: true }).click();
  await page.getByLabel('COMP 内参', { exact: true }).selectOption('');
  await expect(measuredRows(page).nth(0)).toContainText('待指定对应内参');
  expect((await relativeValues(page)).slice(0, 3)).toEqual(['—', '—', '—']);
  expect(numericValues(await relativeValues(page))).toHaveLength(9);
  await page.getByLabel('COMP 内参', { exact: true }).selectOption('actin');
  expect(numericValues(await relativeValues(page))).toHaveLength(12);
});

test('PNG SVG CSV and audited JSON export; JSON roundtrip reproduces measurements without exposing keys', async ({ page }) => {
  await saveSettings(page);
  await loadExample(page);
  const before = await page.locator('#measurements tbody').innerText();
  const saved = await project(page);
  expect(saved.value.source.sha256).toMatch(/^[a-f\d]{64}$/);
  expect(saved.bytes.toString()).not.toContain(secret);
  expect(saved.value).not.toHaveProperty('apiKey');
  const svg = await download(page, '柱状图 SVG');
  expect(svg.name).toBe('blotlens-chart.svg');
  expect(svg.bytes.toString()).toContain('截图灰度估计的相对强度');
  expect(svg.bytes.toString()).not.toContain(secret);
  const png = await download(page, '柱状图 PNG');
  expect(png.name).toBe('blotlens-chart.png');
  expect([...png.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const overlay = await download(page, '取样框叠图 PNG');
  expect(overlay.bytes.readUInt32BE(16)).toBe(900); expect(overlay.bytes.readUInt32BE(20)).toBe(650);
  const csv = await download(page, '测量明细 CSV');
  expect(csv.bytes.toString()).toContain('relative_to_control');
  expect(csv.bytes.toString().trim().split('\r\n')).toHaveLength(16);
  expect(csv.bytes.toString()).not.toContain(secret);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(secret);
  let recognitions = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/recognize')) recognitions++; });
  await uploadSource(page, saved.value);
  await expect(measuredRows(page)).toHaveCount(0);
  await page.getByLabel('载入分析文件', { exact: true }).setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: saved.bytes });
  await expect(measuredRows(page)).toHaveCount(15);
  expect(await page.locator('#measurements tbody').innerText()).toBe(before);
  expect((await project(page)).value).toEqual(saved.value);
  expect(recognitions).toBe(0);
});

for (const [index, fixture] of [example1, example2].entries()) {
  test(`mock recognition ${index + 1}: five by ${fixture.detection.lanes.length} layout; chart pixels do not affect measurements`, async ({ page }) => {
    const detection = fixture.detection as Detection;
    let calls = 0;
    await page.route('**/api/recognize', async (route) => {
      calls++;
      expect(route.request().postDataJSON().image).toMatchObject({ width: fixture.sourceWidth, height: fixture.sourceHeight });
      await route.fulfill({ json: responseFor(detection) });
    });
    let firstMeasurements = '';
    for (const chartColor of ['#111111', '#ffcc00']) {
      const buffer = await syntheticFixtureImage(page, fixture, chartColor);
      await page.getByLabel('导入截图', { exact: true }).setInputFiles({ name: `synthetic-fixture-${index + 1}.png`, mimeType: 'image/png', buffer });
      await expect(measuredRows(page)).toHaveCount(0);
      await page.getByRole('button', { name: '自动识别', exact: true }).click();
      await expect(measuredRows(page)).toHaveCount(5 * detection.lanes.length);
      const saved = (await project(page)).value;
      expect(saved.rows).toHaveLength(5); expect(saved.lanes).toHaveLength(detection.lanes.length);
      expect(saved.rows.at(-1)?.role).toBe('reference');
      expect(saved.recognition?.promptVersion).toBe('e2e-fixture-not-live-model');
      const panel = saved.panel;
      for (const row of saved.rows) for (const band of row.bands) for (const rect of [band.rect, ...band.backgrounds]) {
        expect(rect.x).toBeGreaterThanOrEqual(panel.x); expect(rect.y).toBeGreaterThanOrEqual(panel.y);
        expect(rect.x + rect.width).toBeLessThanOrEqual(panel.x + panel.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(panel.y + panel.height);
      }
      const values = await page.locator('#measurements tbody').innerText();
      if (!firstMeasurements) firstMeasurements = values;
      else expect(values).toBe(firstMeasurements);
    }
    expect(calls).toBe(2);
  });
}

test('API failure preserves the original screenshot and measurement draft', async ({ page }) => {
  await loadExample(page);
  const before = await page.locator('#measurements tbody').innerText();
  const pixels = await page.locator('#source-stage image').getAttribute('href');
  await page.route('**/api/recognize', (route) => route.fulfill({ status: 502, json: { error: { code: 'provider_auth', message: '模拟认证失败；截图保留' } } }));
  await page.getByRole('button', { name: '自动识别', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('模拟认证失败');
  expect(await page.locator('#source-stage image').getAttribute('href')).toBe(pixels);
  expect(await page.locator('#measurements tbody').innerText()).toBe(before);
  await expect(page.getByRole('button', { name: '自动识别', exact: true })).toBeEnabled();
});

test('clipboard and drop imports reach the real handlers; manual grids work without a cloud call', async ({ page }) => {
  let calls = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/recognize')) calls++; });
  const bytes = await syntheticFixtureImage(page, example2);
  const base64 = bytes.toString('base64');
  await page.evaluate((base64) => {
    const pixels = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([pixels], 'clipboard-grid.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
  }, base64);
  await expect(page.getByRole('heading', { name: 'clipboard-grid.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '手动取样', exact: true }).click();
  await page.getByLabel('蛋白行数', { exact: true }).fill('3');
  await page.getByLabel('蛋白行数', { exact: true }).press('Enter');
  await page.getByLabel('泳道数', { exact: true }).fill('2');
  await page.getByLabel('泳道数', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '生成取样框', exact: true }).click();
  await expect(measuredRows(page)).toHaveCount(6);
  const grid = (await project(page)).value;
  expect(grid.rows).toHaveLength(3); expect(grid.lanes).toHaveLength(2);
  expect(grid.rows.every((row) => row.bands.length === 2 && row.referenceRowId === null)).toBe(true);
  expect(grid.recognition).toBeNull(); expect(grid.controlLaneId).toBe(grid.lanes[0].id);
  expect(numericValues(await relativeValues(page))).toHaveLength(0);
  await page.evaluate((base64) => {
    const pixels = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([pixels], 'drop-grid.png', { type: 'image/png' }));
    document.querySelector('.app-shell')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
  }, base64);
  await expect(page.getByRole('heading', { name: 'drop-grid.png', exact: true })).toBeVisible();
  await expect(measuredRows(page)).toHaveCount(0);
  expect(calls).toBe(0);
});

test('the background limit cannot poison the session or its exported edit history', async ({ page }) => {
  await loadExample(page);
  const original = (await project(page)).value;
  const band = original.rows[0].bands[0];
  expect(band.backgrounds.length).toBeGreaterThan(0);
  band.backgrounds = Array.from({ length: 20 }, () => ({ ...band.backgrounds[0] }));
  await page.getByLabel('载入分析文件', { exact: true }).setInputFiles({ name: 'max-backgrounds.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)) });
  await expect(measuredRows(page)).toHaveCount(15);
  await page.getByRole('button', { name: 'COMP Ctrl 条带', exact: true }).focus();
  await expect(page.getByRole('button', { name: '背景 20', exact: true })).toBeVisible();
  const add = page.getByRole('button', { name: '＋ 背景', exact: true });
  await expect(add).toBeDisabled();
  // Native click on a disabled control must not create an unexportable edit.
  await add.evaluate((button: HTMLButtonElement) => button.click());
  const saved = await project(page);
  expect(saved.value.rows[0].bands[0].backgrounds).toHaveLength(20);
  expect(saved.value.history).toEqual(original.history);
  await page.getByLabel('载入分析文件', { exact: true }).setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: saved.bytes });
  await expect(measuredRows(page)).toHaveCount(15);
  expect((await project(page)).value).toEqual(saved.value);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('cancel and replacement prevent late recognition results from overwriting current work', async ({ page }) => {
  await loadExample(page);
  const saved = (await project(page)).value;
  const before = await page.locator('#measurements tbody').innerText();
  const pending = [0, 1].map(() => ({ started: deferred(), release: deferred(), handled: deferred() }));
  let attempt = 0;
  const stale = structuredClone(example1.detection) as Detection; stale.rows[0].label = 'STALE RESULT MUST NOT APPEAR';
  await page.route('**/api/recognize', async (route) => {
    const slot = pending[attempt++]; slot.started.resolve(); await slot.release.promise;
    try { await route.fulfill({ json: responseFor(stale) }); } catch { /* The aborted browser request may already be closed. */ }
    finally { slot.handled.resolve(); }
  });
  await page.getByRole('button', { name: '自动识别', exact: true }).click();
  await pending[0].started.promise;
  await page.getByRole('button', { name: '取消识别', exact: true }).click();
  pending[0].release.resolve(); await pending[0].handled.promise;
  expect(await page.locator('#measurements tbody').innerText()).toBe(before);
  await expect(page.getByText('STALE RESULT MUST NOT APPEAR', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '自动识别', exact: true }).click();
  await pending[1].started.promise;
  await uploadSource(page, saved, 'replacement-screenshot.png');
  pending[1].release.resolve(); await pending[1].handled.promise;
  await expect(measuredRows(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'replacement-screenshot.png', exact: true })).toBeVisible();
  await expect(page.getByText('STALE RESULT MUST NOT APPEAR', { exact: true })).toHaveCount(0);
});

for (const [index, fixture] of [example1, example2].entries()) {
  test(`optional original screenshot ${index + 1} with human-authored mock layout`, async ({ page }) => {
    const source = process.env[`WB_SAMPLE_${index + 1}`];
    test.skip(!source, `Set WB_SAMPLE_${index + 1} to the matching user-provided screenshot; image pixels are not bundled.`);
    const bytes = await readFile(source!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sourceSha256);
    await page.route('**/api/recognize', (route) => route.fulfill({ json: responseFor(fixture.detection as Detection) }));
    await page.getByLabel('导入截图', { exact: true }).setInputFiles(source!);
    await page.getByRole('button', { name: '自动识别', exact: true }).click();
    await expect(measuredRows(page)).toHaveCount(5 * fixture.detection.lanes.length);
    const saved = (await project(page)).value;
    expect(saved.rows.map((row) => row.bands.length)).toEqual(Array(5).fill(fixture.detection.lanes.length));
    expect(saved.source.sha256).toBe(fixture.sourceSha256);
    expect(saved.recognition?.model).toBe('human-authored-mock');
  });
}
