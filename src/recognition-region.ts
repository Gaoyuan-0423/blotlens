import { validateDetection } from '../shared/detection';
import { rectWithinImage } from './core';
import type { Detection, Rect, SourceImage } from './core/types';
import { decodeScreenshotImage } from './image-io';

type SourceDimensions = Pick<SourceImage, 'width' | 'height'>;

export interface PreparedRecognitionImage {
  image: { dataUrl: string; width: number; height: number };
  /** Integer original-image coordinates; absent means the complete original. */
  inputRegion?: Rect;
}

function validateDimensions(source: SourceDimensions): void {
  if (![source.width, source.height].every(value => Number.isInteger(value) && value > 0 && value <= 16000)
    || source.width * source.height > 20_000_000) throw new Error('原图尺寸无效或超过支持的像素范围');
}

function validateRegion(region: Rect, source: SourceDimensions): void {
  validateDimensions(source);
  if (!rectWithinImage(region, source.width, source.height)) throw new Error('识别区域必须是原图内的有效整数像素区域');
}

/** Crop only the AI input, without scaling, changing the source, or changing measurement pixels. */
export async function prepareRecognitionImage(source: SourceImage, region?: Rect): Promise<PreparedRecognitionImage> {
  validateDimensions(source);
  if (!region) return { image: { dataUrl: source.dataUrl, width: source.width, height: source.height } };
  validateRegion(region, source);
  // Capture the geometry before decoding yields, so a concurrent UI drag does
  // not change the region represented by this pending recognition request.
  const crop = { ...region };
  const decoded = await decodeScreenshotImage(source.dataUrl);
  if (decoded.naturalWidth !== source.width || decoded.naturalHeight !== source.height) throw new Error('图片实际尺寸与识别来源不符');
  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成选区识别图片');
  // Transparent pixels have the same white-background interpretation used by
  // local measurements. Preview zoom / contrast never enter this canvas.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, crop.width, crop.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(decoded, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const dataUrl = canvas.toDataURL('image/png');
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('无法生成选区的 PNG 图片');
  if (dataUrl.length > 24 * 1024 * 1024 - 4096) throw new Error('选区生成的 PNG 过大，请缩小识别区域');
  return { image: { dataUrl, width: crop.width, height: crop.height }, inputRegion: crop };
}

/** Map model fractions of the crop back to fractions of the complete original image. */
export function mapRegionDetection(detection: Detection, crop: Rect, source: SourceDimensions): Detection {
  validateRegion(crop, source);
  const valid = validateDetection(detection);
  const mapRect = (rect: Rect): Rect => ({
    x: (crop.x + rect.x * crop.width) / source.width,
    y: (crop.y + rect.y * crop.height) / source.height,
    width: rect.width * crop.width / source.width,
    height: rect.height * crop.height / source.height,
  });
  // Preserve the model's labels, missing lanes, pairings, and warnings. Pixels
  // are rounded once later, by the normal original-image session constructor.
  return validateDetection({
    ...valid,
    panel: mapRect(valid.panel),
    rows: valid.rows.map(row => ({ ...row, bands: row.bands.map(band => ({ ...band, rect: mapRect(band.rect) })) })),
  });
}
