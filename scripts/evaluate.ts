/** Local deterministic checks. Never calls a model or fabricates detection accuracy. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zlibSync } from 'fflate';
import { measureSession, parseSession, rgbaToGray } from '../src/core/index';
import { ALGORITHM_VERSION, APP_VERSION, type ReviewSession, type Rect } from '../src/core/types';
import { validateDetection } from '../shared/detection';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value after ${name}`);
  return value;
}
const records = args.flatMap((arg, index) => arg === '--record' ? [args[index + 1]] : []);
const here = dirname(fileURLToPath(import.meta.url));
const width = 96;
const height = 90;
const xs = [8, 36, 64];
const ys = [10, 36, 62];
const baselines = [10, 20, 30];
const strengths = [[40, 80, 20], [60, 30, 90], [50, 100, 25]];
const expectedRelatives = [[1, 1, 1], [1, 0.25, 3]];
const gray = new Uint8Array(width * height).fill(245);
const rect = (x: number, y: number, h = 6): Rect => ({ x, y, width: 10, height: h });
function fill(image: Uint8Array, region: Rect, value: number): void {
  for (let y = region.y; y < region.y + region.height; y += 1)
    for (let x = region.x; x < region.x + region.width; x += 1) image[y * width + x] = value;
}
for (let r = 0; r < 3; r += 1) for (let l = 0; l < 3; l += 1) {
  fill(gray, rect(xs[l], ys[r]), 255 - baselines[l] - strengths[r][l]);
  fill(gray, rect(xs[l], ys[r] - 4, 2), 255 - (baselines[l] - 4));
  fill(gray, rect(xs[l], ys[r] + 8, 2), 255 - (baselines[l] + 4));
}

// Encode an 8-bit grayscale PNG without using the application decoder or measurement code.
function uint32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}
function bytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => { output.set(part, offset); offset += part.length; });
  return output;
}
function chunk(name: string, data: Uint8Array): Uint8Array {
  const body = bytes(new TextEncoder().encode(name), data);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return bytes(uint32(data.length), body, uint32((crc ^ 0xffffffff) >>> 0));
}
const scanlines = new Uint8Array((width + 1) * height);
for (let y = 0; y < height; y += 1) scanlines.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
const png = bytes(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
  chunk('IHDR', bytes(uint32(width), uint32(height), Uint8Array.of(8, 0, 0, 0, 0))),
  chunk('IDAT', zlibSync(scanlines)), chunk('IEND', new Uint8Array()));
const session: ReviewSession = {
  format: 'wb-review', schemaVersion: 1, appVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION,
  source: { name: 'independent-rectangular-truth.png', width, height,
    dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    sha256: createHash('sha256').update(png).digest('hex') },
  panel: { x: 0, y: 0, width, height },
  lanes: xs.map((_, i) => ({ id: `lane-${i + 1}`, label: `Lane ${i + 1}` })),
  rows: ys.map((y, r) => ({
    id: `row-${r + 1}`, label: r === 2 ? 'Reference' : `Target ${r + 1}`,
    role: r === 2 ? 'reference' : 'target', referenceRowId: r === 2 ? null : 'row-3',
    bands: xs.map((x, l) => ({ laneId: `lane-${l + 1}`, rect: rect(x, y),
      backgrounds: [rect(x, y - 4, 2), rect(x, y + 8, 2)], warnings: [] })),
  })),
  controlLaneId: 'lane-1', reviewed: false, warnings: [], recognition: null, history: [],
  createdAt: '2026-10-10T00:00:00.000Z',
};
const measurements = measureSession(session, gray);
let assertions = 0;
function equal(actual: unknown, expected: unknown, message: string): void {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}
for (let r = 0; r < 3; r += 1) for (let l = 0; l < 3; l += 1) {
  const measured = measurements.find((value) => value.rowId === `row-${r + 1}` && value.laneId === `lane-${l + 1}`)!;
  equal(measured.area, 60, 'known rectangular area');
  equal(measured.bandSum, 60 * (baselines[l] + strengths[r][l]), 'known raw sum');
  equal(measured.backgroundMean, baselines[l], 'pooled unequal background levels');
  equal(measured.net, 60 * strengths[r][l], 'known net signal');
  if (r < 2) equal(measured.relative, expectedRelatives[r][l], 'lane-paired normalization');
}
const invalid = gray.slice();
fill(invalid, rect(xs[1], ys[2]), 255 - baselines[1]);
equal(measureSession(session, invalid).find((m) => m.rowId === 'row-1' && m.laneId === 'lane-2')?.relative,
  null, 'zero reference must not produce a numeric relative value');
const negative = gray.slice();
fill(negative, rect(xs[1], ys[0]), 255);
const negativeMeasurement = measureSession(session, negative).find((m) => m.rowId === 'row-1' && m.laneId === 'lane-2')!;
equal(negativeMeasurement.net, -1200, 'negative net must remain visible');
equal(negativeMeasurement.relative, null, 'negative net is not a usable fold estimate');
equal(Array.from(rgbaToGray(new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]))),
  [255, 76, 150, 29], 'white alpha composition and specified grayscale weights');

const fixtureChecks = [1, 2].map((number) => {
  const fixture = JSON.parse(readFileSync(join(here, `../tests/fixtures/example${number}-detection.json`), 'utf8'));
  validateDetection(fixture.detection);
  equal(fixture.fixtureKind, 'HUMAN_AUTHORED_MOCK_NOT_MODEL_OUTPUT', 'fixture provenance');
  equal(fixture.detection.rows.length, 5, 'manual fixture protein rows');
  equal(fixture.detection.lanes.length, number + 1, 'manual fixture lanes');
  for (const row of fixture.detection.rows) for (const band of row.bands) {
    assert(band.rect.x >= 0 && band.rect.y >= 0 && band.rect.x + band.rect.width <= 1 && band.rect.y + band.rect.height <= 1);
    assertions += 1;
  }
  return { name: `example${number}`, rows: 5, lanes: number + 1, status: 'manual-fixture-shape-checked',
    liveRecognition: false, screenshotPixelsBundled: false };
});

let imagej: Record<string, unknown> = { status: 'not-run', reason: 'Pass --imagej-jar /path/to/ij.jar to request a real external comparison.' };
const imagejJar = option('--imagej-jar');
if (imagejJar) {
  const directory = mkdtempSync(join(tmpdir(), 'wb-review-imagej-'));
  try {
    const pngPath = join(directory, 'truth.png');
    const macroPath = join(directory, 'compare.ijm');
    writeFileSync(pngPath, png);
    const macro = [`setBatchMode(true);`, `open(${JSON.stringify(pngPath)});`, `print("WB_VERSION\\t" + getVersion());`];
    for (let r = 0; r < 3; r += 1) for (let l = 0; l < 3; l += 1) {
      const x = xs[l], y = ys[r];
      macro.push(`makeRectangle(${x},${y},10,6); getRawStatistics(n,bm); sum=n*(255-bm);`,
        `makeRectangle(${x},${y - 4},10,2); getRawStatistics(n1,b1);`,
        `makeRectangle(${x},${y + 8},10,2); getRawStatistics(n2,b2);`,
        `bg=(n1*(255-b1)+n2*(255-b2))/(n1+n2); net=sum-60*bg;`,
        `print("WB_RESULT\\t${r}\\t${l}\\t"+d2s(sum,8)+"\\t"+d2s(bg,8)+"\\t"+d2s(net,8));`);
    }
    macro.push('close();');
    writeFileSync(macroPath, macro.join('\n'));
    // ImageJ 1.x initializes AWT menus even in macro batch mode; forcing java.awt.headless
    // breaks IJ.open(). Batch mode suppresses image windows but still needs an AWT-capable host.
    const run = spawnSync('java', ['-jar', resolve(imagejJar), '-batch', macroPath],
      { encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    if (run.error || run.status !== 0) throw new Error(`ImageJ execution failed: ${run.error?.message ?? run.stderr}`);
    const output = run.stdout.split(/\r?\n/).filter((line) => line.startsWith('WB_RESULT\t'));
    if (output.length !== 9) throw new Error(`ImageJ did not return 9 result rows. stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`);
    equal(output.length, 9, 'ImageJ returned every ROI');
    let maximumAbsoluteDifference = 0;
    const comparisons = output.map((line) => {
      const [, rText, lText, sum, background, net] = line.split('\t');
      const r = Number(rText), l = Number(lText);
      const actual = measurements.find((m) => m.rowId === `row-${r + 1}` && m.laneId === `lane-${l + 1}`)!;
      for (const [a, b] of [[actual.bandSum, Number(sum)], [actual.backgroundMean!, Number(background)], [actual.net!, Number(net)]]) {
        maximumAbsoluteDifference = Math.max(maximumAbsoluteDifference, Math.abs(a - b));
        assert(Math.abs(a - b) <= 1e-8, 'fixed-ROI ImageJ comparison');
        assertions += 1;
      }
      return { row: r + 1, lane: l + 1, bandSum: Number(sum), backgroundMean: Number(background), net: Number(net) };
    });
    imagej = { status: 'passed', version: run.stdout.split(/\r?\n/).find((line) => line.startsWith('WB_VERSION\t'))?.split('\t')[1],
      imageSha256: session.source.sha256, roiCount: 9, maximumAbsoluteDifference, comparisons,
      scope: 'Independent ImageJ fixed-ROI raw sum, pooled background mean and net signal on an 8-bit synthetic PNG. Does not validate OCR, automatic ROI placement or biological accuracy.' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const recordSummaries = records.map((filename) => {
  const record = parseSession(readFileSync(filename, 'utf8'));
  const baseline = record.history[0]?.rows;
  let changedBandRectsSinceFirstSnapshot = 0;
  if (baseline) for (const row of record.rows) for (const band of row.bands) {
    const old = baseline.find((entry) => entry.id === row.id)?.bands.find((entry) => entry.laneId === band.laneId);
    if (!old || JSON.stringify(old.rect) !== JSON.stringify(band.rect)) changedBandRectsSinceFirstSnapshot += 1;
  }
  return { file: filename, sourceSha256: record.source.sha256, rows: record.rows.length, lanes: record.lanes.length,
    historySnapshots: record.history.length, changedBandRectsSinceFirstSnapshot: baseline ? changedBandRectsSinceFirstSnapshot : null,
    reviewed: record.reviewed, hasRecognitionRecord: record.recognition !== null,
    note: 'Counts describe saved edits, not accuracy. The first saved history snapshot may differ from initial model output.' };
});
const report = {
  executedAt: new Date().toISOString(), applicationVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION,
  node: process.version, platform: process.platform, arch: process.arch,
  sourceHashes: Object.fromEntries(['scripts/evaluate.ts', 'src/core/index.ts', 'src/core/types.ts', 'shared/detection.ts'].map((file) =>
    [file, createHash('sha256').update(readFileSync(join(here, '..', file))).digest('hex')])),
  status: 'passed', assertions, numericTruth: { roiCount: 9, targetFoldEstimates: expectedRelatives },
  fixtureChecks, imagej, savedRecords: recordSummaries,
  exclusions: ['No model endpoint called', 'No claim of automatic detection accuracy', 'No biological or peer-review effectiveness validation'],
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (option('--out')) writeFileSync(resolve(option('--out')!), serialized);
process.stdout.write(serialized);
