import type { ReviewSession } from './core/types';

export const PALETTES = {
  classic: { label: '柔和经典', colors: ['#24776f', '#e4a057', '#739dbf', '#ae80a0', '#919c50', '#ce7669', '#6885a8', '#9d8f7a'] },
  vivid: { label: '明亮对比', colors: ['#3b6fb6', '#e27835', '#429870', '#ac5c9f', '#b49b32', '#c94e5b', '#4a9ca8', '#7865aa'] },
  distinct: { label: '蓝橙绿', colors: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#999999', '#666600'] },
  gray: { label: '灰度', colors: ['#333333', '#888888', '#bbbbbb', '#555555', '#999999', '#dddddd', '#707070', '#aaaaaa'] },
} as const;

export function laneColor(session: Pick<ReviewSession, 'lanes' | 'chartStyle'>, index: number): string {
  const palette = PALETTES[session.chartStyle?.palette ?? 'classic'].colors;
  return session.chartStyle?.colors?.[session.lanes[index]?.id] ?? palette[index % palette.length];
}
