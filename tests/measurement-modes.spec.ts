import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { ReviewSession } from '../src/core/types';

const measuredRows = (page: Page) => page.locator('#measurements tbody tr');
const mode = (page: Page) => page.getByLabel('背景处理方式', { exact: true });
const overlap = (page: Page) => page.getByLabel('允许轻微条带重叠', { exact: true });
const undo = (page: Page) => page.getByRole('button', { name: '撤销', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: '重做', exact: true });
async function numericCount(page: Page) {
  const values = await page.locator('#measurements .relative-value').allTextContents();
  return values.filter(value => value !== '—' && Number.isFinite(Number(value))).length;
}
async function download(page: Page, label: string) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const item = await pending;
  expect(await item.failure()).toBeNull();
  const path = await item.path();
  if (!path) throw new Error('Download path is unavailable');
  return readFile(path);
}
async function project(page: Page): Promise<ReviewSession> {
  return JSON.parse((await download(page, '可复算分析文件 JSON')).toString()) as ReviewSession;
}
let importIndex = 0;
async function restore(page: Page, value: ReviewSession) {
  const name = `measurement-mode-fixture-${++importIndex}.png`;
  const input = structuredClone(value);
  input.source.name = name;
  await page.getByLabel('载入分析文件', { exact: true }).setInputFiles({
    name: 'measurement-mode-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)),
  });
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(measuredRows(page)).toHaveCount(value.rows.reduce((count, row) => count + row.bands.length, 0));
}

test.beforeEach(async ({ page }) => {
  // Only local synthetic data is used. No live API or paid model request is possible.
  await page.route('**/api/recognize', route => route.fulfill({ status: 502, json: { error: { code: 'test_guard', message: 'External recognition disabled in measurement mode tests' } } }));
  await page.goto('/');
  await page.getByRole('button', { name: '先试试合成示例', exact: true }).click();
  await expect(measuredRows(page)).toHaveCount(15);
});

test('quick trend recovers missing-background values with explicit export labels, reversible state and reload', async ({ page }) => {
  const fixture = await project(page);
  for (const row of fixture.rows) for (const band of row.bands) band.backgrounds = [];
  await restore(page, fixture);
  await expect(mode(page)).toHaveValue('subtract');
  await expect.poll(() => numericCount(page)).toBe(0);
  await expect(page.getByRole('button', { name: '补齐缺失背景', exact: true })).toBeVisible();
  await mode(page).selectOption('none');
  await expect.poll(() => numericCount(page)).toBe(12);
  await expect(page.locator('#result-chart')).toContainText('快速趋势 · 未扣背景');
  await expect(page.getByRole('columnheader', { name: '未扣背景信号', exact: true })).toBeVisible();
  const before = await page.locator('#measurements tbody').innerText();
  const saved = await project(page);
  expect(saved.measurementPolicy?.backgroundMode).toBe('none');
  expect(saved.history.at(-1)?.measurementPolicy?.backgroundMode).toBe('none');
  expect(saved.rows.every(row => row.bands.every(band => band.backgrounds.length === 0))).toBe(true);
  const svg = (await download(page, '柱状图 SVG')).toString();
  expect(svg).toContain('快速趋势 · 未扣背景');
  expect(svg).toContain('data-background-mode="none"');
  const csv = (await download(page, '测量明细 CSV')).toString().replace(/^\uFEFF/, '');
  const [header, ...records] = csv.trim().split('\r\n').map(line => line.split(','));
  expect(header).toContain('raw_signal_for_normalization');
  expect(header).toContain('reference_raw_signal');
  const modeColumn = header.indexOf('background_mode');
  expect(modeColumn).toBeGreaterThanOrEqual(0);
  expect(records.every(record => record[modeColumn] === 'none')).toBe(true);
  if (process.env.REVIEWER_CAPTURE_MODES === '1') {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${import.meta.dirname}/../docs/screenshots/measurement-modes.png` });
  }
  await undo(page).click();
  await expect(mode(page)).toHaveValue('subtract');
  await expect.poll(() => numericCount(page)).toBe(0);
  await redo(page).click();
  await expect(mode(page)).toHaveValue('none');
  expect(await page.locator('#measurements tbody').innerText()).toBe(before);
  await restore(page, saved);
  await expect(mode(page)).toHaveValue('none');
  expect(await page.locator('#measurements tbody').innerText()).toBe(before);
  expect((await project(page)).measurementPolicy).toEqual(saved.measurementPolicy);
});

test('repair fills only missing background regions and can be undone', async ({ page }) => {
  const fixture = await project(page);
  const missing = new Set(['comp:lane-1', 'actin:lane-2']);
  for (const row of fixture.rows) for (const band of row.bands) {
    if (missing.has(`${row.id}:${band.laneId}`)) band.backgrounds = [];
  }
  await restore(page, fixture);
  expect(await numericCount(page)).toBeLessThan(12);
  await page.getByRole('button', { name: '补齐缺失背景', exact: true }).click();
  await expect.poll(() => numericCount(page)).toBe(12);
  const repaired = await project(page);
  for (const [r, row] of repaired.rows.entries()) for (const [b, band] of row.bands.entries()) {
    expect(band.rect).toEqual(fixture.rows[r].bands[b].rect);
    if (missing.has(`${row.id}:${band.laneId}`)) expect(band.backgrounds.length).toBeGreaterThan(0);
    else expect(band.backgrounds).toEqual(fixture.rows[r].bands[b].backgrounds);
  }
  await undo(page).click();
  expect((await project(page)).rows).toEqual(fixture.rows);
  await expect(page.getByRole('button', { name: '补齐缺失背景', exact: true })).toBeVisible();
  await redo(page).click();
  expect((await project(page)).rows).toEqual(repaired.rows);
});

test('legacy overlap stays strict until explicitly enabled and the policy is undoable', async ({ page }) => {
  const fixture = await project(page);
  delete fixture.measurementPolicy;
  const first = fixture.rows[0].bands[0].rect;
  fixture.rows[0].bands[1].rect = { ...first, x: first.x + first.width - 8 };
  await restore(page, fixture);
  await expect(overlap(page)).not.toBeChecked();
  await expect(mode(page)).toHaveValue('subtract');
  await mode(page).selectOption('none');
  await expect(measuredRows(page).nth(0)).toContainText('相互重叠');
  await expect.poll(() => numericCount(page)).toBe(9);
  await overlap(page).check();
  await expect.poll(() => numericCount(page)).toBe(12);
  await expect(measuredRows(page).nth(0)).toContainText('重叠像素仍计入各自取样框');
  const saved = await project(page);
  expect(saved.measurementPolicy).toMatchObject({ maxBandOverlapFraction: 0.1, backgroundMode: 'none' });
  await undo(page).click();
  await expect(overlap(page)).not.toBeChecked();
  await expect.poll(() => numericCount(page)).toBe(9);
  await redo(page).click();
  await expect(overlap(page)).toBeChecked();
  await expect.poll(() => numericCount(page)).toBe(12);
  await restore(page, saved);
  await expect(overlap(page)).toBeChecked();
  await expect(mode(page)).toHaveValue('none');
  await expect.poll(() => numericCount(page)).toBe(12);
});

test('saved control choice survives imports and the leftmost shortcut uses geometry rather than lane order', async ({ page }) => {
  const fixture = await project(page);
  fixture.controlLaneId = 'lane-2';
  fixture.lanes.reverse();
  await restore(page, fixture);
  const control = page.getByLabel('对照泳道', { exact: true });
  await expect(control).toHaveValue('lane-2');
  expect((await project(page)).controlLaneId).toBe('lane-2');
  await page.getByRole('button', { name: '使用最左侧泳道', exact: true }).click();
  await expect(control).toHaveValue('lane-1');
  const saved = await project(page);
  expect(saved.controlLaneId).toBe('lane-1');
  expect(saved.lanes).toEqual(fixture.lanes);
  expect(saved.rows).toEqual(fixture.rows);
  await undo(page).click();
  await expect(control).toHaveValue('lane-2');
});

test('black pixels are neutral optional information and do not mark a valid band as clipped', async ({ page }) => {
  const fixture = await project(page);
  const blackened = await page.evaluate(async ({ source, rect }) => {
    const image = new Image();
    image.src = source.dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    context.fillStyle = '#000000';
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    const dataUrl = canvas.toDataURL('image/png');
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    return { dataUrl, sha256 };
  }, { source: fixture.source, rect: fixture.rows[0].bands[0].rect });
  Object.assign(fixture.source, blackened);
  await restore(page, fixture);
  await expect.poll(() => numericCount(page)).toBe(12);
  await expect(page.locator('body')).not.toContainText('疑似像素截断');
  await expect(measuredRows(page).nth(0)).not.toContainText('饱和');
  const information = page.locator('.pixel-information');
  await expect(information).toHaveCount(1);
  await expect(information).not.toHaveAttribute('open', '');
  await expect(information.locator('summary')).toContainText('深黑像素信息');
  await information.locator('summary').click();
  await expect(information).toHaveAttribute('open', '');
  await expect(information).toContainText(/100(?:\.0+)?%/);
  const csv = (await download(page, '测量明细 CSV')).toString().replace(/^\uFEFF/, '');
  const [header, firstRow] = csv.trim().split('\r\n').map(line => line.split(','));
  const fractionColumn = header.indexOf('near_black_pixel_fraction');
  expect(fractionColumn).toBeGreaterThanOrEqual(0);
  expect(Number(firstRow[fractionColumn])).toBe(1);
});

test('chart palettes and custom group colors change exports but preserve measurements and review status', async ({ page }) => {
  const original = await page.locator('#measurements tbody').innerText();
  await page.getByLabel('我已检查取样框、内参和对照对应关系').check();
  await page.locator('.chart-style-controls summary').click();
  await page.getByLabel('预设配色', { exact: true }).selectOption('distinct');
  await expect(page.locator('#result-chart rect[fill="#0072b2"]')).toHaveCount(5);
  await page.getByLabel('Treatment 柱状图颜色', { exact: true }).fill('#b45088');
  await expect(page.locator('#result-chart rect[fill="#b45088"]')).toHaveCount(5);
  await expect(page.getByLabel('我已检查取样框、内参和对照对应关系')).toBeChecked();
  expect(await page.locator('#measurements tbody').innerText()).toBe(original);
  const saved = await project(page);
  expect(saved.chartStyle).toEqual({ palette: 'distinct', colors: { 'lane-2': '#b45088' } });
  const svg = (await download(page, '柱状图 SVG')).toString();
  expect(svg).toContain('fill="#b45088"');
  expect(svg).toContain('fill="#0072b2"');
  await undo(page).click();
  await expect(page.getByLabel('Treatment 柱状图颜色', { exact: true })).toHaveValue('#e69f00');
  await redo(page).click();
  await expect(page.getByLabel('Treatment 柱状图颜色', { exact: true })).toHaveValue('#b45088');
  await restore(page, saved);
  expect((await project(page)).chartStyle).toEqual(saved.chartStyle);
  expect(await page.locator('#measurements tbody').innerText()).toBe(original);
  await expect(page.locator('#result-chart rect[fill="#b45088"]')).toHaveCount(5);
  if (process.env.REVIEWER_CAPTURE_COLORS === '1') {
    await page.locator('.chart-style-controls').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${import.meta.dirname}/../docs/screenshots/chart-colors.png` });
  }
  await page.getByRole('button', { name: '恢复预设颜色', exact: true }).click();
  await expect(page.getByLabel('Treatment 柱状图颜色', { exact: true })).toHaveValue('#e69f00');
  await page.getByLabel('预设配色', { exact: true }).selectOption('gray');
  await expect(page.locator('#result-chart rect[fill="#333333"]')).toHaveCount(5);
});
