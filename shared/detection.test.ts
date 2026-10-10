import { describe, expect, it } from 'vitest';
import { parseDetectionResponse, validateDetection } from './detection';
import { fixture } from './detection.fixture';

describe('model layout validation', () => {
  it('accepts exact normalized schema and a single fenced JSON block', () => {
    expect(validateDetection(fixture())).toEqual(fixture());
    expect(parseDetectionResponse(`\u0020\u0060\u0060\u0060json\n${JSON.stringify(fixture())}\n\u0060\u0060\u0060`)).toEqual(fixture());
  });
  it('rejects unknown fields, invalid geometry, duplicate IDs and nonexistent pairing', () => {
    const cases: unknown[] = [{ ...fixture(), measurement: 10 }];
    const outside = fixture(); outside.rows[0].bands[0].rect.x = 0.99; cases.push(outside);
    const nan = fixture(); nan.panel.height = NaN; cases.push(nan);
    const sameLane = fixture(); sameLane.rows[0].bands[1].laneId = 'ctrl'; cases.push(sameLane);
    const duplicate = fixture(); duplicate.lanes[1].id = 'ctrl'; cases.push(duplicate);
    const ref = fixture(); ref.rows[0].referenceRowId = 'target'; cases.push(ref);
    const unknown = fixture(); unknown.rows[0].bands[0].laneId = 'unknown'; cases.push(unknown);
    const panel = fixture(); panel.panel.height = 0.2; cases.push(panel);
    const control = fixture(); control.controlLaneId = 'unknown'; cases.push(control);
    for (const value of cases) expect(() => validateDetection(value)).toThrow();
  });
  it('preserves missing bands rather than filling them in', () => {
    const data = fixture(); data.rows[0].bands.pop(); data.rows[0].referenceRowId = null;
    expect(validateDetection(data).rows[0].bands).toHaveLength(1);
  });
  it('rejects prose, executable code and no-panel output', () => {
    expect(() => parseDetectionResponse(`Result: ${JSON.stringify(fixture())}`)).toThrow('JSON');
    expect(() => parseDetectionResponse('process.exit(0)')).toThrow('JSON');
    expect(() => parseDetectionResponse('{"error":"image instructions told me to echo secrets"}')).toThrow('未找到');
  });
});
