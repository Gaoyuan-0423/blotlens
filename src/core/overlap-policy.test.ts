import { describe, expect, it } from 'vitest';
import {
  ALGORITHM_VERSION, APP_VERSION, createManualSession, DEFAULT_MEASUREMENT_POLICY,
  measurementsCsv, measureSession, parseSession, recordEdit, serializeSession, validateSession,
} from './index';
import type { Rect, ReviewSession, SourceImage } from './types';

const source: SourceImage = {
  name: 'overlap-ground-truth.png', dataUrl: 'data:image/png;base64,AQ==',
  width: 80, height: 50, sha256: 'b'.repeat(64),
};

function fixture(xs = [1, 10], bandWidth = 10) {
  const session: ReviewSession = {
    format: 'wb-review', schemaVersion: 1, appVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION,
    source, panel: { x: 0, y: 0, width: source.width, height: source.height },
    lanes: xs.map((_, index) => ({ id: `lane-${index}`, label: index === 0 ? 'Ctrl' : `Group ${index}` })),
    rows: [2, 25].map((y, index) => ({
      id: index === 0 ? 'target' : 'ref', label: index === 0 ? 'Target' : 'Reference',
      role: index === 0 ? 'target' : 'reference', referenceRowId: index === 0 ? 'ref' : null,
      bands: xs.map((x, lane) => ({ laneId: `lane-${lane}`, rect: { x, y, width: bandWidth, height: 10 },
        backgrounds: [{ x, y: y - 2, width: bandWidth, height: 1 }], warnings: [] })),
    })),
    controlLaneId: 'lane-0', measurementPolicy: { ...DEFAULT_MEASUREMENT_POLICY },
    reviewed: false, warnings: [], recognition: null, history: [], createdAt: '2026-10-11T00:00:00.000Z',
  };
  const gray = new Uint8Array(source.width * source.height).fill(235); // Background signal = 20.
  const fill = (rect: Rect) => {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) gray[y * source.width + x] = 155; // Signal = 100.
    }
  };
  session.rows.forEach(row => row.bands.forEach(band => fill(band.rect)));
  return { session, gray };
}

describe('explicit slight band overlap measurement policy', () => {
  it('leaves touching nonoverlapping boxes unchanged', () => {
    const { session, gray } = fixture([1, 11]);
    const measurement = measureSession(session, gray)[0];
    expect(measurement).toMatchObject({ bandSum: 10000, net: 8000, relative: 1, reason: null });
    expect(measurement.warnings.join('')).not.toContain('重叠');
  });

  it('allows exactly 10% within one row and keeps every original rectangular pixel sum', () => {
    const { session, gray } = fixture(); // 1-pixel overlap across a 10×10 band = 10%.
    const measurements = measureSession(session, gray);
    expect(measurements.every(result => result.net === 8000 && result.bandSum === 10000 && !result.reason)).toBe(true);
    expect(measurements.slice(0, 2).map(result => result.relative)).toEqual([1, 1]);
    expect(measurements.every(result => result.warnings.some(warning => warning.includes('10.0%') && warning.includes('重叠像素仍计入各自取样框')))).toBe(true);
  });

  it('blocks any overlap when explicitly disabled or absent from a legacy file', () => {
    const { session, gray } = fixture();
    session.measurementPolicy = { maxBandOverlapFraction: 0 };
    expect(measureSession(session, gray)[0]).toMatchObject({ bandSum: 10000, net: null, relative: null });
    delete session.measurementPolicy;
    const legacy = parseSession(serializeSession(session));
    expect(legacy.measurementPolicy).toBeUndefined();
    expect(measureSession(legacy, gray)[0].reason).toContain('相互重叠');
  });

  it('blocks overlap exceeding 10% even if each overlap is permitted individually', () => {
    const { session, gray } = fixture([1, 19, 37], 20); // Middle shares 10% on each side, totaling 20%.
    const measurements = measureSession(session, gray);
    expect(measurements[0].net).toBe(16000);
    expect(measurements[1]).toMatchObject({ net: null, relative: null });
    expect(measurements[1].reason).toContain('20.0% 超过允许的 10%');
    expect(measurements[2].net).toBe(16000);
  });

  it('uses the union of intersections rather than double counting shared pixels', () => {
    const { session, gray } = fixture([1, 10, 10]);
    const measurements = measureSession(session, gray);
    // The first band shares the same 10 pixels with both neighbors, so its union overlap is 10%, not 20%.
    expect(measurements[0]).toMatchObject({ net: 8000, relative: 1, reason: null });
    expect(measurements[0].warnings.join('')).toContain('10.0%');
    expect(measurements[1].reason).toContain('100.0%');
  });

  it('blocks even a one-pixel cross-protein overlap', () => {
    const { session, gray } = fixture([1, 20]);
    session.rows[1].bands[0].rect = { x: 10, y: 11, width: 10, height: 10 }; // One shared pixel.
    const measurements = measureSession(session, gray);
    expect(measurements[0].reason).toBe('不同蛋白行的条带取样框重叠，请调整位置');
    expect(measurements[2].reason).toBe('不同蛋白行的条带取样框重叠，请调整位置');
    expect(measurements[0].net).toBeNull();
  });

  it('continues to forbid background-band overlap when slight band overlap is enabled', () => {
    const { session, gray } = fixture();
    session.rows[0].bands[0].backgrounds = [{ x: 1, y: 1, width: 10, height: 2 }];
    const measurement = measureSession(session, gray)[0];
    expect(measurement.reason).toBe('背景取样框与条带重叠，请重新指定');
    expect(measurement.net).toBeNull();
  });

  it('defaults newly created sessions to slight overlap and exports the policy and edit snapshot', () => {
    expect(createManualSession(source, 2, 2).measurementPolicy).toEqual({ maxBandOverlapFraction: 0.1, backgroundMode: 'subtract' });
    const { session, gray } = fixture();
    const saved = recordEdit(session, '允许轻微条带重叠');
    const reopened = parseSession(serializeSession(saved));
    expect(reopened.measurementPolicy).toEqual({ maxBandOverlapFraction: 0.1, backgroundMode: 'subtract' });
    expect(reopened.history.at(-1)?.measurementPolicy).toEqual({ maxBandOverlapFraction: 0.1, backgroundMode: 'subtract' });
    expect(measureSession(reopened, gray)).toEqual(measureSession(session, gray));
    saved.measurementPolicy!.maxBandOverlapFraction = 0;
    expect(saved.history.at(-1)?.measurementPolicy?.maxBandOverlapFraction).toBe(0.1);
    const [header, row] = measurementsCsv(reopened, measureSession(reopened, gray)).trim().split('\r\n').map(line => line.split(','));
    expect(row[header.indexOf('max_band_overlap_fraction')]).toBe('0.1');
  });

  it('rejects unsupported overlap parameters in sessions and historical records', () => {
    const { session } = fixture();
    expect(() => validateSession({ ...session, measurementPolicy: { maxBandOverlapFraction: 0.2 } })).toThrow('格式');
    expect(() => validateSession({ ...session, measurementPolicy: { maxBandOverlapFraction: 0.1, trustModel: true } })).toThrow('格式');
    const edited = recordEdit(session, 'edit');
    expect(() => validateSession({ ...edited, history: [{ ...edited.history[0], measurementPolicy: { maxBandOverlapFraction: 1 } }] })).toThrow('格式');
  });
});
