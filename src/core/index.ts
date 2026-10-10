import { z } from 'zod';
import { leftmostLaneId } from '../control-lane';
import { ALGORITHM_VERSION, APP_VERSION, DEFAULT_MEASUREMENT_POLICY } from './types';
import type { Band, BandMeasurement, Detection, ProteinRow, Rect, RecognitionResult, ReviewSession, SourceImage } from './types';
export * from './types';

const MAX_PIXELS = 20_000_000;
const MAX_DOCUMENT_LENGTH = 30 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 10_000;
const clone = <T,>(value: T): T => structuredClone(value);
const unique = (values: string[]) => new Set(values).size === values.length;
const dedupe = (values: string[]) => [...new Set(values)];
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const INITIAL_MODEL_GEOMETRY_WARNING = '定位异常：模型条带框超出 WB 区域，已限定到区域内，请检查';
const INITIAL_BACKGROUND_WARNING = '未找到足够干净的邻近背景，请手动指定';
const INITIAL_GRID_WARNING = '人工初始网格：请对齐条带并确认背景区域';

/** Clear superseded draft notes on an explicitly edited band, not measured quality checks. */
export function refreshManualBandWarnings(band: Band, kind: 'band' | 'background'): void {
  band.warnings = band.warnings.filter(warning => warning !== INITIAL_GRID_WARNING
    && warning !== INITIAL_BACKGROUND_WARNING
    && (kind !== 'band' || warning !== INITIAL_MODEL_GEOMETRY_WARNING));
}

export function rectWithinImage(rect: Rect, width: number, height: number): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= width && rect.y + rect.height <= height;
}

/** White compositing is performed before the single, final grayscale rounding. */
export function rgbaToGray(rgba: Uint8ClampedArray): Uint8Array {
  if (rgba.length % 4 !== 0) throw new Error('RGBA 数据长度无效');
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const alpha = rgba[i + 3] / 255;
    const r = rgba[i] * alpha + 255 * (1 - alpha);
    const g = rgba[i + 1] * alpha + 255 * (1 - alpha);
    const b = rgba[i + 2] * alpha + 255 * (1 - alpha);
    gray[j] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return gray;
}

function pixels(rect: Rect, width: number, visit: (index: number) => void): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) visit(y * width + x);
  }
}

function statistics(rect: Rect, gray: Uint8Array, width: number) {
  let sum = 0, sumSquared = 0, black = 0;
  const area = rect.width * rect.height;
  pixels(rect, width, index => {
    const signal = 255 - gray[index];
    sum += signal;
    sumSquared += signal * signal;
    if (gray[index] <= 1) black++;
  });
  const mean = sum / area;
  return { sum, mean, std: Math.sqrt(Math.max(0, sumSquared / area - mean * mean)), blackFraction: black / area };
}

function backgroundStatistics(rects: Rect[], gray: Uint8Array, width: number) {
  // Union scan-line intervals rather than storing one Set entry per pixel. A
  // user-drawn large background stays bounded in memory even on a large image.
  const edges = [...new Set(rects.flatMap(rect => [rect.y, rect.y + rect.height]))].sort((a, b) => a - b);
  let area = 0, sum = 0, sumSquared = 0;
  for (let edge = 0; edge < edges.length - 1; edge++) {
    const top = edges[edge], bottom = edges[edge + 1];
    const intervals = rects.filter(rect => rect.y <= top && rect.y + rect.height >= bottom)
      .map(rect => [rect.x, rect.x + rect.width]).sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
      else merged.push(interval);
    }
    for (const [left, right] of merged) {
      area += (right - left) * (bottom - top);
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const signal = 255 - gray[y * width + x];
        sum += signal; sumSquared += signal * signal;
      }
    }
  }
  return { area, sum, sumSquared };
}

/** Measure the union of overlaps so pixels shared by 3+ boxes count only once. */
function overlappedArea(rect: Rect, others: Rect[]): number {
  const intersections = others.filter(other => overlap(rect, other)).map(other => {
    const x = Math.max(rect.x, other.x), y = Math.max(rect.y, other.y);
    return { x, y, width: Math.min(rect.x + rect.width, other.x + other.width) - x,
      height: Math.min(rect.y + rect.height, other.y + other.height) - y };
  });
  const edges = [...new Set(intersections.flatMap(item => [item.y, item.y + item.height]))].sort((a, b) => a - b);
  let area = 0;
  for (let edge = 0; edge < edges.length - 1; edge++) {
    const top = edges[edge], bottom = edges[edge + 1];
    const intervals = intersections.filter(item => item.y <= top && item.y + item.height >= bottom)
      .map(item => [item.x, item.x + item.width]).sort((a, b) => a[0] - b[0]);
    let left = 0, right = 0;
    for (const interval of intervals) {
      if (interval[0] > right) { area += (right - left) * (bottom - top); [left, right] = interval; }
      else right = Math.max(right, interval[1]);
    }
    area += (right - left) * (bottom - top);
  }
  return area;
}

/** All numerical outputs use original pixels. Invalid denominators remain null. */
export function measureSession(session: ReviewSession, gray: Uint8Array): BandMeasurement[] {
  const { width, height } = session.source;
  if (gray.length !== width * height) throw new Error('灰度像素数量与原图尺寸不一致');
  const allBands = session.rows.flatMap(row => row.bands);
  const bandRows = new Map(session.rows.flatMap(row => row.bands.map(band => [band, row.id] as const)));
  const maxBandOverlapFraction = session.measurementPolicy?.maxBandOverlapFraction ?? 0;
  const backgroundMode = session.measurementPolicy?.backgroundMode ?? 'subtract';
  const results = session.rows.flatMap(row => row.bands.map(band => {
    const result: BandMeasurement = {
      rowId: row.id, laneId: band.laneId, area: band.rect.width * band.rect.height,
      bandSum: 0, nearBlackFraction: null, backgroundMean: null, net: null, referenceNet: null, ratio: null, relative: null,
      // This records what automatic background search found at recognition time.
      // Current missing/invalid/overlapping backgrounds are checked below instead.
      warnings: band.warnings.filter(warning => warning !== INITIAL_BACKGROUND_WARNING
        && !warning.startsWith('疑似像素截断：取样框含接近纯黑像素')), reason: null,
    };
    if (!session.lanes.some(lane => lane.id === band.laneId)) {
      result.reason = '条带对应泳道不存在';
      return result;
    }
    if (row.bands.some(other => other.rect.width !== band.rect.width || other.rect.height !== band.rect.height)) {
      result.reason = '同一蛋白行的取样框尺寸不一致';
      return result;
    }
    if (!rectWithinImage(band.rect, width, height)) {
      result.reason = '条带取样框越界或不是有效整数像素区域';
      return result;
    }
    const stats = statistics(band.rect, gray, width);
    result.bandSum = stats.sum;
    result.nearBlackFraction = stats.blackFraction;
    if (!contains(session.panel, band.rect)) result.warnings.push('定位异常：条带取样框超出识别的 WB 区域');
    const overlapping = allBands.filter(other => other !== band && overlap(other.rect, band.rect));
    if (overlapping.length > 0) {
      if (overlapping.some(other => bandRows.get(other) !== row.id)) {
        result.reason = '不同蛋白行的条带取样框重叠，请调整位置';
        return result;
      }
      if (maxBandOverlapFraction === 0) {
        result.reason = '条带取样框相互重叠，请调整位置或允许轻微重叠';
        return result;
      }
      const fraction = overlappedArea(band.rect, overlapping.map(other => other.rect)) / result.area;
      if (fraction > maxBandOverlapFraction) {
        result.reason = `条带重叠面积 ${(fraction * 100).toFixed(1)}% 超过允许的 ${maxBandOverlapFraction * 100}%，请调整位置`;
        return result;
      }
      result.warnings.push(`轻微条带重叠：同一蛋白行重叠面积 ${(fraction * 100).toFixed(1)}%（允许 ≤${maxBandOverlapFraction * 100}%）；重叠像素仍计入各自取样框，可能影响趋势，请核对`);
    }
    if (backgroundMode === 'none') {
      // This is an explicitly exported alternative method, never an automatic
      // fallback for missing backgrounds. Saved background geometry is untouched.
      result.net = result.bandSum;
      if (result.net <= 0) result.reason = '条带原始信号非正';
      result.warnings = dedupe(result.warnings);
      return result;
    }
    if (band.backgrounds.length === 0) {
      result.reason = '尚未指定可用背景区域';
      return result;
    }
    if (band.backgrounds.some(bg => !rectWithinImage(bg, width, height))) {
      result.reason = '背景取样框越界或不是有效整数像素区域';
      return result;
    }
    if (band.backgrounds.some(bg => allBands.some(other => overlap(bg, other.rect)))) {
      result.reason = '背景取样框与条带重叠，请重新指定';
      return result;
    }
    const background = backgroundStatistics(band.backgrounds, gray, width);
    if (background.area < band.backgrounds.reduce((sum, bg) => sum + bg.width * bg.height, 0)) result.warnings.push('背景取样框重叠：重叠像素仅计入一次');
    const mean = background.sum / background.area;
    result.backgroundMean = mean;
    result.net = result.bandSum - result.area * mean;
    if (background.area < Math.max(8, result.area * 0.2)) result.warnings.push('背景面积不足：建议扩大背景区域并检查结果稳定性');
    if (Math.sqrt(Math.max(0, background.sumSquared / background.area - mean * mean)) > 20) result.warnings.push('背景不均匀：可能包含边框、文字、其他信号或水印，请检查');
    if (band.backgrounds.some(bg => !contains(session.panel, bg))) result.warnings.push('背景位于识别的 WB 区域之外，请确认其可比性');
    if (result.net <= 0) result.reason = '背景扣除后净信号非正';
    result.warnings = dedupe(result.warnings);
    return result;
  }));
  const byPair = new Map<string, BandMeasurement>();
  const key = (rowId: string, laneId: string) => JSON.stringify([rowId, laneId]);
  for (const result of results) {
    const pair = key(result.rowId, result.laneId);
    if (byPair.has(pair)) {
      result.reason = '蛋白与泳道配对重复';
      byPair.get(pair)!.reason = result.reason;
    } else byPair.set(pair, result);
  }
  for (const result of results) {
    const row = session.rows.find(candidate => candidate.id === result.rowId)!;
    if (row.role === 'reference' || result.reason) continue;
    const referenceRow = session.rows.find(candidate => candidate.id === row.referenceRowId && candidate.role === 'reference');
    if (!referenceRow) { result.reason = '待指定对应内参'; continue; }
    const reference = byPair.get(key(referenceRow.id, result.laneId));
    result.referenceNet = reference?.net ?? null;
    if (!reference || reference.reason || reference.net === null || reference.net <= 0) {
      result.reason = session.measurementPolicy?.backgroundMode === 'none'
        ? '对应泳道内参缺失、无效或原始信号非正' : '对应泳道内参缺失、无效或净信号非正'; continue;
    }
    result.ratio = result.net! / reference.net;
  }
  for (const result of results) {
    const row = session.rows.find(candidate => candidate.id === result.rowId)!;
    if (row.role === 'reference' || result.reason) continue;
    if (!session.controlLaneId) { result.reason = '待指定对照泳道'; continue; }
    const control = byPair.get(key(result.rowId, session.controlLaneId));
    if (!control || control.ratio === null || control.ratio <= 0) { result.reason = '该蛋白对照泳道的归一化值不可用'; continue; }
    result.relative = result.ratio! / control.ratio;
    if (!Number.isFinite(result.relative)) { result.relative = null; result.reason = '相对强度超出数值范围'; }
  }
  return results;
}

const boundedText = z.string().max(2000);
const idSchema = z.string().min(1).max(100);
const rectSchema = z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const warningsSchema = z.array(boundedText).max(200);
const laneSchema = z.object({ id: idSchema, label: boundedText }).strict();
const bandSchema = z.object({ laneId: idSchema, rect: rectSchema, backgrounds: z.array(rectSchema).max(20), warnings: warningsSchema }).strict();
const rowSchema = z.object({ id: idSchema, label: boundedText, role: z.enum(['target', 'reference']), referenceRowId: idSchema.nullable(), bands: z.array(bandSchema).max(100) }).strict();
const measurementPolicySchema = z.object({ maxBandOverlapFraction: z.union([z.literal(0), z.literal(0.1)]), backgroundMode: z.enum(['subtract', 'none']).optional() }).strict();
const chartStyleSchema = z.object({ palette: z.enum(['classic', 'vivid', 'distinct', 'gray']), colors: z.record(idSchema, z.string().regex(/^#[0-9a-fA-F]{6}$/)).refine(colors => Object.keys(colors).length <= 100).optional() }).strict();
const dateSchema = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), '无效时间戳');
const providerSchema = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, '服务地址不能包含账号、查询参数或片段');
const recognitionSchema = z.object({ providerBaseUrl: providerSchema, model: boundedText, promptVersion: boundedText, rawResponse: z.string().max(1_000_000), createdAt: dateSchema, inputRegion: rectSchema.optional() }).strict();
const sourceSchema = z.object({
  name: z.string().max(512), dataUrl: z.string().max(22 * 1024 * 1024).regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
  width: z.number().int().positive().max(16000), height: z.number().int().positive().max(16000), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict();
const sessionSchema = z.object({
  format: z.literal('wb-review'), schemaVersion: z.literal(1), appVersion: z.string().min(1).max(100), algorithmVersion: z.literal(ALGORITHM_VERSION),
  source: sourceSchema, panel: rectSchema, lanes: z.array(laneSchema).max(100), rows: z.array(rowSchema).max(100),
  controlLaneId: idSchema.nullable(), controlLaneMode: z.enum(['leftmost', 'manual']).optional(), reviewed: z.boolean(), warnings: warningsSchema, recognition: recognitionSchema.nullable(),
  measurementPolicy: measurementPolicySchema.optional(), chartStyle: chartStyleSchema.optional(),
  history: z.array(z.object({ at: dateSchema, action: boundedText, rows: z.array(rowSchema).max(100), lanes: z.array(laneSchema).max(100), controlLaneId: idSchema.nullable(), controlLaneMode: z.enum(['leftmost', 'manual']).optional(), measurementPolicy: measurementPolicySchema.optional(), chartStyle: chartStyleSchema.optional() }).strict()).max(MAX_HISTORY_ENTRIES),
  createdAt: dateSchema,
}).strict();

function validatePairs(rows: ProteinRow[], lanes: ReviewSession['lanes'], controlLaneId: string | null, width: number, height: number) {
  if (rows.length > 0 && lanes.length === 0) throw new Error('包含蛋白行的分析必须至少有一个泳道');
  if (!unique(lanes.map(lane => lane.id)) || !unique(rows.map(row => row.id))) throw new Error('泳道或蛋白 ID 重复');
  const laneIds = new Set(lanes.map(lane => lane.id));
  if (controlLaneId !== null && !laneIds.has(controlLaneId)) throw new Error('对照泳道不存在');
  for (const row of rows) {
    if (row.role === 'reference' && row.referenceRowId !== null) throw new Error('内参行不能再指定其他内参');
    if (row.referenceRowId !== null && !rows.some(candidate => candidate.id === row.referenceRowId && candidate.role === 'reference')) throw new Error('指定的内参行不存在或角色不正确');
    if (!unique(row.bands.map(band => band.laneId))) throw new Error('蛋白行含重复泳道');
    const first = row.bands[0]?.rect;
    for (const band of row.bands) {
      if (!laneIds.has(band.laneId)) throw new Error('条带对应的泳道不存在');
      if (![band.rect, ...band.backgrounds].every(rect => rectWithinImage(rect, width, height))) throw new Error('取样框越界');
      if (first && (band.rect.width !== first.width || band.rect.height !== first.height)) throw new Error('同一蛋白行的取样框尺寸必须一致');
    }
  }
}

export function validateSession(value: unknown): ReviewSession {
  const parsed = sessionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`分析文件格式无效：${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  const session = parsed.data;
  if (session.source.width * session.source.height > MAX_PIXELS) throw new Error('图片像素数量超过 2000 万上限');
  if (!rectWithinImage(session.panel, session.source.width, session.source.height)) throw new Error('WB 区域越界');
  if (session.recognition?.inputRegion && !rectWithinImage(session.recognition.inputRegion, session.source.width, session.source.height)) throw new Error('识别截图区域越界');
  validatePairs(session.rows, session.lanes, session.controlLaneId, session.source.width, session.source.height);
  for (const edit of session.history) validatePairs(edit.rows, edit.lanes, edit.controlLaneId, session.source.width, session.source.height);
  return session;
}

export function parseSession(text: string): ReviewSession {
  assertDocumentSize(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('无法读取分析文件：JSON 格式错误'); }
  return validateSession(value);
}

export function serializeSession(session: ReviewSession): string {
  const text = JSON.stringify(validateSession(session), null, 2);
  assertDocumentSize(text);
  return text;
}

function assertDocumentSize(text: string): void {
  if (text.length > MAX_DOCUMENT_LENGTH || new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_LENGTH) {
    throw new Error('分析文件超过 30 MB 上限。不会自动删除操作记录；请导出其他结果，或使用更小的截图开始新的分析。');
  }
}

function baseSession(source: SourceImage): ReviewSession {
  sourceSchema.parse(source);
  if (source.width * source.height > MAX_PIXELS) throw new Error('图片像素数量超过 2000 万上限');
  return { format: 'wb-review', schemaVersion: 1, appVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION, source: clone(source),
    panel: { x: 0, y: 0, width: source.width, height: source.height }, lanes: [], rows: [], controlLaneId: null, controlLaneMode: 'leftmost',
    measurementPolicy: { ...DEFAULT_MEASUREMENT_POLICY },
    reviewed: false, warnings: [], recognition: null, history: [], createdAt: new Date().toISOString() };
}

function normalizeRect(rect: Rect, width: number, height: number): Rect {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1.0000001 || rect.y + rect.height > 1.0000001) throw new Error('模型返回了越界或无效的归一化坐标');
  const x = Math.min(width - 1, Math.round(rect.x * width));
  const y = Math.min(height - 1, Math.round(rect.y * height));
  const right = Math.min(width, Math.max(x + 1, Math.round((rect.x + rect.width) * width)));
  const bottom = Math.min(height, Math.max(y + 1, Math.round((rect.y + rect.height) * height)));
  return { x, y, width: right - x, height: bottom - y };
}

function fitRect(rect: Rect, bounds: Rect): Rect {
  const width = Math.max(1, Math.min(Math.round(rect.width), bounds.width));
  const height = Math.max(1, Math.min(Math.round(rect.height), bounds.height));
  return { x: Math.max(bounds.x, Math.min(Math.round(rect.x), bounds.x + bounds.width - width)), y: Math.max(bounds.y, Math.min(Math.round(rect.y), bounds.y + bounds.height - height)), width, height };
}

function refineRect(rect: Rect, gray: Uint8Array, width: number): Rect {
  // Use excess darkness above the perimeter median; never move more than 15%.
  const perimeter: number[] = [];
  pixels(rect, width, index => {
    const x = index % width, y = Math.floor(index / width);
    if (x === rect.x || x === rect.x + rect.width - 1 || y === rect.y || y === rect.y + rect.height - 1) perimeter.push(255 - gray[index]);
  });
  perimeter.sort((a, b) => a - b);
  const background = perimeter[Math.floor(perimeter.length / 2)] ?? 0;
  let weights = 0, weightedX = 0, weightedY = 0;
  pixels(rect, width, index => {
    const weight = Math.max(0, 255 - gray[index] - background);
    weights += weight; weightedX += (index % width + 0.5) * weight; weightedY += (Math.floor(index / width) + 0.5) * weight;
  });
  if (!weights) return rect;
  const dx = Math.round(Math.max(-rect.width * 0.15, Math.min(rect.width * 0.15, weightedX / weights - (rect.x + rect.width / 2))));
  const dy = Math.round(Math.max(-rect.height * 0.15, Math.min(rect.height * 0.15, weightedY / weights - (rect.y + rect.height / 2))));
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

export function suggestBackgrounds(bandRect: Rect, panel: Rect, allRects: Rect[], gray: Uint8Array, width: number): Rect[] {
  const inner = { x: panel.x + 2, y: panel.y + 2, width: panel.width - 4, height: panel.height - 4 };
  const height = Math.max(2, Math.min(6, Math.round(bandRect.height / 3)));
  const search = Math.min(16, Math.max(4, Math.round(bandRect.height * 0.8)));
  const result: Rect[] = [];
  for (const direction of [-1, 1]) {
    const candidates: { rect: Rect; score: number }[] = [];
    for (let distance = 2; distance <= search; distance++) {
      const rect = { x: bandRect.x, y: direction === -1 ? bandRect.y - height - distance : bandRect.y + bandRect.height + distance, width: bandRect.width, height };
      if (!contains(inner, rect) || allRects.some(other => overlap(rect, { x: other.x - 1, y: other.y - 1, width: other.width + 2, height: other.height + 2 }))) continue;
      const stats = statistics(rect, gray, width);
      if (stats.std > 20 || stats.blackFraction > 0.01 || stats.mean > 80) continue;
      candidates.push({ rect, score: stats.std * 3 + distance + stats.mean * 0.1 });
    }
    candidates.sort((a, b) => a.score - b.score);
    if (candidates[0]) result.push(candidates[0].rect);
  }
  return result;
}

const normalizedRectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict();
const detectionSchema = z.object({ panel: normalizedRectSchema, lanes: z.array(laneSchema).min(1).max(100), rows: z.array(z.object({
  id: idSchema, label: boundedText, role: z.enum(['target', 'reference']), referenceRowId: idSchema.nullable(),
  bands: z.array(z.object({ laneId: idSchema, rect: normalizedRectSchema }).strict()).max(100),
}).strict()).min(1).max(100), controlLaneId: idSchema.nullable(), warnings: warningsSchema }).strict();

export function sessionFromDetection(source: SourceImage, gray: Uint8Array, result: RecognitionResult): ReviewSession {
  if (gray.length !== source.width * source.height) throw new Error('灰度像素数量与原图尺寸不一致');
  const detection: Detection = detectionSchema.parse(result.detection);
  const session = baseSession(source);
  session.panel = normalizeRect(detection.panel, source.width, source.height);
  session.lanes = clone(detection.lanes);
  session.warnings = dedupe([...detection.warnings, '自动取样框和背景为待核对草稿；请检查水印、边框、标签与泳道对应关系']);
  session.recognition = recognitionSchema.parse({ providerBaseUrl: result.providerBaseUrl, model: result.model, promptVersion: result.promptVersion, rawResponse: result.rawResponse, createdAt: result.createdAt,
    ...(result.inputRegion ? { inputRegion: result.inputRegion } : {}) });
  session.rows = detection.rows.map(row => {
    const rects = row.bands.map(band => normalizeRect(band.rect, source.width, source.height));
    const rowWidth = Math.min(session.panel.width, Math.max(1, ...rects.map(rect => rect.width)));
    const rowHeight = Math.min(session.panel.height, Math.max(1, ...rects.map(rect => rect.height)));
    return { id: row.id, label: row.label, role: row.role, referenceRowId: row.referenceRowId, bands: row.bands.map((band, index) => {
      const original = rects[index];
      const warnings = contains(session.panel, original) ? [] : [INITIAL_MODEL_GEOMETRY_WARNING];
      const refined = refineRect(original, gray, source.width);
      const rect = fitRect({ x: refined.x + (refined.width - rowWidth) / 2, y: refined.y + (refined.height - rowHeight) / 2, width: rowWidth, height: rowHeight }, session.panel);
      return { laneId: band.laneId, rect, backgrounds: [], warnings };
    }) };
  });
  // Suggest only an unambiguous canonical label; never invent absent bands.
  const referenceCandidates = session.rows.filter(row => /^(?:β|beta|b)[ -]?actin$|^GAPDH$/i.test(row.label.trim()));
  if (!session.rows.some(row => row.role === 'reference') && referenceCandidates.length === 1) {
    referenceCandidates[0].role = 'reference'; referenceCandidates[0].referenceRowId = null;
  }
  // A null pairing expresses uncertainty, even when only one reference row exists.
  // Preserve it for the user to resolve instead of inferring a pairing from proximity.
  session.controlLaneId = leftmostLaneId(session);
  const allRects = session.rows.flatMap(row => row.bands.map(band => band.rect));
  for (const row of session.rows) for (const band of row.bands) {
    band.backgrounds = suggestBackgrounds(band.rect, session.panel, allRects, gray, source.width);
    if (!band.backgrounds.length) band.warnings.push(INITIAL_BACKGROUND_WARNING);
  }
  return recordEdit(validateSession(session), '自动识别并生成待核对取样框');
}

export function createManualSession(source: SourceImage, laneCount: number, rowCount: number): ReviewSession {
  if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 30 || !Number.isInteger(rowCount) || rowCount < 1 || rowCount > 30) throw new Error('泳道数和蛋白行数应为 1–30 的整数');
  const session = baseSession(source);
  const cellWidth = source.width / laneCount, cellHeight = source.height / rowCount;
  if (cellWidth < 4 || cellHeight < 8) throw new Error('图片太小，无法生成指定数量的取样框');
  session.lanes = Array.from({ length: laneCount }, (_, index) => ({ id: `lane-${index + 1}`, label: `泳道 ${index + 1}` }));
  const bandWidth = Math.max(1, Math.floor(cellWidth * 0.55)), bandHeight = Math.max(1, Math.floor(cellHeight * 0.22));
  session.rows = Array.from({ length: rowCount }, (_, row) => ({
    id: `row-${row + 1}`, label: `蛋白 ${row + 1}`, role: 'target', referenceRowId: null,
    bands: session.lanes.map((lane, column) => {
      const rect = fitRect({ x: (column + 0.5) * cellWidth - bandWidth / 2, y: (row + 0.5) * cellHeight - bandHeight / 2, width: bandWidth, height: bandHeight }, session.panel);
      const bg = fitRect({ x: rect.x, y: Math.max(row * cellHeight, rect.y - Math.max(2, Math.floor(cellHeight * 0.12)) - 2), width: bandWidth, height: Math.max(1, Math.floor(cellHeight * 0.12)) }, session.panel);
      return { laneId: lane.id, rect, backgrounds: overlap(rect, bg) ? [] : [bg], warnings: [INITIAL_GRID_WARNING] };
    }),
  }));
  session.controlLaneId = leftmostLaneId(session);
  session.warnings = ['请手动指定蛋白名称、组别和内参，并对齐所有取样框；对照默认最左泳道，可自行调整'];
  return recordEdit(validateSession(session), '创建人工取样网格');
}

export function recordEdit(session: ReviewSession, action: string): ReviewSession {
  if (session.history.length >= MAX_HISTORY_ENTRIES) throw new Error('操作记录已达到 10000 次上限。请先导出当前分析；为保留完整记录，本次修改未保存。');
  const next = clone(session);
  next.reviewed = false;
  next.history.push({ at: new Date().toISOString(), action: action.slice(0, 2000), rows: clone(next.rows), lanes: clone(next.lanes), controlLaneId: next.controlLaneId,
    ...(next.chartStyle ? { chartStyle: clone(next.chartStyle) } : {}),
    ...(next.controlLaneMode ? { controlLaneMode: next.controlLaneMode } : {}),
    ...(next.measurementPolicy ? { measurementPolicy: clone(next.measurementPolicy) } : {}) });
  return next;
}

export function updateBandRect(session: ReviewSession, rowId: string, laneId: string, rect: Rect): ReviewSession {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error('无效的取样框尺寸');
  const next = clone(session);
  const row = next.rows.find(candidate => candidate.id === rowId);
  if (!row || !row.bands.some(band => band.laneId === laneId)) throw new Error('找不到要修改的条带');
  const bounds = { x: 0, y: 0, width: session.source.width, height: session.source.height };
  const updated = fitRect(rect, bounds);
  for (const band of row.bands) {
    const previous = band.rect;
    if (band.laneId === laneId) band.rect = updated;
    else band.rect = fitRect({ ...band.rect, x: band.rect.x + (band.rect.width - updated.width) / 2, y: band.rect.y + (band.rect.height - updated.height) / 2, width: updated.width, height: updated.height }, bounds);
    if (band.laneId === laneId || Object.keys(previous).some(key => previous[key as keyof Rect] !== band.rect[key as keyof Rect])) refreshManualBandWarnings(band, 'band');
  }
  return recordEdit(next, `调整 ${row.label} / ${session.lanes.find(lane => lane.id === laneId)?.label ?? laneId} 条带框；同步同一蛋白行尺寸`);
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Prevent spreadsheet formula execution while preserving genuine numeric values.
  if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function measurementsCsv(session: ReviewSession, measurements: BandMeasurement[]): string {
  const backgroundMode = session.measurementPolicy?.backgroundMode ?? 'subtract';
  const rows: unknown[][] = [['protein', 'group', 'role', 'reference_protein', 'control_group', 'area_px', 'sum_inverted_gray', 'mean_background_inverted_gray',
    backgroundMode === 'none' ? 'raw_signal_for_normalization' : 'net_signal', backgroundMode === 'none' ? 'reference_raw_signal' : 'reference_net_signal',
    'normalized_signal', 'relative_to_control', 'unavailable_reason', 'warnings', 'source_sha256', 'algorithm_version', 'max_band_overlap_fraction', 'background_mode', 'near_black_pixel_fraction', 'recognition_notes']];
  for (const measurement of measurements) {
    const row = session.rows.find(candidate => candidate.id === measurement.rowId);
    rows.push([row?.label, session.lanes.find(lane => lane.id === measurement.laneId)?.label, row?.role, session.rows.find(candidate => candidate.id === row?.referenceRowId)?.label,
      session.lanes.find(lane => lane.id === session.controlLaneId)?.label, measurement.area, measurement.bandSum, measurement.backgroundMean, measurement.net, measurement.referenceNet, measurement.ratio, measurement.relative,
      measurement.reason, dedupe(measurement.warnings).join('；'), session.source.sha256, session.algorithmVersion, session.measurementPolicy?.maxBandOverlapFraction ?? 0, backgroundMode, measurement.nearBlackFraction, dedupe(session.warnings).join('；')]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
