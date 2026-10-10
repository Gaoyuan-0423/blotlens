import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chart } from './Chart';
import type { ReviewSession } from './core/types';

function session(): ReviewSession {
  return {
    format: 'wb-review', schemaVersion: 1, appVersion: '0.1.0', algorithmVersion: 'screenshot-density-1',
    source: { name: 'screenshot.png', width: 20, height: 20, dataUrl: '', sha256: 'a'.repeat(64) },
    panel: { x: 0, y: 0, width: 20, height: 20 },
    lanes: [{ id: 'ctrl', label: 'KOA' }], rows: [], controlLaneId: 'ctrl',
    reviewed: false, warnings: [], recognition: null, history: [], createdAt: '2026-10-11T00:00:00.000Z',
  };
}

describe('chart calculation mode labels', () => {
  it('includes a visible uncorrected mode label inside the SVG used by PNG and SVG exports', () => {
    const input = session();
    input.measurementPolicy = { maxBandOverlapFraction: 0.1, backgroundMode: 'none' };
    const svg = renderToStaticMarkup(createElement(Chart, { session: input, measurements: [] }));
    expect(svg).toContain('data-background-mode="none"');
    expect(svg).toMatch(/<text[^>]*>快速趋势 · 未扣背景<\/text>/);
    expect(svg).toContain('截图灰度估计的相对强度');
    expect(svg).toContain('无误差线 / 无统计检验');
  });

  it('shows background subtraction explicitly and defaults legacy files to subtraction', () => {
    const input = session();
    for (const policy of [undefined, { maxBandOverlapFraction: 0.1 as const }, { maxBandOverlapFraction: 0.1 as const, backgroundMode: 'subtract' as const }]) {
      input.measurementPolicy = policy;
      const svg = renderToStaticMarkup(createElement(Chart, { session: input, measurements: [] }));
      expect(svg).toContain('data-background-mode="subtract"');
      expect(svg).toMatch(/<text[^>]*>背景扣除 · 已扣背景<\/text>/);
      expect(svg).not.toContain('快速趋势 · 未扣背景');
    }
  });
});
