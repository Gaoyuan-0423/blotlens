import {
  recordEdit,
  refreshManualBandWarnings,
  suggestBackgrounds,
  validateSession,
} from './core';
import type { Rect, ReviewSession } from './core';

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;

/** Quantize a drawn region once, without accepting coordinates outside the source. */
function pixelRect(rect: Rect, imageWidth: number, imageHeight: number): Rect {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > imageWidth || rect.y + rect.height > imageHeight) {
    throw new Error('取样框必须位于原图内，宽高至少为 1 像素');
  }
  const x = Math.min(imageWidth - 1, Math.round(rect.x));
  const y = Math.min(imageHeight - 1, Math.round(rect.y));
  const right = Math.min(imageWidth, Math.max(x + 1, Math.round(rect.x + rect.width)));
  const bottom = Math.min(imageHeight, Math.max(y + 1, Math.round(rect.y + rect.height)));
  return { x, y, width: right - x, height: bottom - y };
}

/** Add just the missing pair. Existing bands and their backgrounds stay unchanged. */
export function addManualBand(
  session: ReviewSession,
  rowId: string,
  laneId: string,
  drawnRect: Rect,
  gray: Uint8Array,
): ReviewSession {
  const next = validateSession(session);
  const { width: imageWidth, height: imageHeight } = next.source;
  if (gray.length !== imageWidth * imageHeight) throw new Error('灰度像素数量与原图尺寸不一致');
  const row = next.rows.find(candidate => candidate.id === rowId);
  const lane = next.lanes.find(candidate => candidate.id === laneId);
  if (!row || !lane) throw new Error('请先选择有效的蛋白与泳道');
  if (row.bands.some(band => band.laneId === laneId)) throw new Error('该蛋白与泳道已有条带取样框，请选中已有框调整，或先删除它');

  const drawn = pixelRect(drawnRect, imageWidth, imageHeight);
  const peer = row.bands[0]?.rect;
  const rect = peer ? {
    // Preserve the manual draw's center, matching the established row dimensions.
    // Near image boundaries only the new position is clamped, never existing ROIs.
    x: Math.max(0, Math.min(imageWidth - peer.width, Math.round(drawnRect.x + drawnRect.width / 2 - peer.width / 2))),
    y: Math.max(0, Math.min(imageHeight - peer.height, Math.round(drawnRect.y + drawnRect.height / 2 - peer.height / 2))),
    width: peer.width,
    height: peer.height,
  } : drawn;
  const allRects = [...next.rows.flatMap(candidate => candidate.bands.map(band => band.rect)), rect];
  row.bands.push({
    laneId,
    rect,
    backgrounds: suggestBackgrounds(rect, next.panel, allRects, gray, imageWidth),
    warnings: [],
  });
  // Only sort the new row's bands by their explicit lane mapping; don't infer missing pairs.
  row.bands.sort((a, b) => next.lanes.findIndex(candidate => candidate.id === a.laneId)
    - next.lanes.findIndex(candidate => candidate.id === b.laneId));
  return validateSession(recordEdit(next, `手动新增 ${row.label} / ${lane.label} 条带取样框`));
}

/** Add an explicitly paired background without changing its associated band. */
export function addManualBackground(
  session: ReviewSession,
  rowId: string,
  laneId: string,
  drawnRect: Rect,
): ReviewSession {
  const next = validateSession(session);
  const row = next.rows.find(candidate => candidate.id === rowId);
  const lane = next.lanes.find(candidate => candidate.id === laneId);
  const band = row?.bands.find(candidate => candidate.laneId === laneId);
  if (!row || !lane || !band) throw new Error('请先选择背景所对应的条带');
  if (band.backgrounds.length >= 20) throw new Error('每条带最多保留 20 个背景框，请先删除不需要的背景框');
  const rect = pixelRect(drawnRect, next.source.width, next.source.height);
  if (next.rows.some(candidate => candidate.bands.some(other => overlaps(rect, other.rect)))) {
    throw new Error('背景取样框与条带重叠，请在条带附近的干净区域重新框选');
  }
  band.backgrounds.push(rect);
  refreshManualBandWarnings(band, 'background');
  return validateSession(recordEdit(next, `手动新增 ${row.label} / ${lane.label} 背景取样框`));
}
