import { recordEdit, rectWithinImage, suggestBackgrounds, validateSession } from './core';
import type { Rect, ReviewSession } from './core/types';

export interface BackgroundPair { rowId: string; laneId: string }

const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;

function quality(rect: Rect, gray: Uint8Array, width: number) {
  let sum = 0, squares = 0, black = 0;
  const area = rect.width * rect.height;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const pixel = gray[y * width + x], signal = 255 - pixel;
    sum += signal; squares += signal * signal;
    if (pixel <= 1) black++;
  }
  const mean = sum / area;
  return { mean, std: Math.sqrt(Math.max(0, squares / area - mean * mean)), blackFraction: black / area };
}

/**
 * Keep the original full-width proposals when available. Tight panels can also
 * use shorter / thinner nearby strips, still inside the same band column and
 * the inset WB panel. These are geometry proposals, never invented pixels.
 */
export function suggestRepairBackgrounds(band: Rect, panel: Rect, allBands: Rect[], gray: Uint8Array, width: number): Rect[] {
  if (!Number.isInteger(width) || width < 1 || gray.length % width !== 0) throw new Error('灰度像素与图像尺寸不匹配');
  const imageHeight = gray.length / width;
  if (!rectWithinImage(panel, width, imageHeight) || !rectWithinImage(band, width, imageHeight)
    || allBands.some(rect => !rectWithinImage(rect, width, imageHeight))) throw new Error('背景搜索需要有效的原图像素区域');
  const original = suggestBackgrounds(band, panel, allBands, gray, width);
  if (original.length) return original;

  const inner = { x: panel.x + 2, y: panel.y + 2, width: panel.width - 4, height: panel.height - 4 };
  if (inner.width < 1 || inner.height < 1) return [];
  const paddedBands = allBands.map(rect => ({ x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 }));
  const maxHeight = Math.max(2, Math.min(6, Math.round(band.height / 3)));
  const search = Math.min(16, Math.max(4, Math.round(band.height * 0.8)));
  // Never seek an unrelated bright patch alongside the band or outside WB.
  const widths = [...new Set([band.width, Math.ceil(band.width * 0.75), Math.ceil(band.width * 0.5)])]
    .filter(value => value >= Math.min(band.width, 4));
  type Candidate = { rect: Rect; area: number; score: number };
  const bySide = [-1, 1].map(direction => {
    // For the same area, only the best candidate can improve the final pair.
    const bestByArea = new Map<number, Candidate>();
    for (const candidateWidth of widths) {
      const offsets = [...new Set([0, Math.floor((band.width - candidateWidth) / 2), band.width - candidateWidth])];
      for (const offset of offsets) for (let height = maxHeight; height >= 1; height--) {
        for (let distance = 1; distance <= search; distance++) {
          const rect = { x: band.x + offset, y: direction === -1 ? band.y - height - distance : band.y + band.height + distance,
            width: candidateWidth, height };
          if (!contains(inner, rect) || paddedBands.some(other => overlap(rect, other))) continue;
          const stats = quality(rect, gray, width);
          // Same thresholds as the original proposal search: no relaxed image
          // quality thresholds merely to force a numerical result.
          if (stats.std > 20 || stats.blackFraction > 0.01 || stats.mean > 80) continue;
          const area = rect.width * rect.height;
          const score = stats.std * 3 + distance + stats.mean * 0.1 + (1 - candidateWidth / band.width) * 2;
          const previous = bestByArea.get(area);
          if (!previous || score < previous.score) bestByArea.set(area, { rect, area, score });
        }
      }
    }
    return [...bestByArea.values()];
  });
  const minimumArea = Math.max(8, band.width * band.height * 0.2);
  let best: { rects: Rect[]; score: number; area: number } | null = null;
  const consider = (candidates: Candidate[]) => {
    const area = candidates.reduce((sum, candidate) => sum + candidate.area, 0);
    if (area < minimumArea) return;
    const score = candidates.reduce((sum, candidate) => sum + candidate.score * candidate.area, 0) / area;
    if (!best || score < best.score || (score === best.score && area > best.area)) best = { rects: candidates.map(candidate => candidate.rect), score, area };
  };
  // Above/below candidates are disjoint, so area here is the exact union area.
  for (const above of bySide[0]) for (const below of bySide[1]) consider([above, below]);
  if (!best) for (const candidates of bySide) for (const candidate of candidates) consider([candidate]);
  return best ? (best as { rects: Rect[] }).rects : [];
}

/** Fill only absent backgrounds; retain user-selected geometry and one undoable audit entry. */
export function repairMissingBackgrounds(session: ReviewSession, gray: Uint8Array, selectedPairs?: BackgroundPair[]): ReviewSession {
  if (gray.length !== session.source.width * session.source.height) throw new Error('灰度像素数量与原图尺寸不一致');
  const selection = selectedPairs && new Set(selectedPairs.map(pair => JSON.stringify([pair.rowId, pair.laneId])));
  const allBands = session.rows.flatMap(row => row.bands.map(band => band.rect));
  const next = structuredClone(session);
  let added = 0;
  for (const row of next.rows) for (const band of row.bands) {
    if (band.backgrounds.length || (selection && !selection.has(JSON.stringify([row.id, band.laneId])))) continue;
    const backgrounds = suggestRepairBackgrounds(band.rect, next.panel, allBands, gray, next.source.width);
    if (!backgrounds.length) continue;
    band.backgrounds = backgrounds;
    band.warnings = band.warnings.filter(warning => warning !== '未找到足够干净的邻近背景，请手动指定');
    added++;
  }
  return added ? recordEdit(validateSession(next), `为 ${added} 个条带补充邻近背景取样框；请核对背景`) : session;
}
