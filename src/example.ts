import type { Detection, SourceImage } from './core/types';

/** A locally generated illustration. Neither the image nor its annotations are model output. */
export async function createExample(): Promise<{ source: SourceImage; detection: Detection }> {
  const width = 900;
  const height = 650;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建示例图片');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 25px sans-serif';
  ctx.fillText('SYNTHETIC WB · LOCAL DEMO', 42, 46);
  ctx.font = '17px sans-serif';
  ctx.fillStyle = '#566070';
  ctx.fillText('Known simulated patterns — no biological experiment or model call', 42, 74);
  const lanes = [
    { id: 'lane-1', label: 'Ctrl' },
    { id: 'lane-2', label: 'Treatment' },
    { id: 'lane-3', label: 'Rescue' },
  ];
  const centers = [270, 465, 660];
  const definitions = [
    { id: 'comp', label: 'COMP', amplitudes: [60, 96, 66] },
    { id: 'tnf', label: 'TNF-α', amplitudes: [70, 98, 70] },
    { id: 'il6', label: 'IL-6', amplitudes: [58, 87, 59] },
    { id: 'il10', label: 'IL-10', amplitudes: [90, 48, 81] },
    { id: 'actin', label: 'β-actin', amplitudes: [90, 90, 90] },
  ];
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1f2937';
  ctx.font = '18px sans-serif';
  lanes.forEach((lane, i) => ctx.fillText(lane.label, centers[i], 111));
  const rows: Detection['rows'] = definitions.map((definition, rowIndex) => {
    const cy = 160 + rowIndex * 90;
    const strip = ctx.createImageData(585, 72);
    for (let y = 0; y < 72; y += 1) {
      for (let x = 0; x < 585; x += 1) {
        const px = x + 180;
        const py = y + cy - 36;
        let signal = 22 + (((x * 7 + y * 11) % 5) - 2);
        for (let laneIndex = 0; laneIndex < 3; laneIndex += 1) {
          const dx = (px - centers[laneIndex]) / 46;
          const dy = (py - cy) / 7;
          if (Math.abs(dx) < 1.25 && Math.abs(dy) < 2.2) {
            signal += definition.amplitudes[laneIndex] * Math.exp(-(dx ** 6) - dy ** 2);
          }
        }
        const gray = 255 - Math.round(signal);
        const offset = (y * 585 + x) * 4;
        strip.data.set([gray, gray, gray, 255], offset);
      }
    }
    ctx.putImageData(strip, 180, cy - 36);
    ctx.strokeStyle = '#a2a7ad';
    ctx.lineWidth = 1;
    ctx.strokeRect(180.5, cy - 35.5, 584, 71);
    ctx.textAlign = 'right';
    ctx.font = 'bold 21px sans-serif';
    ctx.fillStyle = '#1f2937';
    ctx.fillText(definition.label, 157, cy + 7);
    return {
      id: definition.id,
      label: definition.label,
      role: rowIndex === 4 ? 'reference' : 'target',
      referenceRowId: rowIndex === 4 ? null : 'actin',
      bands: lanes.map((lane, i) => ({
        laneId: lane.id,
        rect: { x: (centers[i] - 59) / width, y: (cy - 16) / height, width: 118 / width, height: 32 / height },
      })),
    };
  });
  ctx.textAlign = 'left';
  ctx.fillStyle = '#566070';
  ctx.font = '16px sans-serif';
  ctx.fillText('Synthetic signal amplitudes: COMP 1 / 1.60 / 1.10 · TNF-α 1 / 1.40 / 1.00', 42, 595);
  ctx.fillText('IL-6 1 / 1.50 / 1.02 · IL-10 1 / 0.53 / 0.90 · Reference is constant', 42, 620);
  const dataUrl = canvas.toDataURL('image/png');
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (character) => character.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    source: { name: 'synthetic-local-example.png', dataUrl, width, height, sha256 },
    detection: {
      panel: { x: 180 / width, y: 124 / height, width: 585 / width, height: 432 / height },
      lanes,
      rows,
      controlLaneId: 'lane-1',
      warnings: ['本例为本地程序生成的合成图；区域来自已知绘图坐标，未调用模型，不代表实验或识别准确率。'],
    },
  };
}
