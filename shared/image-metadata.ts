const ROTATED_MESSAGE = 'JPEG 含旋转或翻转方向信息，请另存为 PNG 截图后导入。';
const INVALID_MESSAGE = 'JPEG EXIF 方向信息无效，请另存为 PNG 截图后导入。';

function invalid(): never { throw new Error(INVALID_MESSAGE); }

/** Read only the primary-image TIFF IFD. Thumbnail orientation does not affect
 * the screenshot. All offsets remain bounded by this single EXIF APP1 segment. */
function assertExifOrientation(bytes: Uint8Array, start: number, end: number): void {
  const length = end - start;
  if (length < 8) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
  const little = view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49;
  const big = view.getUint8(0) === 0x4d && view.getUint8(1) === 0x4d;
  if ((!little && !big) || view.getUint16(2, little) !== 42) invalid();
  const offset = view.getUint32(4, little);
  if (offset === 0) return; // No primary IFD, hence no primary orientation tag.
  if (offset < 8 || offset > length - 2) invalid();
  const count = view.getUint16(offset, little);
  if (offset + 2 + count * 12 + 4 > length) invalid();
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    // EXIF Orientation is exactly one SHORT, stored inline in the value field.
    if (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) invalid();
    const orientation = view.getUint16(entry + 8, little);
    if (orientation >= 2 && orientation <= 8) throw new Error(ROTATED_MESSAGE);
    if (orientation !== 1) invalid();
  }
}

/** Reject implicit JPEG transforms before browser/provider decoders can disagree
 * about pixel coordinates. This browser-safe check never modifies source bytes.
 * PNG and JPEG without EXIF orientation (or with Orientation=1) pass unchanged. */
export function assertScreenshotOrientation(bytes: Uint8Array): void {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid();
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return; // End or compressed scan.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalid();
    const length = bytes[offset] * 256 + bytes[offset + 1];
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    const payload = offset + 2;
    if (marker === 0xe1 && end - payload >= 6
      && bytes[payload] === 0x45 && bytes[payload + 1] === 0x78
      && bytes[payload + 2] === 0x69 && bytes[payload + 3] === 0x66
      && bytes[payload + 4] === 0 && bytes[payload + 5] === 0) {
      assertExifOrientation(bytes, payload + 6, end);
    }
    offset = end;
  }
}
