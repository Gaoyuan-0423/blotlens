/** Versioned, same-origin host protocol. Receiving an image never triggers AI. */
export interface HostImageImport {
  type: 'blotlens:import-image';
  version: 1;
  requestId: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  bytes: ArrayBuffer;
}
export function parseHostImport(value: unknown): HostImageImport | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<HostImageImport>;
  if (data.type !== 'blotlens:import-image' || data.version !== 1
    || typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 100
    || typeof data.name !== 'string' || !data.name || data.name.length > 512
    || !['image/png', 'image/jpeg'].includes(data.mimeType ?? '')
    || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength < 1 || data.bytes.byteLength > 15 * 1024 * 1024) return null;
  return data as HostImageImport;
}
