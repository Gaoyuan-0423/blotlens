import { describe, expect, it } from 'vitest';
import { assertScreenshotOrientation } from './image-metadata';
import { validateImageInput } from '../server/image';

// Minimal metadata-bearing JPEG, with SOF dimensions 40 x 20. Pixel decoding is
// deliberately outside these parser tests; browser integration tests cover it.
function jpeg(orientation: number, little = true): Uint8Array {
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, little); view.setUint32(4, 8, little);
  view.setUint16(8, 1, little); view.setUint16(10, 0x0112, little);
  view.setUint16(12, 3, little); view.setUint32(14, 1, little);
  view.setUint16(18, orientation, little);
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff,
    0xff, 0xc0, 0, 11, 8, 0, 20, 0, 40, 1, 1, 0x11, 0,
    0xff, 0xd9,
  ]);
}
const rotated = 'JPEG 含旋转或翻转方向信息，请另存为 PNG 截图后导入。';
const malformed = 'JPEG EXIF 方向信息无效，请另存为 PNG 截图后导入。';

describe('screenshot EXIF orientation', () => {
  it('allows PNG, ordinary JPEG, unrelated APP1 metadata and explicit orientation 1', () => {
    for (const bytes of [
      new Uint8Array([137, 80, 78, 71]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 6, 1, 2, 3, 4, 0xff, 0xd9]),
      jpeg(1, true), jpeg(1, false),
    ]) expect(() => assertScreenshotOrientation(bytes)).not.toThrow();
  });

  it('rejects every rotated or mirrored orientation in either byte order', () => {
    for (const little of [true, false]) for (let orientation = 2; orientation <= 8; orientation++) {
      expect(() => assertScreenshotOrientation(jpeg(orientation, little))).toThrow(rotated);
    }
  });

  it('honors Uint8Array byteOffset and does not modify the original bytes', () => {
    const original = jpeg(6);
    const padded = new Uint8Array(original.length + 20); padded.set(original, 7);
    const slice = padded.subarray(7, 7 + original.length);
    expect(() => assertScreenshotOrientation(slice)).toThrow(rotated);
    expect([...slice]).toEqual([...original]);
  });

  it('allows EXIF with no orientation and ignores an absent primary IFD', () => {
    const noTag = jpeg(6); new DataView(noTag.buffer).setUint16(22, 0x0100, true);
    expect(() => assertScreenshotOrientation(noTag)).not.toThrow();
    const noIfd = jpeg(6); new DataView(noIfd.buffer).setUint32(16, 0, true);
    expect(() => assertScreenshotOrientation(noIfd)).not.toThrow();
  });

  it('checks multiple APP1 segments and metadata after the SOF', () => {
    const first = jpeg(1), second = jpeg(6);
    const combined = new Uint8Array([...first.subarray(0, -2), ...second.subarray(2)]);
    expect(() => assertScreenshotOrientation(combined)).toThrow(rotated);
  });

  it('stops at compressed scan data and accepts JPEG marker padding', () => {
    expect(() => assertScreenshotOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, ...jpeg(6)]))).not.toThrow();
    const bytes = jpeg(6);
    const padded = new Uint8Array([0xff, 0xd8, 0xff, ...bytes.subarray(2)]);
    expect(() => assertScreenshotOrientation(padded)).toThrow(rotated);
  });

  it('rejects malformed lengths, TIFF offsets/types and unknown orientations without out-of-bounds reads', () => {
    const cases: Uint8Array[] = [
      new Uint8Array([0xff, 0xd8, 0xff]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 255]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 1]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0]),
      jpeg(0), jpeg(9),
    ];
    const order = jpeg(1); order[12] = 0; cases.push(order);
    const magic = jpeg(1); magic[14] = 0; cases.push(magic);
    const offset = jpeg(1); new DataView(offset.buffer).setUint32(16, 0xffff_ffff, true); cases.push(offset);
    const count = jpeg(1); new DataView(count.buffer).setUint16(20, 65535, true); cases.push(count);
    const type = jpeg(1); new DataView(type.buffer).setUint16(24, 4, true); cases.push(type);
    const valueCount = jpeg(1); new DataView(valueCount.buffer).setUint32(26, 2, true); cases.push(valueCount);
    for (const bytes of cases) expect(() => assertScreenshotOrientation(bytes)).toThrow(malformed);
  });

  it('rejects rotated images at the server before comparing decoder dimensions', () => {
    const dataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg(6)).toString('base64')}`;
    expect(() => validateImageInput({ dataUrl, width: 20, height: 40 })).toThrow(rotated);
    expect(() => validateImageInput({ dataUrl, width: 40, height: 20 })).toThrow(rotated);
    const upright = `data:image/jpeg;base64,${Buffer.from(jpeg(1)).toString('base64')}`;
    expect(validateImageInput({ dataUrl: upright, width: 40, height: 20 })).toEqual({ dataUrl: upright, width: 40, height: 20 });
  });
});
