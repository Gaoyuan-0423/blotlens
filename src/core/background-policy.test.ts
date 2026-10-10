import { describe, expect, it } from 'vitest';
import { ALGORITHM_VERSION, APP_VERSION, measurementsCsv, measureSession, parseSession, recordEdit, serializeSession, validateSession } from './index';
import type { Rect, ReviewSession } from './types';

function fixture() {
  const session: ReviewSession = {
    format: 'wb-review', schemaVersion: 1, appVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION,
    source: { name: 'background-ground-truth.png', dataUrl: 'data:image/png;base64,AQ==', width: 50, height: 50, sha256: 'c'.repeat(64) },
    panel: { x: 0, y: 0, width: 50, height: 50 }, lanes: [{ id: 'a', label: 'Ctrl' }, { id: 'b', label: 'Treatment' }],
    rows: [2, 25].map((y, index) => ({ id: index === 0 ? 'target' : 'ref', label: index === 0 ? 'Target' : 'Reference',
      role: index === 0 ? 'target' : 'reference', referenceRowId: index === 0 ? 'ref' : null,
      bands: [1, 20].map((x, lane) => ({ laneId: lane === 0 ? 'a' : 'b', rect: { x, y, width: 10, height: 10 },
        backgrounds: [{ x, y: y - 2, width: 10, height: 1 }], warnings: [] })),
    })), controlLaneId: 'a', measurementPolicy: { maxBandOverlapFraction: 0.1, backgroundMode: 'subtract' },
    reviewed: false, warnings: [], recognition: null, history: [], createdAt: '2026-10-11T00:00:00.000Z',
  };
  const gray = new Uint8Array(50 * 50).fill(255);
  const fill = (rect: Rect, signal: number) => {
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) gray[y * 50 + x] = 255 - signal;
  };
  const signals = [[100, 200], [80, 100]], backgrounds = [[10, 40], [20, 20]];
  session.rows.forEach((row, i) => row.bands.forEach((band, j) => { fill(band.rect, signals[i][j]); fill(band.backgrounds[0], backgrounds[i][j]); }));
  return { session, gray, fill };
}

describe('explicit uncorrected signal mode', () => {
  it('retains background subtraction as the default for legacy files and omitted modes', () => {
    const { session, gray } = fixture();
    expect(measureSession(session, gray)[1].relative).toBeCloseTo(4 / 3);
    delete session.measurementPolicy!.backgroundMode;
    expect(measureSession(session, gray)[1].relative).toBeCloseTo(4 / 3);
    delete session.measurementPolicy;
    expect(measureSession(parseSession(serializeSession(session)), gray)[1].relative).toBeCloseTo(4 / 3);
  });

  it('uses raw target/reference/control signals only when explicitly selected and leaves every ROI untouched', () => {
    const { session, gray } = fixture();
    const before = structuredClone(session.rows);
    session.measurementPolicy!.backgroundMode = 'none';
    const result = measureSession(session, gray);
    expect(result[0]).toMatchObject({ bandSum: 10000, backgroundMean: null, net: 10000, referenceNet: 8000, ratio: 1.25, relative: 1, reason: null });
    expect(result[1]).toMatchObject({ bandSum: 20000, backgroundMean: null, net: 20000, referenceNet: 10000, ratio: 2, relative: 1.6, reason: null });
    expect(session.rows).toEqual(before);
    session.measurementPolicy!.backgroundMode = 'subtract';
    expect(measureSession(session, gray)[1].relative).toBeCloseTo(4 / 3);
    expect(session.rows).toEqual(before);
  });

  it('does not inspect unused missing or overlapping backgrounds and resumes those checks when switched back', () => {
    const { session, gray } = fixture();
    session.rows[0].bands[0].backgrounds = [];
    session.rows[1].bands[0].backgrounds = [{ ...session.rows[1].bands[0].rect }];
    session.rows[0].bands[0].warnings = ['未找到足够干净的邻近背景，请手动指定'];
    session.measurementPolicy!.backgroundMode = 'none';
    const result = measureSession(session, gray);
    expect(result[0].relative).toBe(1);
    expect(result.every(measurement => measurement.backgroundMean === null)).toBe(true);
    expect(result.every(measurement => !measurement.warnings.some(warning => warning.includes('背景')))).toBe(true);
    session.measurementPolicy!.backgroundMode = 'subtract';
    const corrected = measureSession(session, gray);
    expect(corrected[0].reason).toBe('尚未指定可用背景区域');
    expect(corrected[2].reason).toBe('背景取样框与条带重叠，请重新指定');
  });

  it('never fabricates ratios for zero raw target, reference, or control signals', () => {
    const { session, gray, fill } = fixture();
    session.measurementPolicy!.backgroundMode = 'none';
    fill(session.rows[1].bands[1].rect, 0);
    let result = measureSession(session, gray);
    expect(result[3].net).toBe(0);
    expect(result[1]).toMatchObject({ referenceNet: 0, ratio: null, relative: null });
    fill(session.rows[0].bands[0].rect, 0);
    result = measureSession(session, gray);
    expect(result[0]).toMatchObject({ net: 0, ratio: null, relative: null, reason: '条带原始信号非正' });
    fill(session.rows[1].bands[1].rect, 100);
    expect(measureSession(session, gray)[1].reason).toBe('该蛋白对照泳道的归一化值不可用');
  });

  it('still checks band geometry and overlap and reports neutral pixel information in uncorrected mode', () => {
    const { session, gray, fill } = fixture();
    session.measurementPolicy!.backgroundMode = 'none';
    fill(session.rows[0].bands[0].rect, 255);
    const result = measureSession(session, gray)[0];
    expect(result.nearBlackFraction).toBe(1);
    expect(result.reason).toBeNull();
    expect(result.warnings.join('')).not.toContain('疑似像素截断');
    session.rows[0].bands[1].rect.x = 9; // Two columns / 10 = 20%.
    expect(measureSession(session, gray)[0].reason).toContain('超过允许的 10%');
    session.rows[0].bands[0].rect.x = -1;
    expect(measureSession(session, gray)[0].reason).toContain('越界');
  });

  it('exports an explicit mode and non-misleading raw headers and restores calculation and audit state', () => {
    const { session, gray } = fixture();
    session.measurementPolicy!.backgroundMode = 'none';
    const saved = recordEdit(session, '切换至不扣背景');
    const reopened = parseSession(serializeSession(saved));
    expect(reopened.measurementPolicy?.backgroundMode).toBe('none');
    expect(reopened.history[0].measurementPolicy?.backgroundMode).toBe('none');
    expect(measureSession(reopened, gray)).toEqual(measureSession(session, gray));
    const [header, row] = measurementsCsv(reopened, measureSession(reopened, gray)).trim().split('\r\n').map(line => line.split(','));
    expect(header).toContain('raw_signal_for_normalization');
    expect(header).toContain('reference_raw_signal');
    expect(header).not.toContain('net_signal');
    expect(row[header.indexOf('raw_signal_for_normalization')]).toBe('10000');
    expect(row[header.indexOf('background_mode')]).toBe('none');
  });

  it('rejects unknown background methods in files and historical edits', () => {
    const { session } = fixture();
    expect(() => validateSession({ ...session, measurementPolicy: { maxBandOverlapFraction: 0.1, backgroundMode: 'automatic' } })).toThrow('格式');
    const edited = recordEdit(session, 'edit');
    expect(() => validateSession({ ...edited, history: [{ ...edited.history[0], measurementPolicy: { maxBandOverlapFraction: 0.1, backgroundMode: 'guess' } }] })).toThrow('格式');
  });
});
