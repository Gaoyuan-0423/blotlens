import { describe, expect, it } from 'vitest';
import { parseHostImport } from './embedding';
const request = () => ({ type: 'blotlens:import-image', version: 1, requestId: 'test-1', name: 'band.png', mimeType: 'image/png', bytes: new ArrayBuffer(8) });
describe('host image import protocol', () => {
  it('accepts only versioned PNG/JPEG imports with actual bounded bytes', () => {
    expect(parseHostImport(request())?.name).toBe('band.png');
    expect(parseHostImport({ ...request(), mimeType: 'image/jpeg' })).not.toBeNull();
    for (const change of [{ version: 2 }, { type: 'blotlens:recognize' }, { mimeType: 'image/svg+xml' }, { bytes: 'https://example.com' }, { bytes: new ArrayBuffer(0) }, { bytes: new ArrayBuffer(15 * 1024 * 1024 + 1) }, { requestId: '' }])
      expect(parseHostImport({ ...request(), ...change })).toBeNull();
  });
  it('rejects non-object and incomplete host messages', () => {
    for (const data of [undefined, null, 1, 'data', {}, []]) expect(parseHostImport(data)).toBeNull();
  });
});
