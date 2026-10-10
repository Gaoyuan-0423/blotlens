import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Rect, ReviewSession } from '../src/core/types';

const roi = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const measurements = (page: Page) => page.locator('#measurements tbody tr');
const undo = (page: Page) => page.getByRole('button', { name: '撤销', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: '重做', exact: true });

async function geometry(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((name) => [name, Number(element.getAttribute(name))]),
  ) as unknown as Rect);
}
async function project(page: Page): Promise<ReviewSession> {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '可复算分析文件 JSON', exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error('Download path unavailable');
  return JSON.parse(await readFile(path, 'utf8')) as ReviewSession;
}
async function importProject(page: Page, value: ReviewSession) {
  await page.getByLabel('载入分析文件', { exact: true }).setInputFiles({
    name: 'manual-editing.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
  });
  await expect(measurements(page)).toHaveCount(value.rows.reduce((count, row) => count + row.bands.length, 0));
}
async function uploadSource(page: Page, value: ReviewSession) {
  await page.getByLabel('导入截图', { exact: true }).setInputFiles({
    name: 'manual-source.png', mimeType: 'image/png', buffer: Buffer.from(value.source.dataUrl.split(',')[1], 'base64'),
  });
  await expect(page.getByRole('heading', { name: 'manual-source.png', exact: true })).toBeVisible();
  await expect(measurements(page)).toHaveCount(0);
}
async function draw(page: Page, rect: Rect, clickOnly = false) {
  const stage = page.locator('#source-stage');
  // Wait for stable SVG bounds before mapping original-image pixels to screen pixels.
  await stage.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await stage.evaluate((element) => new Promise<void>((resolve) => {
    let previous = '', stable = 0;
    const check = () => {
      const bounds = element.getBoundingClientRect();
      const current = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  const box = await stage.boundingBox();
  const dimensions = await stage.evaluate((element) => {
    const viewBox = (element as SVGSVGElement).viewBox.baseVal;
    return { width: viewBox.width, height: viewBox.height };
  });
  if (!box) throw new Error('Source image unavailable');
  const x = box.x + rect.x / dimensions.width * box.width;
  const y = box.y + rect.y / dimensions.height * box.height;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (!clickOnly) await page.mouse.move(
    x + rect.width / dimensions.width * box.width,
    y + rect.height / dimensions.height * box.height,
    { steps: 5 },
  );
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  // All interactions use local synthetic pixels; external model calls are forbidden.
  await page.route('**/api/recognize', (route) => route.fulfill({ status: 502, json: { error: { code: 'test_guard', message: 'External recognition disabled in manual editing tests' } } }));
  await page.goto('/');
  await page.getByRole('button', { name: '先试试合成示例', exact: true }).click();
  await expect(measurements(page)).toHaveCount(15);
});

test('undo and redo restore group movement and deletion with backgrounds while preserving the audit', async ({ page }) => {
  const original = await project(page);
  const first = roi(page, 'COMP Ctrl 条带');
  const second = roi(page, 'COMP Treatment 条带');
  await expect(undo(page)).toBeDisabled();
  await first.click();
  await second.click({ modifiers: ['Shift'] });
  await page.keyboard.press('ArrowRight');
  await undo(page).click();
  expect((await project(page)).rows).toEqual(original.rows);
  await page.locator('#source-stage').focus();
  await page.keyboard.press('Control+y');
  const moved = await project(page);
  expect(moved.rows[0].bands[0].rect.x).toBe(original.rows[0].bands[0].rect.x + 1);
  expect(moved.rows[0].bands[1].rect.x).toBe(original.rows[0].bands[1].rect.x + 1);
  await first.click();
  await roi(page, 'COMP Ctrl 背景 1').click({ modifiers: ['Shift'] });
  await roi(page, 'COMP Treatment 背景 1').click({ modifiers: ['Control'] });
  await page.keyboard.press('Backspace');
  await expect(measurements(page)).toHaveCount(14);
  await expect(roi(page, 'COMP Ctrl 背景 1')).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect(measurements(page)).toHaveCount(15);
  expect((await project(page)).rows).toEqual(moved.rows);
  await page.locator('#source-stage').focus();
  await page.keyboard.press('Meta+Shift+z');
  await expect(measurements(page)).toHaveCount(14);
  await undo(page).click();
  const restored = await project(page);
  expect(restored.rows).toEqual(moved.rows);
  expect(restored.history.slice(0, original.history.length)).toEqual(original.history);
  expect(restored.history).toHaveLength(original.history.length + 7);
  expect(restored.history.slice(-4).map((edit) => edit.action)).toEqual([
    '删除 3 个取样框', '撤销上一步操作', '重做上一步操作', '撤销上一步操作',
  ]);
});

test('fresh edits clear redo and undo shortcuts do not intercept text fields or dialogs', async ({ page }) => {
  const band = roi(page, 'COMP Ctrl 条带');
  const initial = await geometry(band);
  await band.click();
  await page.keyboard.press('ArrowRight');
  await undo(page).click();
  await expect(redo(page)).toBeEnabled();
  await band.click();
  await page.keyboard.press('ArrowDown');
  await expect(redo(page)).toBeDisabled();
  const edited = { ...initial, y: initial.y + 1 };
  expect(await geometry(band)).toEqual(edited);
  await page.getByRole('button', { name: '蛋白与分组', exact: true }).click();
  const field = page.getByLabel('泳道 1 名称', { exact: true });
  await field.focus();
  await field.press('End');
  await field.pressSequentially(' modified');
  await field.press('ControlOrMeta+z');
  expect(await geometry(band)).toEqual(edited);
  await expect(redo(page)).toBeDisabled();
  // Native input undo restored the label; blur must not add a session edit.
  await field.press('Tab');
  await page.getByRole('button', { name: '新增取样框', exact: true }).click();
  await page.getByLabel('新增框类型', { exact: true }).focus();
  await page.keyboard.press('Control+z');
  expect(await geometry(band)).toEqual(edited);
  await expect(page.getByRole('dialog', { name: '新增取样框', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#source-stage').focus();
  await page.keyboard.press('Control+z');
  expect(await geometry(band)).toEqual(initial);
});

test('a missing pair can be drawn at 75 percent zoom without moving or remeasuring existing regions differently', async ({ page }) => {
  const original = await project(page);
  const row = original.rows[0];
  const missing = row.bands[1];
  const originalMeasurements = await measurements(page).allTextContents();
  await roi(page, 'COMP Treatment 条带').click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await expect(page.getByRole('button', { name: '重置视图', exact: true })).toHaveText('75%');
  await page.getByRole('button', { name: '补框：COMP / Treatment', exact: true }).click();
  await expect(page.locator('#source-stage')).toHaveClass(/drawing/);
  await draw(page, { x: missing.rect.x + missing.rect.width / 2 - 40, y: missing.rect.y + missing.rect.height / 2 - 10, width: 80, height: 20 });
  await expect(measurements(page)).toHaveCount(15);
  await expect(page.locator('#source-stage')).not.toHaveClass(/drawing/);
  const saved = await project(page);
  expect(saved.rows[0].bands[1].rect).toEqual(missing.rect);
  expect(saved.rows[0].bands.filter((band) => band.laneId !== missing.laneId)).toEqual(row.bands.filter((band) => band.laneId !== missing.laneId));
  expect(saved.rows.slice(1)).toEqual(original.rows.slice(1));
  const newMeasurements = await measurements(page).allTextContents();
  expect(newMeasurements.filter((_, index) => index !== 1)).toEqual(originalMeasurements.filter((_, index) => index !== 1));
  if (process.env.REVIEWER_CAPTURE_MANUAL === '1') {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: `${import.meta.dirname}/../docs/screenshots/manual-add-undo.png` });
  }
  await undo(page).click();
  await expect(measurements(page)).toHaveCount(14);
  await redo(page).click();
  await expect(measurements(page)).toHaveCount(15);
});

test('duplicate pairs are blocked and a click or Escape during drawing creates no extra band', async ({ page }) => {
  const original = await project(page);
  await page.getByRole('button', { name: '新增取样框', exact: true }).click();
  await page.getByLabel('新增框蛋白', { exact: true }).selectOption('comp');
  await page.getByLabel('新增框泳道', { exact: true }).selectOption('lane-1');
  await expect(page.getByRole('button', { name: '开始画框', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('已有条带');
  await page.getByLabel('新增框蛋白', { exact: true }).selectOption('__new');
  await page.getByLabel('新增框泳道', { exact: true }).selectOption('__new');
  await page.getByLabel('新增框类型', { exact: true }).selectOption('background');
  await expect(page.getByLabel('新增框蛋白', { exact: true })).toHaveValue('comp');
  await expect(page.getByLabel('新增框泳道', { exact: true })).toHaveValue('lane-1');
  await expect(page.getByRole('button', { name: '开始画框', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭新增取样框', exact: true }).click();
  await roi(page, 'COMP Treatment 条带').click();
  await page.keyboard.press('Delete');
  const deleted = await project(page);
  await page.getByRole('button', { name: '新增取样框', exact: true }).click();
  await expect(page.getByLabel('新增框蛋白', { exact: true })).toHaveValue('comp');
  await expect(page.getByLabel('新增框泳道', { exact: true })).toHaveValue('lane-2');
  await page.getByRole('button', { name: '开始画框', exact: true }).click();
  await draw(page, { x: 465, y: 160, width: 0, height: 0 }, true);
  await expect(measurements(page)).toHaveCount(14);
  await expect(page.locator('#source-stage')).toHaveClass(/drawing/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#source-stage')).not.toHaveClass(/drawing/);
  expect((await project(page)).history).toEqual(deleted.history);
  await undo(page).click();
  expect((await project(page)).rows).toEqual(original.rows);
});

test('first manual band creates explicit protein and lane, exports and reloads, and resets undo across documents', async ({ page }) => {
  const original = await project(page);
  await roi(page, 'COMP Ctrl 条带').click();
  await page.keyboard.press('ArrowRight');
  await expect(undo(page)).toBeEnabled();
  await uploadSource(page, original);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeDisabled();
  await page.getByRole('button', { name: '新增取样框', exact: true }).click();
  await expect(page.getByLabel('新增框蛋白', { exact: true })).toHaveValue('__new');
  await expect(page.getByLabel('新增框泳道', { exact: true })).toHaveValue('__new');
  await page.getByLabel('新蛋白名称', { exact: true }).fill('Manual target');
  await page.getByLabel('新泳道名称', { exact: true }).fill('Manual control');
  await page.getByRole('button', { name: '开始画框', exact: true }).click();
  const rect = { x: 211, y: 144, width: 118, height: 32 };
  await draw(page, rect);
  await expect(measurements(page)).toHaveCount(1);
  await expect(roi(page, 'Manual target Manual control 条带')).toBeVisible();
  const saved = await project(page);
  expect(saved.rows).toHaveLength(1);
  expect(saved.lanes).toHaveLength(1);
  expect(saved.rows[0]).toMatchObject({ label: 'Manual target', role: 'target', referenceRowId: null });
  expect(saved.rows[0].bands[0].rect).toEqual(rect);
  expect(saved.controlLaneId).toBe(saved.lanes[0].id);
  expect(saved.recognition).toBeNull();
  expect(saved.history.at(-1)?.action).toContain('手动新增');
  await undo(page).click();
  await expect(measurements(page)).toHaveCount(0);
  await redo(page).click();
  await expect(measurements(page)).toHaveCount(1);
  const before = await measurements(page).allTextContents();
  await importProject(page, saved);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeDisabled();
  expect(await measurements(page).allTextContents()).toEqual(before);
  expect(await project(page)).toEqual(saved);
});

test('manual additions follow the leftmost default until a user explicitly selects a control', async ({ page }) => {
  const original = await project(page);
  await uploadSource(page, original);
  const control = page.getByLabel('对照泳道', { exact: true });
  async function addLane(label: string, x: number, first = false) {
    await page.getByRole('button', { name: '新增取样框', exact: true }).click();
    if (first) await page.getByLabel('新蛋白名称', { exact: true }).fill('Manual protein');
    await page.getByLabel('新增框泳道', { exact: true }).selectOption('__new');
    await page.getByLabel('新泳道名称', { exact: true }).fill(label);
    await page.getByRole('button', { name: '开始画框', exact: true }).click();
    await draw(page, { x, y: 144, width: 118, height: 32 });
    await expect(roi(page, `Manual protein ${label} 条带`)).toBeVisible();
    const saved = await project(page);
    return saved.lanes.find(lane => lane.label === label)!.id;
  }
  const right = await addLane('First right', 601, true);
  await expect(control).toHaveValue(right);
  const left = await addLane('Second left', 406);
  await expect(control).toHaveValue(left);
  expect((await project(page)).controlLaneMode).toBe('leftmost');
  await control.selectOption(right);
  expect((await project(page)).controlLaneMode).toBe('manual');
  await addLane('Third further left', 211);
  await expect(control).toHaveValue(right);
  await undo(page).click();
  await expect(control).toHaveValue(right);
  await expect(measurements(page)).toHaveCount(2);
  await undo(page).click();
  await expect(control).toHaveValue(left);
  expect((await project(page)).controlLaneMode).toBe('leftmost');
  await undo(page).click();
  await expect(control).toHaveValue(right);
  await expect(measurements(page)).toHaveCount(1);
});

test('drawn background rejects band overlap, remains editable, and can be undone independently', async ({ page }) => {
  const original = await project(page);
  const band = original.rows[0].bands[0];
  await roi(page, 'COMP Ctrl 条带').click();
  await page.getByRole('button', { name: '画背景框', exact: true }).click();
  await draw(page, { ...band.rect, width: 30, height: 10 });
  await expect(page.getByRole('alert')).toContainText('背景取样框与条带重叠');
  await expect(page.locator('#source-stage')).toHaveClass(/drawing/);
  const background = { x: 235, y: 129, width: 50, height: 8 };
  await draw(page, background);
  await expect(page.locator('#source-stage')).not.toHaveClass(/drawing/);
  const saved = await project(page);
  expect(saved.rows[0].bands[0].rect).toEqual(band.rect);
  expect(saved.rows[0].bands[0].backgrounds).toEqual([...band.backgrounds, background]);
  expect(saved.history).toHaveLength(original.history.length + 1);
  expect(saved.history.at(-1)?.action).toContain('背景取样框');
  await undo(page).click();
  expect((await project(page)).rows).toEqual(original.rows);
  await redo(page).click();
  expect((await project(page)).rows).toEqual(saved.rows);
});

test('undo during an unfinished pointer drag discards its draft before pointer release', async ({ page }) => {
  const band = roi(page, 'COMP Ctrl 条带');
  const original = await geometry(band);
  await band.click();
  await page.keyboard.press('ArrowRight');
  const source = await page.locator('#source-stage').boundingBox();
  const box = await band.boundingBox();
  if (!source || !box) throw new Error('Source or band unavailable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + source.width * 20 / 900, box.y + box.height / 2, { steps: 3 });
  expect((await geometry(band)).x).toBe(original.x + 21);
  await page.keyboard.press('Control+z');
  await expect.poll(() => geometry(band)).toEqual(original);
  await page.mouse.up();
  await expect.poll(() => geometry(band)).toEqual(original);
  await expect(redo(page)).toBeEnabled();
  const saved = await project(page);
  expect(saved.history.slice(-2).map((edit) => edit.action)).toEqual(['调整 COMP / Ctrl 条带框；同步同一蛋白行尺寸', '撤销上一步操作']);
});
