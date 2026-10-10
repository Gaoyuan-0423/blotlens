import { describe, expect, it } from 'vitest';
import {
  ALGORITHM_VERSION, APP_VERSION, createManualSession, measurementsCsv, measureSession,
  parseSession, recordEdit, refreshManualBandWarnings, rgbaToGray, serializeSession, sessionFromDetection, updateBandRect,
} from './index';
import type { Detection, Rect, RecognitionResult, ReviewSession, SourceImage } from './types';

const source = (width = 20, height = 14): SourceImage => ({
  name: 'analytic.png', dataUrl: 'data:image/png;base64,AQ==', width, height, sha256: 'a'.repeat(64),
});
const fill = (gray: Uint8Array, width: number, rect: Rect, value: number) => {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) gray[y * width + x] = value;
};

function analytic() {
  const session: ReviewSession = {
    format: 'wb-review', schemaVersion: 1, appVersion: APP_VERSION, algorithmVersion: ALGORITHM_VERSION,
    source: source(), panel: { x: 0, y: 0, width: 20, height: 14 }, lanes: [{ id: 'a', label: 'Ctrl' }, { id: 'b', label: 'Treatment' }],
    rows: [
      { id: 'target', label: 'Target', role: 'target', referenceRowId: 'ref', bands: [
        { laneId: 'a', rect: { x: 2, y: 2, width: 2, height: 2 }, backgrounds: [{ x: 2, y: 0, width: 2, height: 1 }], warnings: [] },
        { laneId: 'b', rect: { x: 10, y: 2, width: 2, height: 2 }, backgrounds: [{ x: 10, y: 0, width: 2, height: 1 }], warnings: [] },
      ] },
      { id: 'ref', label: 'β-actin', role: 'reference', referenceRowId: null, bands: [
        { laneId: 'a', rect: { x: 2, y: 9, width: 2, height: 2 }, backgrounds: [{ x: 2, y: 6, width: 2, height: 1 }], warnings: [] },
        { laneId: 'b', rect: { x: 10, y: 9, width: 2, height: 2 }, backgrounds: [{ x: 10, y: 6, width: 2, height: 1 }], warnings: [] },
      ] },
    ], controlLaneId: 'a', reviewed: false, warnings: [], recognition: null, history: [], createdAt: '2026-10-10T10:00:00.000Z',
  };
  const gray = new Uint8Array(20 * 14).fill(235);
  fill(gray, 20, session.rows[0].bands[0].rect, 195);
  fill(gray, 20, session.rows[0].bands[1].rect, 155);
  fill(gray, 20, session.rows[1].bands[0].rect, 155);
  fill(gray, 20, session.rows[1].bands[1].rect, 195);
  return { session, gray };
}

describe('deterministic screenshot measurements', () => {
  it('uses final rounded RGB grayscale after compositing alpha against white', () => {
    expect([...rgbaToGray(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 128, 16, 100, 201, 93]))])
      .toEqual([76, 150, 29, 255, 127, 194]); // Last pixel: round(86.398 × 93 / 255 + 162).
    expect(() => rgbaToGray(new Uint8ClampedArray(3))).toThrow();
  });

  it('matches independently derived signed sums, pooled background, reference ratios and fold change', () => {
    const { session, gray } = analytic();
    const [control, treatment, refControl, refTreatment] = measureSession(session, gray);
    expect(control).toMatchObject({ area: 4, bandSum: 240, backgroundMean: 20, net: 160, referenceNet: 320, ratio: 0.5, relative: 1, reason: null });
    expect(treatment).toMatchObject({ net: 320, referenceNet: 160, ratio: 2, relative: 4, reason: null });
    expect(refControl).toMatchObject({ net: 320, ratio: null, relative: null });
    expect(refTreatment.net).toBe(160);
    expect(measureSession(session, gray)).toEqual(measureSession(session, gray));
  });

  it('preserves negative values and never substitutes an epsilon for a zero reference', () => {
    const { session, gray } = analytic();
    fill(gray, 20, session.rows[0].bands[1].rect, 245);
    fill(gray, 20, session.rows[1].bands[0].rect, 235);
    const [control, treatment] = measureSession(session, gray);
    expect(control.referenceNet).toBe(0);
    expect(control.relative).toBeNull();
    expect(treatment.net).toBe(-40);
    expect(treatment.ratio).toBeNull();
    expect(treatment.relative).toBeNull();
  });

  it('retains small positive values without thresholding and invalidates all folds if control is nonpositive', () => {
    const { session, gray } = analytic();
    fill(gray, 20, session.rows[0].bands[1].rect, 234);
    expect(measureSession(session, gray)[1].net).toBe(4);
    expect(measureSession(session, gray)[1].relative).toBe(0.05);
    fill(gray, 20, session.rows[0].bands[0].rect, 235);
    expect(measureSession(session, gray).slice(0, 2).every(result => result.relative === null)).toBe(true);
  });

  it('handles unknown or absent reference/control pairings without guessing', () => {
    const { session, gray } = analytic();
    session.rows[1].bands.pop();
    expect(measureSession(session, gray)[1].reason).toContain('缺失');
    session.controlLaneId = null;
    expect(measureSession(session, gray)[0].relative).toBeNull();
    session.rows[0].referenceRowId = null;
    expect(measureSession(session, gray)[0].reason).toContain('待指定对应内参');
  });

  it('rejects bad regions, overlaps and inconsistent row sizes', () => {
    const { session, gray } = analytic();
    session.rows[0].bands[0].backgrounds = [{ ...session.rows[0].bands[0].rect }];
    expect(measureSession(session, gray)[0].net).toBeNull();
    session.rows[0].bands[0].rect.x = -1;
    expect(measureSession(session, gray)[0].reason).toContain('越界');
    session.rows[0].bands[0].rect.width = 3;
    expect(measureSession(session, gray)[0].reason).toContain('尺寸不一致');
    expect(() => measureSession(session, gray.slice(1))).toThrow('数量');
  });

  it('counts background overlap once and reports near-black pixels neutrally without a clipping warning', () => {
    const { session, gray } = analytic();
    session.rows[0].bands[0].backgrounds.push({ ...session.rows[0].bands[0].backgrounds[0] });
    fill(gray, 20, session.rows[0].bands[0].rect, 0);
    const result = measureSession(session, gray)[0];
    expect(result.net).toBe(940);
    expect(result.warnings.some(warning => warning.includes('仅计入一次'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('面积不足'))).toBe(true);
    expect(result.nearBlackFraction).toBe(1);
    expect(result.warnings.some(warning => warning.includes('疑似像素截断'))).toBe(false);
  });

  it('pools partially overlapping unequal backgrounds by unique pixel area', () => {
    const { session, gray } = analytic();
    session.rows[0].bands[0].backgrounds = [{ x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 0, width: 3, height: 1 }];
    fill(gray, 20, { x: 0, y: 0, width: 2, height: 2 }, 245); // Four pixels with signal 10.
    fill(gray, 20, { x: 2, y: 0, width: 2, height: 1 }, 225); // Two additional pixels with signal 30.
    const measurement = measureSession(session, gray)[0];
    expect(measurement.backgroundMean).toBe(100 / 6);
    expect(measurement.net).toBe(240 - 4 * (100 / 6));
    expect(measurement.warnings.some(warning => warning.includes('仅计入一次'))).toBe(true);
  });

  it('uses current background availability instead of repeating an old automatic-search note', () => {
    const { session, gray } = analytic();
    const band = session.rows[0].bands[0];
    band.warnings = ['未找到足够干净的邻近背景，请手动指定', '模型提示存在水印'];
    let measurement = measureSession(session, gray)[0];
    expect(measurement.relative).toBe(1);
    expect(measurement.warnings).not.toContain('未找到足够干净的邻近背景，请手动指定');
    expect(measurement.warnings).toContain('模型提示存在水印');
    expect(band.warnings).toHaveLength(2); // Measurement leaves saved recognition provenance unchanged.

    band.backgrounds = [];
    measurement = measureSession(session, gray)[0];
    expect(measurement.reason).toBe('尚未指定可用背景区域');
    expect(measurement.net).toBeNull();
    expect(measurement.warnings).not.toContain('未找到足够干净的邻近背景，请手动指定');
    band.backgrounds = [{ ...band.rect }];
    expect(measureSession(session, gray)[0].reason).toBe('背景取样框与条带重叠，请重新指定');
  });

  it('recomputes panel warnings and neutral pixel information after manual corrections', () => {
    const { session, gray } = analytic();
    session.panel = { x: 3, y: 0, width: 17, height: 14 };
    session.rows[0].bands[0].warnings = ['定位异常：模型条带框超出 WB 区域，已限定到区域内，请检查'];
    fill(gray, 20, { x: 2, y: 2, width: 4, height: 2 }, 0);
    const edited = updateBandRect(session, 'target', 'a', { x: 3, y: 2, width: 2, height: 2 });
    let measurement = measureSession(edited, gray)[0];
    expect(measurement.warnings.some(warning => warning.startsWith('定位异常'))).toBe(false);
    expect(measurement.nearBlackFraction).toBe(1);
    expect(measurement.warnings.some(warning => warning.startsWith('疑似像素截断'))).toBe(false);
    expect(measurement.warnings).toContain('背景位于识别的 WB 区域之外，请确认其可比性');
    edited.panel = { x: 0, y: 0, width: 20, height: 14 };
    measurement = measureSession(edited, gray)[0];
    expect(measurement.warnings.some(warning => warning.includes('WB 区域之外'))).toBe(false);
    expect(measurement.nearBlackFraction).toBe(1);
    expect(measurement.warnings.some(warning => warning.startsWith('疑似像素截断'))).toBe(false);
  });

  it('keeps fully black bands calculable and exports their measured pixel fraction without diagnosing saturation', () => {
    const { session, gray } = analytic();
    const band = session.rows[0].bands[0];
    band.warnings = ['疑似像素截断：取样框含接近纯黑像素，无法据此判断原始曝光是否饱和', '模型提示存在水印'];
    fill(gray, 20, band.rect, 0);
    const result = measureSession(session, gray)[0];
    expect(result).toMatchObject({ bandSum: 1020, net: 940, nearBlackFraction: 1, relative: 1, reason: null });
    expect(result.warnings.some(warning => /截断|饱和/.test(warning))).toBe(false);
    expect(result.warnings).toContain('模型提示存在水印');
    expect(band.warnings).toHaveLength(2); // Source notes stay intact for provenance.
    const [header, first] = measurementsCsv(session, measureSession(session, gray)).trim().split('\r\n').map(line => line.split(','));
    expect(first[header.indexOf('near_black_pixel_fraction')]).toBe('1');
  });

  it('measures the exact near-black fraction without a warning threshold and leaves invalid regions unset', () => {
    const { session, gray } = analytic();
    const rect = session.rows[0].bands[0].rect;
    gray[rect.y * 20 + rect.x] = 0;
    gray[rect.y * 20 + rect.x + 1] = 1;
    gray[(rect.y + 1) * 20 + rect.x] = 2;
    gray[(rect.y + 1) * 20 + rect.x + 1] = 255;
    expect(measureSession(session, gray)[0].nearBlackFraction).toBe(0.5);
    rect.x = -1;
    expect(measureSession(session, gray)[0].nearBlackFraction).toBeNull();
  });
});

describe('editable sessions and provenance', () => {
  it('synchronizes row dimensions while preserving peer centers, immutability and a snapshot', () => {
    const { session } = analytic();
    const next = updateBandRect(session, 'target', 'a', { x: 3, y: 3, width: 4, height: 4 });
    expect(next.rows[0].bands.map(band => [band.rect.width, band.rect.height])).toEqual([[4, 4], [4, 4]]);
    expect(next.rows[0].bands[1].rect.x).toBe(9);
    expect(session.rows[0].bands[0].rect.width).toBe(2);
    expect(next.history[0].rows).toEqual(next.rows);
    next.rows[0].label = 'changed';
    expect(next.history[0].rows[0].label).toBe('Target');
  });

  it('clears only superseded draft notes on the edited geometry and preserves unrelated warnings', () => {
    const { session } = analytic();
    const originalNotes = ['定位异常：模型条带框超出 WB 区域，已限定到区域内，请检查', '未找到足够干净的邻近背景，请手动指定', '人工初始网格：请对齐条带并确认背景区域', '水印覆盖条带，请核对'];
    for (const band of session.rows[0].bands) band.warnings = [...originalNotes];
    const edited = updateBandRect(session, 'target', 'a', { x: 3, y: 3, width: 2, height: 2 });
    expect(edited.rows[0].bands[0].warnings).toEqual(['水印覆盖条带，请核对']);
    expect(edited.rows[0].bands[1].warnings).toEqual(originalNotes); // An untouched peer is not confirmed by a neighboring edit.
    expect(session.rows[0].bands[0].warnings).toEqual(originalNotes);
    expect(edited.history[0].rows[0].bands[0].warnings).toEqual(['水印覆盖条带，请核对']);
    const resized = updateBandRect(session, 'target', 'a', { x: 3, y: 3, width: 4, height: 4 });
    expect(resized.rows[0].bands.every(band => band.warnings.join('') === '水印覆盖条带，请核对')).toBe(true);

    const band = structuredClone(session.rows[0].bands[0]);
    refreshManualBandWarnings(band, 'background');
    expect(band.warnings).toEqual([originalNotes[0], originalNotes[3]]);
  });

  it('records the edited state and clears review confirmation', () => {
    const { session } = analytic();
    session.rows[0].label = 'Edited'; session.reviewed = true;
    const next = recordEdit(session, '改名');
    expect(next.history.at(-1)?.rows[0].label).toBe('Edited');
    expect(next.reviewed).toBe(false);
    expect(session.history).toHaveLength(0);
  });

  it('refuses additional history at the cap without truncating or changing the session', () => {
    const { session } = analytic();
    const entry = { at: session.createdAt, action: 'existing edit', rows: session.rows, lanes: session.lanes, controlLaneId: session.controlLaneId };
    session.history = Array.from({ length: 10000 }, () => entry);
    expect(() => recordEdit(session, 'one more edit')).toThrow('10000');
    expect(session.history).toHaveLength(10000);
    expect(session.history[0]).toBe(entry);
  });

  it('enforces the browser pixel and analysis-file size limits', () => {
    expect(() => createManualSession(source(5000, 4001), 2, 2)).toThrow('2000 万');
    expect(() => parseSession(' '.repeat(30 * 1024 * 1024 + 1))).toThrow('30 MB');
    // The file chooser counts UTF-8 bytes, not JavaScript UTF-16 characters.
    expect(() => parseSession('汉'.repeat(11 * 1024 * 1024))).toThrow('30 MB');
  });

  it('round trips original pixels, coordinates, provenance, and computed values without a model', () => {
    const { session, gray } = analytic();
    const saved = recordEdit(session, '测试');
    const reopened = parseSession(serializeSession(saved));
    expect(reopened).toEqual(saved);
    expect(measureSession(reopened, gray)).toEqual(measureSession(saved, gray));
  });

  it('rejects malicious or malformed imported schemas and pairing metadata', () => {
    const { session } = analytic();
    expect(() => parseSession('not json')).toThrow('JSON');
    expect(() => parseSession(JSON.stringify({ ...session, apiKey: 'secret' }))).toThrow('格式');
    expect(() => parseSession(JSON.stringify({ ...session, source: { ...session.source, dataUrl: 'https://example.com/tracker.png' } }))).toThrow('格式');
    expect(() => parseSession(JSON.stringify({ ...session, source: { ...session.source, sha256: 'not-a-hash' } }))).toThrow('格式');
    expect(() => parseSession(JSON.stringify({ ...session, algorithmVersion: 'unknown' }))).toThrow('格式');
    session.rows[0].referenceRowId = 'absent';
    expect(() => parseSession(JSON.stringify(session))).toThrow('内参');
    session.rows[0].referenceRowId = 'ref'; session.rows[0].bands[0].rect.x = 99;
    expect(() => parseSession(JSON.stringify(session))).toThrow('越界');
  });

  it('creates an explicitly unpaired manual grid and protects CSV from injected formulas', () => {
    const manual = createManualSession(source(300, 200), 3, 5);
    expect(manual.rows).toHaveLength(5);
    expect(manual.rows.every(row => row.bands.length === 3 && row.referenceRowId === null)).toBe(true);
    expect(manual.controlLaneId).toBe('lane-1');
    const { session, gray } = analytic();
    session.rows[0].label = '=HYPERLINK("https://example.com")';
    const csv = measurementsCsv(session, measureSession(session, gray));
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('relative_to_control');
  });

  it('exports original recognition notes separately from current measurement warnings', () => {
    const { session, gray } = analytic();
    session.warnings = ['识别时未找到对照名称'];
    const [header, firstRow] = measurementsCsv(session, measureSession(session, gray)).trim().split('\r\n').map(line => line.split(','));
    expect(header.at(-1)).toBe('recognition_notes');
    expect(firstRow[header.indexOf('recognition_notes')]).toBe('识别时未找到对照名称');
    expect(firstRow[header.indexOf('warnings')]).not.toContain('识别时未找到对照名称');
    expect(firstRow[header.indexOf('warnings')]).toContain('背景面积不足');
    expect(firstRow[header.indexOf('relative_to_control')]).toBe('1');
  });
});

describe('model geometry conversion', () => {
  function mockDetection(): { gray: Uint8Array; result: RecognitionResult } {
    const detection: Detection = { panel: { x: 0.1, y: 0.02, width: 0.8, height: 0.95 },
      lanes: [{ id: 'a', label: 'Ctrl' }, { id: 'b', label: 'Treatment' }], controlLaneId: null, warnings: ['模型提示存在水印'],
      rows: Array.from({ length: 5 }, (_, index) => ({ id: `r${index}`, label: index === 4 ? 'β-actin' : `Target ${index}`, role: 'target', referenceRowId: index === 4 ? null : 'r4',
        bands: ['a', 'b'].map((laneId, column) => ({ laneId, rect: { x: 0.2 + column * 0.4, y: 0.08 + index * 0.17, width: 0.2, height: 0.07 } })) })),
    };
    const gray = new Uint8Array(10000).fill(235);
    for (const row of detection.rows) for (const band of row.bands) fill(gray, 100, { x: Math.round(band.rect.x * 100), y: Math.round(band.rect.y * 100), width: 20, height: 7 }, 150);
    return { gray, result: { detection, providerBaseUrl: 'https://api.example.test/v1', model: 'fixed-test-fixture', promptVersion: 'test-1', rawResponse: JSON.stringify(detection), createdAt: '2026-10-10T10:00:00.000Z' } };
  }

  it('maps 5×2 normalized boxes to original integer pixels, suggests unambiguous pairings and preserves warnings', () => {
    const { gray, result } = mockDetection();
    const session = sessionFromDetection(source(100, 100), gray, result);
    expect(session.rows).toHaveLength(5);
    expect(session.rows.every(row => row.bands.length === 2)).toBe(true);
    expect(session.controlLaneId).toBe('a');
    expect(session.rows[4].role).toBe('reference');
    expect(session.rows[0].referenceRowId).toBe('r4');
    expect(session.rows[0].bands[0].rect).toEqual({ x: 20, y: 8, width: 20, height: 7 });
    expect(session.rows.every(row => row.bands.every(band => band.backgrounds.length > 0))).toBe(true);
    expect(session.warnings).toContain('模型提示存在水印');
    expect(session.recognition?.rawResponse).toBe(result.rawResponse);
  });

  it('defaults new detections to the leftmost observed lane rather than model order or control label', () => {
    const { gray, result } = mockDetection();
    result.detection.lanes = [{ id: 'b', label: 'Ctrl' }, { id: 'a', label: 'KOA' }];
    result.detection.controlLaneId = 'b';
    const session = sessionFromDetection(source(100, 100), gray, result);
    expect(session.controlLaneId).toBe('a');
    session.controlLaneId = 'b';
    expect(parseSession(serializeSession(session)).controlLaneId).toBe('b'); // Loading preserves an explicit prior choice.
  });

  it('preserves the exact source-pixel input crop with the original model response and rejects invalid crops', () => {
    const { gray, result } = mockDetection();
    result.inputRegion = { x: 10, y: 5, width: 80, height: 90 };
    const session = sessionFromDetection(source(100, 100), gray, result);
    const reopened = parseSession(serializeSession(session));
    expect(reopened.recognition?.inputRegion).toEqual(result.inputRegion);
    expect(reopened.recognition?.rawResponse).toBe(result.rawResponse);
    result.inputRegion = { x: 90, y: 5, width: 80, height: 90 };
    expect(() => sessionFromDetection(source(100, 100), gray, result)).toThrow('识别截图区域越界');
    result.inputRegion = { x: 10.5, y: 5, width: 80, height: 90 };
    expect(() => sessionFromDetection(source(100, 100), gray, result)).toThrow();
  });

  it('preserves missing lanes and rejects unknown labels, duplicate pairs, out-of-bounds geometry and credential-bearing metadata', () => {
    const { gray, result } = mockDetection();
    result.detection.rows[0].bands.pop();
    expect(sessionFromDetection(source(100, 100), gray, result).rows[0].bands).toHaveLength(1);
    result.detection.rows[0].bands[0].laneId = 'absent';
    expect(() => sessionFromDetection(source(100, 100), gray, result)).toThrow('泳道');
    result.detection.rows[0].bands[0].laneId = 'a';
    result.detection.rows[0].bands[0].rect.x = 0.99;
    expect(() => sessionFromDetection(source(100, 100), gray, result)).toThrow('归一化');
    result.detection.rows[0].bands[0].rect.x = 0.2;
    result.providerBaseUrl = 'https://name:secret@api.example.test/v1';
    expect(() => sessionFromDetection(source(100, 100), gray, result)).toThrow();
  });

  it('preserves an explicitly uncertain reference pairing even with one canonical reference', () => {
    const { gray, result } = mockDetection();
    result.detection.rows[0].referenceRowId = null;
    const session = sessionFromDetection(source(100, 100), gray, result);
    expect(session.rows[4].role).toBe('reference');
    expect(session.rows[0].referenceRowId).toBeNull();
    const target = measureSession(session, gray).find(measurement => measurement.rowId === 'r0');
    expect(target?.relative).toBeNull();
    expect(target?.reason).toBe('待指定对应内参');
  });

  it('does not duplicate a missing reference lane or pair it with a neighboring reference', () => {
    const { gray, result } = mockDetection();
    result.detection.rows[4].bands = result.detection.rows[4].bands.filter(band => band.laneId === 'a');
    const session = sessionFromDetection(source(100, 100), gray, result);
    expect(session.rows[4].bands.map(band => band.laneId)).toEqual(['a']);
    const missing = measureSession(session, gray).find(measurement => measurement.rowId === 'r0' && measurement.laneId === 'b');
    expect(missing?.referenceNet).toBeNull();
    expect(missing?.relative).toBeNull();
    expect(missing?.reason).toContain('内参缺失');
  });
});
