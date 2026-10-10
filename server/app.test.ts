import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createReviewerServer, sanitizeBaseUrl, type ServerOptions } from './app';
import { validateImageInput } from './image';
import { fixture } from '../shared/detection.fixture';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=';
const requestBody = { image: { dataUrl: png, width: 1, height: 1 } };
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function setup(options: ServerOptions = {}) {
  const origin = await listen(createReviewerServer(options));
  const post = (path: string, body: unknown, overrides?: RequestInit) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...overrides,
  });
  const configure = (extra = {}) => post('/api/config', { baseUrl: 'https://vision.example/v1', model: 'vision-test', apiKey: 'secret-api-key', ...extra });
  return { origin, post, configure };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe('localhost API', () => {
  it('keeps the key in memory, never returns it, and supports retain/clear', async () => {
    const { origin, post, configure } = await setup();
    const saved = await configure();
    expect(await saved.json()).toEqual({ baseUrl: 'https://vision.example/v1', model: 'vision-test', keyConfigured: true });
    await post('/api/config', { baseUrl: 'https://vision.example/v1/', model: 'other' });
    expect(await (await fetch(`${origin}/api/config`)).json()).toEqual({ baseUrl: 'https://vision.example/v1', model: 'other', keyConfigured: true });
    await configure({ apiKey: '' });
    expect((await (await fetch(`${origin}/api/config`)).json()).keyConfigured).toBe(false);
    const second = await setup();
    expect((await (await fetch(`${second.origin}/api/config`)).json()).keyConfigured).toBe(false);
  });

  it('enforces exact Host and same Origin and rejects absent mutation Origin', async () => {
    const { origin, post } = await setup();
    const hostStatus = await new Promise<number | undefined>((resolve) => {
      httpRequest(`${origin}/api/config`, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).end();
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(`${origin}/api/config`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await post('/api/config', {}, { headers: { 'Content-Type': 'application/json' } })).status).toBe(403);
    expect((await post('/api/config', {}, { headers: { Origin: 'null', 'Content-Type': 'application/json' } })).status).toBe(403);
    expect((await fetch(`${origin}/api/config`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${origin}/api/config`)).status).toBe(200);
  });

  it('clears retained credentials when the provider origin changes', async () => {
    const { configure, post } = await setup();
    await configure();
    const sameOrigin = await post('/api/config', { baseUrl: 'https://vision.example/v2', model: 'other-model' });
    expect((await sameOrigin.json()).keyConfigured).toBe(true);
    const newOrigin = await post('/api/config', { baseUrl: 'https://different.example/v1', model: 'other-model' });
    expect((await newOrigin.json()).keyConfigured).toBe(false);
    const explicitNewKey = await configure({ baseUrl: 'https://third.example/v1', apiKey: 'explicit-new-key' });
    expect((await explicitNewKey.json()).keyConfigured).toBe(true);
    const portChange = await post('/api/config', { baseUrl: 'https://third.example:8443/v1', model: 'other-model' });
    expect((await portChange.json()).keyConfigured).toBe(false);
  });

  it('forwards image input once and returns validated layout with reproducibility metadata', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-api-key' });
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe('vision-test');
      expect(body.messages[1].content[1].image_url.url).toBe(png);
      expect(body).not.toHaveProperty('response_format');
      const data = fixture(); data.warnings.push('secret-api-key reflected by provider');
      return Response.json({ choices: [{ message: { content: JSON.stringify(data) } }] });
    });
    const { configure, post } = await setup({ fetchImpl });
    await configure();
    const response = await post('/api/recognize', requestBody);
    expect(response.status).toBe(200);
    const text = await response.text(); expect(text).not.toContain('secret-api-key');
    const result = JSON.parse(text);
    expect(result.detection.rows).toHaveLength(2);
    expect(result).toMatchObject({ providerBaseUrl: 'https://vision.example/v1', model: 'vision-test', promptVersion: 'wb-layout-1' });
    expect(Number.isNaN(Date.parse(result.createdAt))).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts upstream errors and rejects malformed/oversized model output', async () => {
    const auth = await setup({ fetchImpl: async () => new Response('secret-api-key upstream detail', { status: 401 }) });
    await auth.configure();
    const response = await auth.post('/api/recognize', requestBody);
    expect(response.status).toBe(502);
    const text = await response.text(); expect(text).toContain('provider_auth'); expect(text).not.toContain('secret-api-key');
    const invalid = await setup({ fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...fixture(), hidden: 'unknown' }) } }] }) });
    await invalid.configure();
    expect((await (await invalid.post('/api/recognize', requestBody)).json()).error.code).toBe('invalid_detection');
    const large = await setup({ maxResponseBytes: 32, fetchImpl: async () => new Response('a'.repeat(33)) });
    await large.configure();
    expect((await (await large.post('/api/recognize', requestBody)).json()).error.code).toBe('response_too_large');
  });

  it('rejects unsafe configuration and invalid image dimensions before forwarding', async () => {
    const fetchImpl = vi.fn();
    const { configure, post } = await setup({ fetchImpl });
    expect((await configure({ baseUrl: 'http://remote.example/v1' })).status).toBe(400);
    expect((await configure({ baseUrl: 'https://key:secret@remote.example/v1' })).status).toBe(400);
    await configure();
    expect((await post('/api/recognize', { image: { ...requestBody.image, width: 2 } })).status).toBe(400);
    expect((await post('/api/recognize', { ...requestBody, extra: true })).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces input size and media type', async () => {
    const { post, origin } = await setup({ maxRequestBytes: 128 });
    expect((await post('/api/recognize', requestBody)).status).toBe(413);
    expect((await post('/api/config', {}, { headers: { Origin: origin, 'Content-Type': 'text/plain' } })).status).toBe(415);
  });

  it('aborts the provider on timeout and never retries', async () => {
    const aborted = vi.fn();
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted(); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    }));
    const { configure, post } = await setup({ fetchImpl, recognitionTimeoutMs: 20 });
    await configure();
    const response = await post('/api/recognize', requestBody);
    expect(response.status).toBe(504); expect((await response.json()).error.code).toBe('provider_timeout');
    expect(aborted).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cancels the upstream request when the browser disconnects', async () => {
    let onStarted!: () => void;
    let onAborted!: () => void;
    const started = new Promise<void>((resolve) => { onStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { onAborted = resolve; });
    const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { onAborted(); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      onStarted();
    });
    const { configure, post } = await setup({ fetchImpl });
    await configure();
    const controller = new AbortController();
    const pending = post('/api/recognize', requestBody, { signal: controller.signal }).catch(() => null);
    await started; controller.abort(); await pending; await aborted;
  });

  it('refuses a real upstream redirect without sending a bearer key to its destination', async () => {
    const destination = vi.fn();
    const target = await listen(createServer((_request, response) => { destination(); response.end('unexpected'); }));
    const redirect = await listen(createServer((_request, response) => { response.writeHead(302, { Location: target }); response.end(); }));
    const { configure, post } = await setup();
    await configure({ baseUrl: redirect });
    const response = await post('/api/recognize', requestBody);
    expect(response.status).toBe(502); expect((await response.json()).error.code).toBe('provider_connection');
    expect(destination).not.toHaveBeenCalled();
  });
});

describe('input helpers', () => {
  it('permits HTTPS and local HTTP without credentials, query or fragment', () => {
    expect(sanitizeBaseUrl(' https://vision.example/v1/// ')).toBe('https://vision.example/v1');
    expect(sanitizeBaseUrl('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1');
    for (const url of ['file:///etc/passwd', 'ftp://vision.example', 'http://remote.example', 'https://vision.example/?key=secret', 'https://vision.example/#secret']) expect(() => sanitizeBaseUrl(url)).toThrow();
  });
  it('checks declared dimensions and image magic', () => {
    expect(validateImageInput(requestBody.image)).toEqual(requestBody.image);
    expect(() => validateImageInput({ ...requestBody.image, width: 2 })).toThrow('尺寸');
    expect(() => validateImageInput({ ...requestBody.image, dataUrl: 'data:image/png;base64,YWJjZA==' })).toThrow('文件头');
  });
});
