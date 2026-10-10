import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Detection, Rect, SourceImage } from './core/types';
import { mapRegionDetection, prepareRecognitionImage } from './recognition-region';

function detection(): Detection {
  return {
    panel: { x: 0, y: 0, width: 1, height: 1 },
    lanes: [{ id: 'left', label: 'KOA' }, { id: 'right', label: 'AP' }],
    rows: [
      { id: 'target', label: 'COMP', role: 'target', referenceRowId: 'ref', bands: [
        { laneId: 'left', rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } },
      ] },
      { id: 'ref', label: 'β-actin', role: 'reference', referenceRowId: null, bands: [
        { laneId: 'left', rect: { x: 0.1, y: 0.7, width: 0.2, height: 0.1 } },
        { laneId: 'right', rect: { x: 0.7, y: 0.7, width: 0.2, height: 0.1 } },
      ] },
    ],
    controlLaneId: null, warnings: ['COMP / AP is not visible inside this crop'],
  };
}

function source(width = 1000, height = 800): SourceImage {
  return { name: 'original.png', dataUrl: 'data:image/png;base64,AQ==', width, height, sha256: 'a'.repeat(64) };
}

describe('recognition region coordinates', () => {
  it('maps crop-normalized coordinates to original-image fractions while retaining metadata and missing bands', () => {
    const input = detection(), preserved = structuredClone(input);
    const mapped = mapRegionDetection(input, { x: 100, y: 160, width: 500, height: 400 }, source());
    expect(mapped.panel).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
    expect(mapped.rows[0].bands[0].rect).toEqual({ x: 0.15, y: 0.3, width: 0.1, height: 0.05 });
    expect(mapped.rows[0].bands).toHaveLength(1);
    expect(mapped.rows[0].referenceRowId).toBe('ref');
    expect(mapped.rows[1].role).toBe('reference');
    expect(mapped.lanes).toEqual(input.lanes);
    expect(mapped.controlLaneId).toBeNull();
    expect(mapped.warnings).toEqual(input.warnings);
    expect(input).toEqual(preserved);
    mapped.lanes[0].label = 'Changed';
    expect(input.lanes[0].label).toBe('KOA');
  });

  it('maps a whole-image region without changing coordinate values', () => {
    const input = detection();
    expect(mapRegionDetection(input, { x: 0, y: 0, width: 1000, height: 800 }, source())).toEqual(input);
  });

  it('preserves fractional pixel positions until the session rounds them and handles a crop at the lower-right boundary', () => {
    const mapped = mapRegionDetection(detection(), { x: 355, y: 411, width: 1, height: 1 }, source(356, 412));
    expect(mapped.panel.x * 356).toBeCloseTo(355);
    expect((mapped.panel.x + mapped.panel.width) * 356).toBeCloseTo(356);
    expect((mapped.panel.y + mapped.panel.height) * 412).toBeCloseTo(412);
    expect(mapped.rows[0].bands[0].rect.x * 356).toBeCloseTo(355.1);
    expect(mapped.rows[0].bands[0].rect.width * 356).toBeCloseTo(0.2);
  });

  it.each<Rect>([
    { x: -1, y: 0, width: 100, height: 100 },
    { x: 0.5, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 0, height: 100 },
    { x: 901, y: 0, width: 100, height: 100 },
    { x: 0, y: 701, width: 100, height: 100 },
    { x: Number.NaN, y: 0, width: 100, height: 100 },
  ])('rejects invalid crop geometry %j', crop => {
    expect(() => mapRegionDetection(detection(), crop, source())).toThrow('整数像素区域');
  });

  it('validates source dimensions and model-controlled output before translating coordinates', () => {
    const crop = { x: 0, y: 0, width: 100, height: 100 };
    expect(() => mapRegionDetection(detection(), crop, source(1000.5, 800))).toThrow('原图尺寸');
    expect(() => mapRegionDetection(detection(), crop, source(16000, 16000))).toThrow('原图尺寸');
    const invalid = detection();
    invalid.rows[0].bands[0].rect.x = 1;
    expect(() => mapRegionDetection(invalid, crop, source())).toThrow('边界');
    const missingLane = detection();
    missingLane.rows[0].bands[0].laneId = 'not-visible';
    expect(() => mapRegionDetection(missingLane, crop, source())).toThrow('不存在');
    const offPanel = detection();
    offPanel.panel = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    expect(() => mapRegionDetection(offPanel, crop, source())).toThrow('WB 区域');
  });
});

describe('recognition image preparation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the original image bytes and dimensions when no crop was requested', async () => {
    const original = source();
    expect(await prepareRecognitionImage(original)).toEqual({ image: { dataUrl: original.dataUrl, width: 1000, height: 800 } });
  });

  it('rejects crop bounds before attempting a browser decode', async () => {
    await expect(prepareRecognitionImage(source(), { x: 999, y: 0, width: 2, height: 1 })).rejects.toThrow('整数像素区域');
  });

  it('draws exactly the original pixel rectangle on a white PNG canvas with no scaling or preview transforms', async () => {
    const drawImage = vi.fn(), fillRect = vi.fn();
    const context = { drawImage, fillRect, fillStyle: '', imageSmoothingEnabled: true };
    const toDataURL = vi.fn(() => 'data:image/png;base64,Ag==');
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toDataURL };
    const decoded: unknown[] = [];
    class TestImage {
      naturalWidth = 1000; naturalHeight = 800;
      onload: (() => void) | null = null;
      set src(_value: string) { decoded.push(this); queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const region = { x: 100, y: 160, width: 500, height: 400 };
    const promise = prepareRecognitionImage(source(), region);
    region.x = 200; // Pending request must retain the region selected at start.
    expect(await promise).toEqual({ image: { dataUrl: 'data:image/png;base64,Ag==', width: 500, height: 400 },
      inputRegion: { x: 100, y: 160, width: 500, height: 400 } });
    expect(canvas.width).toBe(500);
    expect(canvas.height).toBe(400);
    expect(context.fillStyle).toBe('#ffffff');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 500, 400);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(drawImage).toHaveBeenCalledWith(decoded[0], 100, 160, 500, 400, 0, 0, 500, 400);
    expect(toDataURL).toHaveBeenCalledWith('image/png');
  });
});
