import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Rect, ReviewSession } from '../src/core/types';

const roi = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const selected = (page: Page) => page.locator('#source-stage [role="button"][aria-pressed="true"]');
const measurements = (page: Page) => page.locator('#measurements tbody tr');

async function geometry(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((name) => [name, Number(element.getAttribute(name))]),
  ) as unknown as Rect);
}
async function savedProject(page: Page): Promise<ReviewSession> {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '可复算分析文件 JSON', exact: true }).click();
  const item = await pending;
  expect(await item.failure()).toBeNull();
  const path = await item.path();
  if (!path) throw new Error('Download path is unavailable');
  return JSON.parse(await readFile(path, 'utf8')) as ReviewSession;
}
async function restore(page: Page, value: ReviewSession) {
  await page.getByLabel('载入分析文件', { exact: true }).setInputFiles({
    name: 'interaction-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
  });
  await expect(measurements(page)).toHaveCount(value.rows.reduce((count, row) => count + row.bands.length, 0));
}

test.beforeEach(async ({ page }) => {
  // These regressions use only the local synthetic example. Never contact a model.
  await page.route('**/api/recognize', (route) => route.fulfill({ status: 502, json: { error: { code: 'test_guard', message: 'External recognition disabled in interaction tests' } } }));
  await page.goto('/');
  await page.getByRole('button', { name: '先试试合成示例', exact: true }).click();
  await expect(measurements(page)).toHaveCount(15);
});

test('Shift, Ctrl and Cmd clicks select or toggle ROIs, and Escape clears selection', async ({ page }) => {
  const first = roi(page, 'COMP Ctrl 条带');
  const second = roi(page, 'COMP Treatment 条带');
  const third = roi(page, 'COMP Rescue 条带');
  await first.click();
  await second.click({ modifiers: ['Shift'] });
  await expect(selected(page)).toHaveCount(2);
  await third.click({ modifiers: ['Control'] });
  await expect(selected(page)).toHaveCount(3);
  await second.click({ modifiers: ['Meta'] });
  await expect(selected(page)).toHaveCount(2);
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(selected(page)).toHaveCount(0);
});

test('arrow keys move a selection together, recalculate pixels and survive audited JSON roundtrip', async ({ page }) => {
  const first = roi(page, 'COMP Ctrl 条带');
  const second = roi(page, 'COMP Treatment 条带');
  const before = await Promise.all([geometry(first), geometry(second)]);
  const other = await geometry(roi(page, 'COMP Rescue 条带'));
  const signalBefore = await measurements(page).nth(1).locator('td').nth(2).innerText();
  await first.click();
  await second.click({ modifiers: ['Shift'] });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  for (const [index, item] of [first, second].entries()) {
    expect(await geometry(item)).toEqual({ ...before[index], x: before[index].x + 1, y: before[index].y - 10 });
  }
  expect(await geometry(roi(page, 'COMP Rescue 条带'))).toEqual(other);
  await expect(measurements(page).nth(1).locator('td').nth(2)).not.toHaveText(signalBefore);
  const values = await page.locator('#measurements tbody').innerText();
  const saved = await savedProject(page);
  expect(saved.history.at(-1)?.action).toContain('整体移动 2 个取样框');
  expect(saved.rows[0].bands[0].rect).toEqual({ ...before[0], x: before[0].x + 1, y: before[0].y - 10 });
  await restore(page, saved);
  expect(await page.locator('#measurements tbody').innerText()).toBe(values);
  expect((await savedProject(page)).rows).toEqual(saved.rows);
});

test('group movement is clamped as a unit at image edges, preserving spacing and dimensions', async ({ page }) => {
  const fixture = await savedProject(page);
  fixture.rows[0].bands[0].rect.x = 2;
  fixture.rows[0].bands[1].rect.x = 197;
  await restore(page, fixture);
  const first = roi(page, 'COMP Ctrl 条带');
  const second = roi(page, 'COMP Treatment 条带');
  const before = await Promise.all([geometry(first), geometry(second)]);
  await first.click();
  await second.click({ modifiers: ['Control'] });
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await geometry(first)).toEqual({ ...before[0], x: 0 });
  expect(await geometry(second)).toEqual({ ...before[1], x: 195 });
  await page.keyboard.press('ArrowLeft');
  expect(await geometry(first)).toEqual({ ...before[0], x: 0 });
  expect(await geometry(second)).toEqual({ ...before[1], x: 195 });
});

test('zoom shrinks the visible source, respects limits and keeps measurements and original-pixel keyboard steps', async ({ page }) => {
  const stage = page.locator('#source-stage');
  const initial = await stage.boundingBox();
  if (!initial) throw new Error('Missing source stage');
  const before = await page.locator('#measurements tbody').innerText();
  const shrink = page.getByRole('button', { name: '缩小', exact: true });
  const grow = page.getByRole('button', { name: '放大', exact: true });
  const reset = page.getByRole('button', { name: '重置视图', exact: true });
  await shrink.click();
  await expect(reset).toHaveText('75%');
  const reduced = await stage.boundingBox();
  expect(reduced?.width).toBeCloseTo(initial.width * 0.75, 0);
  if (process.env.REVIEWER_CAPTURE_SELECTION === '1') {
    await roi(page, 'COMP Ctrl 条带').click();
    await roi(page, 'COMP Treatment 条带').click({ modifiers: ['Shift'] });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${import.meta.dirname}/../docs/screenshots/selection-controls.png` });
    await page.keyboard.press('Escape');
  }
  await shrink.click();
  await shrink.click();
  await expect(reset).toHaveText('25%');
  await expect(shrink).toBeDisabled();
  expect(await page.locator('#measurements tbody').innerText()).toBe(before);
  const first = roi(page, 'COMP Ctrl 条带');
  const rect = await geometry(first);
  await first.click();
  await page.keyboard.press('ArrowRight');
  expect(await geometry(first)).toEqual({ ...rect, x: rect.x + 1 });
  await reset.click();
  await expect(reset).toHaveText('100%');
  expect((await stage.boundingBox())?.width).toBeCloseTo(initial.width, 0);
  for (let step = 0; step < 8; step++) await grow.click();
  await expect(reset).toHaveText('300%');
  await expect(grow).toBeDisabled();
  await reset.click();
  await expect(reset).toHaveText('100%');
});

test('dragging one selected ROI moves the selected group by the same image-pixel delta', async ({ page }) => {
  const first = roi(page, 'COMP Ctrl 条带');
  const second = roi(page, 'COMP Treatment 条带');
  const before = await Promise.all([geometry(first), geometry(second)]);
  await first.click();
  await second.click({ modifiers: ['Shift'] });
  const stage = await page.locator('#source-stage').boundingBox();
  const box = await second.boundingBox();
  if (!stage || !box) throw new Error('Missing rendered ROI');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + stage.width * 15 / 900, box.y + box.height / 2 + stage.height * 7 / 650, { steps: 4 });
  await page.mouse.up();
  for (const [index, item] of [first, second].entries()) {
    expect(await geometry(item)).toEqual({ ...before[index], x: before[index].x + 15, y: before[index].y + 7 });
  }
  await expect(selected(page)).toHaveCount(2);
});

test('Backspace removes nonadjacent backgrounds without deleting shifted indexes', async ({ page }) => {
  const fixture = await savedProject(page);
  const backgrounds = [125, 130, 135].map((y) => ({ x: 220, y, width: 40, height: 3 }));
  fixture.rows[0].bands[0].backgrounds = backgrounds;
  await restore(page, fixture);
  await roi(page, 'COMP Ctrl 背景 1').click();
  await roi(page, 'COMP Ctrl 背景 3').click({ modifiers: ['Control'] });
  await page.keyboard.press('Backspace');
  await expect(roi(page, 'COMP Ctrl 背景 2')).toHaveCount(0);
  await expect(roi(page, 'COMP Ctrl 背景 3')).toHaveCount(0);
  await expect(roi(page, 'COMP Ctrl 条带')).toHaveCount(1);
  expect(await geometry(roi(page, 'COMP Ctrl 背景 1'))).toEqual(backgrounds[1]);
  await expect(measurements(page)).toHaveCount(15);
  const saved = await savedProject(page);
  expect(saved.rows[0].bands[0].backgrounds).toEqual([backgrounds[1]]);
  expect(saved.history.at(-1)?.action).toContain('删除 2 个取样框');
});

test('Delete handles a band and its background together without removing another lane', async ({ page }) => {
  const original = await savedProject(page);
  await roi(page, 'COMP Ctrl 条带').click();
  await roi(page, 'COMP Ctrl 背景 1').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  await expect(roi(page, 'COMP Ctrl 条带')).toHaveCount(0);
  await expect(roi(page, 'COMP Ctrl 背景 1')).toHaveCount(0);
  await expect(measurements(page)).toHaveCount(14);
  const saved = await savedProject(page);
  expect(saved.rows[0].bands).toEqual(original.rows[0].bands.slice(1));
  expect(saved.rows.slice(1)).toEqual(original.rows.slice(1));
});

test('Backspace and arrow keys in form inputs edit text without moving or deleting a selected ROI', async ({ page }) => {
  const first = roi(page, 'COMP Ctrl 条带');
  const before = await geometry(first);
  await first.click();
  await page.getByRole('button', { name: '蛋白与分组', exact: true }).click();
  const field = page.getByLabel('泳道 1 名称', { exact: true });
  await field.focus();
  await field.press('End');
  await field.press('Backspace');
  await field.press('ArrowLeft');
  await expect(field).toHaveValue('Ctr');
  await expect(measurements(page)).toHaveCount(15);
  // Text fields commit on blur; both pre- and post-commit names are supported here.
  await field.press('Tab');
  const renamed = roi(page, 'COMP Ctr 条带');
  await expect(renamed).toHaveCount(1);
  expect(await geometry(renamed)).toEqual(before);
  expect((await savedProject(page)).rows[0].bands).toHaveLength(3);
});

test('missing control is one actionable summary; panel repair clears current geometry reminders', async ({ page }) => {
  const fixture = await savedProject(page);
  fixture.controlLaneId = null;
  fixture.panel.width = 300;
  await restore(page, fixture);
  await expect(page.getByText('先指定对照泳道', { exact: true })).toHaveCount(1);
  await expect(page.locator('#measurements .relative-value').filter({ hasText: '—' })).toHaveCount(15);
  const advisories = page.locator('.quality-advisories');
  await expect(advisories).not.toHaveAttribute('open', '');
  await advisories.locator('summary').click();
  await expect(advisories).toContainText('WB 区域');
  const rectBefore = await geometry(roi(page, 'COMP Rescue 条带'));
  await page.getByRole('button', { name: '按当前取样框更新 WB 区域', exact: true }).click();
  await expect(page.getByRole('button', { name: '按当前取样框更新 WB 区域', exact: true })).toHaveCount(0);
  expect(await geometry(roi(page, 'COMP Rescue 条带'))).toEqual(rectBefore);
  await page.getByLabel('对照泳道', { exact: true }).selectOption('lane-1');
  await expect(page.getByText('先指定对照泳道', { exact: true })).toHaveCount(0);
  await expect(page.locator('#measurements .relative-value').filter({ hasText: '—' })).toHaveCount(3);
});
