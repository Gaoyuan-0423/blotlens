import { assertScreenshotOrientation } from '../shared/image-metadata';

export interface ImageInput { dataUrl: string; width: number; height: number }

function dimensions(buffer: Buffer, mime: string): { width: number; height: number } {
  if (mime === 'png') {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 文件头无效');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('JPEG 文件头无效');
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset++] !== 0xff) throw new Error('JPEG 段结构无效');
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error('JPEG 段长度无效');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new Error('JPEG 尺寸段无效');
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new Error('无法读取 JPEG 尺寸');
}

export function validateImageInput(value: unknown): ImageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('缺少图像');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['dataUrl', 'width', 'height'].includes(key))) throw new Error('图像包含未知字段');
  if (typeof item.dataUrl !== 'string') throw new Error('图像数据无效');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new Error('仅支持 base64 PNG/JPEG 图像');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 18 * 1024 * 1024) throw new Error('图像文件须小于 18 MiB');
  if (match[1] === 'jpeg') assertScreenshotOrientation(buffer);
  const size = dimensions(buffer, match[1]);
  if (size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384 || size.width * size.height > 64_000_000) throw new Error('图像尺寸超出限制（最大 6400 万像素，单边 16384）');
  if (item.width !== size.width || item.height !== size.height) throw new Error('传入尺寸与图像原始像素尺寸不符');
  return { dataUrl: item.dataUrl, ...size };
}
