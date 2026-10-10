import { describe, expect, it } from 'vitest';
import { APP_VERSION, ALGORITHM_VERSION, measureSession, suggestBackgrounds } from './core';
import type { Rect, ReviewSession } from './core/types';
import { repairMissingBackgrounds, suggestRepairBackgrounds } from './background-repair';
import { captureUndoSnapshot, restoreUndoSnapshot } from './undo';

const fill = (gray: Uint8Array, width: number, rect: Rect, value: number) => {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) gray[y * width + x] = value;
};

function fixture(width = 60, height = 30, rect: Rect = { x: 10, y: 10, width: 40, height: 10 }) {
  const session: ReviewSession = {
    format: 'wb-review', schemaVersion: 1, appVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION,
    source: { name: 'background.png', dataUrl: 'data:image/png;base64,AQ==', width, height, sha256: 'a'.repeat(64) },
    panel: { x: 0, y: 0, width, height }, lanes: [{ id: 'a', label: 'Control' }],
    rows: [{ id: 'reference', label: 'Reference', role: 'reference', referenceRowId: null,
      bands: [{ laneId: 'a', rect, backgrounds: [], warnings: ['未找到足够干净的邻近背景，请手动指定'] }] }],
    controlLaneId: 'a', reviewed: true, warnings: [], recognition: null, history: [], createdAt: '2026-10-11T00:00:00.000Z',
  };
  const gray = new Uint8Array(width * height).fill(235);
  fill(gray, width, rect, 80);
  return { session, gray, rect };
}

describe('missing background repair', () => {
  it('retains the original full-width suggestion when one is available', () => {
    const { session, gray, rect } = fixture();
    const original = suggestBackgrounds(rect, session.panel, [rect], gray, session.source.width);
    expect(original).toHaveLength(2);
    expect(suggestRepairBackgrounds(rect, session.panel, [rect], gray, session.source.width)).toEqual(original);
  });

  it('fits one-pixel strips into a tight WB panel only when pooled area is sufficient', () => {
    const { session, gray, rect } = fixture(60, 18, { x: 10, y: 4, width: 40, height: 10 });
    expect(suggestBackgrounds(rect, session.panel, [rect], gray, 60)).toEqual([]);
    const repaired = repairMissingBackgrounds(session, gray);
    expect(repaired.rows[0].bands[0].backgrounds).toEqual([
      { x: 10, y: 2, width: 40, height: 1 }, { x: 10, y: 15, width: 40, height: 1 },
    ]);
    expect(measureSession(repaired, gray)[0]).toMatchObject({ backgroundMean: 20, net: 62_000, reason: null });
    expect(measureSession(repaired, gray)[0].warnings).not.toContain('背景面积不足：建议扩大背景区域并检查结果稳定性');
    expect(repaired.reviewed).toBe(false);
    expect(repaired.history).toHaveLength(1);
    expect(repaired.rows[0].bands[0].warnings).toEqual([]);
    expect(session.rows[0].bands[0].backgrounds).toEqual([]);
  });

  it('uses shorter strips within the original band column when full-width backgrounds are contaminated', () => {
    const { session, gray, rect } = fixture();
    gray.fill(0);
    fill(gray, 60, { x: 20, y: 7, width: 20, height: 2 }, 235);
    fill(gray, 60, { x: 20, y: 21, width: 20, height: 2 }, 235);
    expect(suggestBackgrounds(rect, session.panel, [rect], gray, 60)).toEqual([]);
    const result = suggestRepairBackgrounds(rect, session.panel, [rect], gray, 60);
    expect(result).toHaveLength(2);
    expect(result.every(background => background.x >= rect.x && background.x + background.width <= rect.x + rect.width)).toBe(true);
    expect(result.reduce((sum, background) => sum + background.width * background.height, 0)).toBeGreaterThanOrEqual(80);
    expect(result.every(background => background.width === 20)).toBe(true);
  });

  it('keeps missing backgrounds unresolved if clean pixels are insufficient or only outside the panel', () => {
    const { session, gray } = fixture();
    gray.fill(0);
    fill(gray, 60, { x: 20, y: 7, width: 20, height: 1 }, 235);
    expect(repairMissingBackgrounds(session, gray)).toBe(session);
    gray.fill(235);
    session.panel = { x: 8, y: 8, width: 44, height: 14 };
    fill(gray, 60, session.panel, 0);
    expect(repairMissingBackgrounds(session, gray)).toBe(session);
    expect(session.history).toHaveLength(0);
  });

  it('preserves manually supplied backgrounds, even when they need independent correction', () => {
    const { session, gray } = fixture();
    session.rows[0].bands[0].backgrounds = [{ x: 0, y: 0, width: 1, height: 1 }];
    const original = structuredClone(session);
    expect(repairMissingBackgrounds(session, gray)).toBe(session);
    expect(session).toEqual(original);
  });

  it('repairs only selected pairs and keeps every proposal away from all bands plus a one-pixel margin', () => {
    const { session, gray } = fixture(100, 40, { x: 10, y: 15, width: 20, height: 8 });
    session.lanes.push({ id: 'b', label: 'Treatment' });
    session.rows[0].bands.push({ laneId: 'b', rect: { x: 50, y: 15, width: 20, height: 8 }, backgrounds: [], warnings: [] });
    // A second protein is represented in only lane a. Background search must
    // exclude it even though only the first protein is selected for repair.
    const obstruction = { x: 10, y: 4, width: 20, height: 8 };
    session.rows.push({ id: 'obstruction', label: 'Other protein', role: 'target', referenceRowId: 'reference',
      bands: [{ laneId: 'a', rect: obstruction, backgrounds: [], warnings: [] }] });
    const repaired = repairMissingBackgrounds(session, gray, [{ rowId: 'reference', laneId: 'a' }]);
    expect(repaired.rows[0].bands[1].backgrounds).toEqual([]);
    expect(repaired.rows[1].bands[0].backgrounds).toEqual([]);
    expect(repaired.rows[0].bands[0].backgrounds).not.toHaveLength(0);
    const bands = session.rows.flatMap(row => row.bands.map(band => band.rect));
    for (const background of repaired.rows[0].bands[0].backgrounds) for (const band of bands) {
      expect(background.x + background.width <= band.x - 1 || background.x >= band.x + band.width + 1
        || background.y + background.height <= band.y - 1 || background.y >= band.y + band.height + 1).toBe(true);
    }
  });

  it('records one repair that undo can restore without losing the repair audit', () => {
    const { session, gray } = fixture();
    const repaired = repairMissingBackgrounds(session, gray);
    const undone = restoreUndoSnapshot(repaired, captureUndoSnapshot(session), '撤销：补充背景');
    expect(undone.rows).toEqual(session.rows);
    expect(undone.history).toHaveLength(2);
    expect(undone.history[0].rows[0].bands[0].backgrounds).toHaveLength(2);
    expect(repairMissingBackgrounds(repaired, gray)).toBe(repaired);
  });

  it('rejects mismatched pixels and invalid search coordinates instead of reading undefined pixels', () => {
    const { session, gray, rect } = fixture();
    expect(() => repairMissingBackgrounds(session, gray.slice(1))).toThrow('数量');
    expect(() => suggestRepairBackgrounds({ ...rect, x: -1 }, session.panel, [rect], gray, 60)).toThrow('有效');
  });
});
