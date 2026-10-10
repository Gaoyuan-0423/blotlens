import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Detection, Rect, RecognitionResult, ReviewSession } from '../src/core/types';

const crop = { x: 120, y: 70, width: 600, height: 490 };
const metadata = { providerBaseUrl: 'https://region-fixture.invalid/v1', model: 'crop-fixture-not-live-ai',
  promptVersion: 'region-e2e-fixture', createdAt: '2026-10-11T00:00:00.000Z' };
const measuredRows = (page: Page) => page.locator('#measurements tbody tr');

async function project(page: Page): Promise<ReviewSession> {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '可复算分析文件 JSON', exact: true }).click();
  const item = await pending;
  expect(await item.failure()).toBeNull();
  const path = await item.path();
  if (!path) throw new Error('Download path unavailable');
  return JSON.parse(await readFile(path, 'utf8')) as ReviewSession;
}

async function importCropFixture(page: Page): Promise<ReviewSession> {
  const fixture = await project(page);
  fixture.panel = { ...crop };
  fixture.source.name = 'region-recognition-synthetic.png';
  await page.getByLabel('载入分析文件', { exact: true }).setInputFiles({ name: 'region-recognition-fixture.json',
    mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await expect(page.getByRole('heading', { name: fixture.source.name, exact: true })).toBeVisible();
  await expect(measuredRows(page)).toHaveCount(15);
  return fixture;
}

function cropDetection(fixture: ReviewSession, firstLabel = 'CROPPED-COMP'): Detection {
  return {
    panel: { x: 0, y: 0, width: 1, height: 1 },
    lanes: structuredClone(fixture.lanes), controlLaneId: fixture.controlLaneId, warnings: ['Human-authored mock layout; not a recognition accuracy evaluation'],
    rows: fixture.rows.map((row, index) => ({ id: row.id, label: index === 0 ? firstLabel : row.label,
      role: row.role, referenceRowId: row.referenceRowId, bands: row.bands.map(band => ({ laneId: band.laneId,
        rect: { x: (band.rect.x - crop.x) / crop.width, y: (band.rect.y - crop.y) / crop.height,
          width: band.rect.width / crop.width, height: band.rect.height / crop.height } })) })),
  };
}

function response(detection: Detection): RecognitionResult {
  return { ...metadata, detection, rawResponse: JSON.stringify(detection) };
}

async function drawPanel(page: Page, rect: Rect) {
  await page.getByRole('button', { name: '框选 WB 区域', exact: true }).click();
  const stage = page.locator('#source-stage');
  await stage.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await stage.evaluate(element => new Promise<void>(resolve => {
    let previous = '', stable = 0;
    const check = () => {
      const bounds = element.getBoundingClientRect();
      const current = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) resolve(); else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  const box = await stage.boundingBox();
  const dimensions = await stage.evaluate(element => {
    const value = (element as SVGSVGElement).viewBox.baseVal;
    return { width: value.width, height: value.height };
  });
  if (!box) throw new Error('Source stage unavailable');
  const start = { x: box.x + rect.x * box.width / dimensions.width, y: box.y + rect.y * box.height / dimensions.height };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + rect.width * box.width / dimensions.width, start.y + rect.height * box.height / dimensions.height, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/WB 区域已更新。点击/)).toBeVisible();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test.beforeEach(async ({ page }) => {
  // All routes are intercepted before the page opens. No credentials or live
  // provider are involved, even if a test-specific response is missing.
  await page.route('**/api/config', route => route.fulfill({ json: { baseUrl: metadata.providerBaseUrl, model: metadata.model, keyConfigured: true } }));
  await page.route('**/api/recognize', route => route.fulfill({ status: 502,
    json: { error: { code: 'test_guard', message: 'External recognition disabled in region tests' } } }));
  await page.goto('/');
  await page.getByRole('button', { name: '先试试合成示例', exact: true }).click();
  await expect(measuredRows(page)).toHaveCount(15);
});

test('selected region sends original crop pixels and maps model boxes back while preserving the complete source and crop audit', async ({ page }) => {
  const fixture = await importCropFixture(page);
  const detection = cropDetection(fixture);
  // Model panel bounds enclose only strips, whereas the selected input also
  // includes labels. The model's narrower panel must not shrink future crops.
  const modelRects = detection.rows.flatMap(row => row.bands.map(band => band.rect));
  const left = Math.max(0, Math.min(...modelRects.map(rect => rect.x)) - 5 / crop.width);
  const top = Math.max(0, Math.min(...modelRects.map(rect => rect.y)) - 5 / crop.height);
  const right = Math.min(1, Math.max(...modelRects.map(rect => rect.x + rect.width)) + 5 / crop.width);
  const bottom = Math.min(1, Math.max(...modelRects.map(rect => rect.y + rect.height)) + 5 / crop.height);
  detection.panel = { x: left, y: top, width: right - left, height: bottom - top };
  expect(detection.panel.width).toBeLessThan(1);
  expect(detection.panel.height).toBeLessThan(1);
  let image: { dataUrl: string; width: number; height: number } | undefined;
  const inputs: { dataUrl: string; width: number; height: number }[] = [];
  await page.route('**/api/recognize', async route => {
    const payload = route.request().postDataJSON();
    expect(Object.keys(payload)).toEqual(['image']);
    image = payload.image;
    inputs.push(payload.image);
    await route.fulfill({ json: response(detection) });
  });
  // Preview adjustments must not change the cropped pixels sent to the model.
  await page.getByLabel('预览对比度', { exact: true }).focus();
  await page.getByLabel('预览对比度', { exact: true }).press('End');
  await page.getByRole('button', { name: '识别框选区域', exact: true }).click();
  await expect(measuredRows(page).first()).toContainText('CROPPED-COMP');
  expect(image).toMatchObject({ width: crop.width, height: crop.height });
  const bytes = Buffer.from(image!.dataUrl.split(',')[1], 'base64');
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.readUInt32BE(16)).toBe(crop.width);
  expect(bytes.readUInt32BE(20)).toBe(crop.height);
  const differingChannels = await page.evaluate(async ({ originalUrl, croppedUrl, crop }) => {
    const decode = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url;
    });
    const [original, cropped] = await Promise.all([decode(originalUrl), decode(croppedUrl)]);
    const originalCanvas = document.createElement('canvas'); originalCanvas.width = original.naturalWidth; originalCanvas.height = original.naturalHeight;
    const originalContext = originalCanvas.getContext('2d')!; originalContext.drawImage(original, 0, 0);
    const expected = originalContext.getImageData(crop.x, crop.y, crop.width, crop.height).data;
    const inputCanvas = document.createElement('canvas'); inputCanvas.width = cropped.naturalWidth; inputCanvas.height = cropped.naturalHeight;
    const inputContext = inputCanvas.getContext('2d')!; inputContext.drawImage(cropped, 0, 0);
    const actual = inputContext.getImageData(0, 0, crop.width, crop.height).data;
    return actual.reduce((count, value, index) => count + Number(value !== expected[index]), 0);
  }, { originalUrl: fixture.source.dataUrl, croppedUrl: image!.dataUrl, crop });
  expect(differingChannels).toBe(0);
  const saved = await project(page);
  expect(saved.source).toEqual(fixture.source);
  expect(saved.panel).toEqual(crop);
  expect(saved.recognition).toMatchObject({ ...metadata, inputRegion: crop, rawResponse: JSON.stringify(detection) });
  expect(saved.history.at(-1)?.action).toContain('识别框选 WB 区域');
  for (const [rowIndex, row] of saved.rows.entries()) for (const [bandIndex, band] of row.bands.entries()) {
    const original = fixture.rows[rowIndex].bands[bandIndex].rect;
    expect(band.rect.width).toBe(original.width);
    expect(band.rect.height).toBe(original.height);
    // Local refinement can shift a box by a pixel; mapping must still land on
    // its original whole-image band, not near the crop-relative coordinates.
    expect(Math.abs(band.rect.x - original.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(band.rect.y - original.y)).toBeLessThanOrEqual(2);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
  const completed = page.waitForResponse(reply => reply.url().endsWith('/api/recognize'));
  await page.getByRole('button', { name: '识别框选区域', exact: true }).click();
  await completed;
  await expect(page.getByRole('button', { name: '取消识别', exact: true })).toHaveCount(0);
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);
  const repeated = await project(page);
  expect(repeated.panel).toEqual(crop);
  expect(repeated.recognition?.inputRegion).toEqual(crop);
  expect(repeated.recognition?.rawResponse).toBe(JSON.stringify(detection));
  expect(repeated.source).toEqual(fixture.source);
});

test('cancel and a newly drawn WB region prevent stale crop responses from changing current work', async ({ page }) => {
  const fixture = await importCropFixture(page);
  const pending = [0, 1].map(() => ({ started: deferred(), release: deferred(), handled: deferred() }));
  let attempt = 0;
  const stale = response(cropDetection(fixture, 'STALE-CROP-MUST-NOT-APPEAR'));
  await page.route('**/api/recognize', async route => {
    const slot = pending[attempt++];
    slot.started.resolve();
    await slot.release.promise;
    try { await route.fulfill({ json: stale }); } catch { /* Browser may close an aborted request. */ }
    finally { slot.handled.resolve(); }
  });
  await page.getByRole('button', { name: '识别框选区域', exact: true }).click();
  await pending[0].started.promise;
  await page.getByRole('button', { name: '取消识别', exact: true }).click();
  pending[0].release.resolve(); await pending[0].handled.promise;
  expect((await project(page)).rows).toEqual(fixture.rows);
  await page.getByRole('button', { name: '识别框选区域', exact: true }).click();
  await pending[1].started.promise;
  const changed = { x: 160, y: 100, width: 570, height: 440 };
  await drawPanel(page, changed);
  const afterDraw = await project(page);
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(afterDraw.panel[key] - changed[key])).toBeLessThanOrEqual(1);
  expect(afterDraw.rows).toEqual(fixture.rows);
  pending[1].release.resolve(); await pending[1].handled.promise;
  const afterLateResponse = await project(page);
  expect(afterLateResponse).toEqual(afterDraw);
  expect(afterLateResponse.source).toEqual(fixture.source);
  expect(afterLateResponse.recognition).toBeNull();
  await expect(page.getByText('STALE-CROP-MUST-NOT-APPEAR', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消识别', exact: true })).toHaveCount(0);
});
