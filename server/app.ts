import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseDetectionResponse, PROMPT_VERSION, RECOGNITION_PROMPT } from '../shared/detection';
import { validateImageInput } from './image';
import type { RecognitionResult } from '../src/core/types';

export interface ProviderSettings { baseUrl: string; model: string; apiKey: string }
export interface ServerOptions {
  webHandler?: RequestListener;
  fetchImpl?: typeof fetch;
  recognitionTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function sanitizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new HttpError(400, 'invalid_config', 'Base URL 无效');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new HttpError(400, 'invalid_config', 'Base URL 必须为完整 HTTP(S) 地址'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new HttpError(400, 'invalid_config', 'Base URL 须为 HTTPS（本机服务可用 HTTP），不得包含账号、查询参数或片段');
  return url.toString().replace(/\/+$/, '');
}

function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'content_type', '请使用 application/json');
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new HttpError(413, 'request_too_large', '请求超过大小限制（默认 24 MiB）');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let completed = false;
    const fail = (error: Error) => { if (!completed) { completed = true; reject(error); } };
    request.on('data', (chunk: Buffer) => {
      if (completed) return;
      size += chunk.length;
      if (size > limit) { chunks.length = 0; fail(new HttpError(413, 'request_too_large', '请求超过大小限制（默认 24 MiB）')); return; }
      chunks.push(chunk);
    });
    request.on('aborted', () => fail(new HttpError(499, 'cancelled', '请求已取消')));
    request.on('error', () => fail(new HttpError(400, 'request_failed', '读取请求失败')));
    request.on('end', () => {
      if (completed) return;
      completed = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid_json', '请求不是有效 JSON')); }
    });
  });
}

function exactObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new HttpError(400, 'invalid_request', '请求字段无效');
  return value as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(value));
}

async function limitedResponse(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body?.cancel(); throw new HttpError(502, 'response_too_large', '模型响应超过大小限制'); }
  if (!response.body) throw new HttpError(502, 'invalid_response', '模型未返回内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new HttpError(502, 'response_too_large', '模型响应超过大小限制'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Configuration lives exclusively in this server instance's memory. Nothing is logged. */
export function createReviewerServer(options: ServerOptions = {}) {
  let settings: ProviderSettings = { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRequestBytes = options.maxRequestBytes ?? 24 * 1024 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  const active = new Set<AbortController>();
  const publicSettings = () => ({ baseUrl: settings.baseUrl, model: settings.model, keyConfigured: settings.apiKey.length > 0 });
  const server = createServer(async (request, response) => {
    const address = server.address() as AddressInfo | null;
    const authority = `127.0.0.1:${address?.port}`;
    const origin = `http://${authority}`;
    // Enforce Host on every resource to prevent DNS rebinding into the local UI/API.
    if (request.headers.host !== authority) { send(response, 403, { error: { code: 'host_forbidden', message: '仅允许通过本机 127.0.0.1 地址访问' } }); return; }
    const path = request.url?.split('?')[0] ?? '/';
    if (!path.startsWith('/api/')) {
      if (options.webHandler) options.webHandler(request, response);
      else send(response, 404, { error: { code: 'not_found', message: '页面不存在' } });
      return;
    }
    try {
      const requestOrigin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if ((requestOrigin !== undefined && requestOrigin !== origin) || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') || (request.method !== 'GET' && requestOrigin !== origin)) throw new HttpError(403, 'origin_forbidden', '请求来源不匹配，请从本机应用页面操作');
      if (path === '/api/config' && request.method === 'GET') { send(response, 200, publicSettings()); return; }
      if (path === '/api/config' && request.method === 'POST') {
        const body = exactObject(await readJson(request, 16 * 1024), ['baseUrl', 'model', 'apiKey']);
        const baseUrl = sanitizeBaseUrl(body.baseUrl);
        if (typeof body.model !== 'string' || body.model.length > 256 || /[\u0000-\u001f]/.test(body.model)) throw new HttpError(400, 'invalid_config', '模型名须为不超过 256 字符的文本');
        if ('apiKey' in body && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096 || /[\u0000-\u001f\u007f-\uffff]/.test(body.apiKey))) throw new HttpError(400, 'invalid_config', 'API Key 格式无效');
        // Retaining a secret is safe only when the provider origin is unchanged.
        // A path/model edit on the same service keeps it; a new host/port/protocol clears it.
        const sameProvider = new URL(baseUrl).origin === new URL(settings.baseUrl).origin;
        settings = { baseUrl, model: body.model.trim(), apiKey: 'apiKey' in body ? (body.apiKey as string).trim() : sameProvider ? settings.apiKey : '' };
        send(response, 200, publicSettings()); return;
      }
      if (path === '/api/recognize' && request.method === 'POST') {
        const body = exactObject(await readJson(request, maxRequestBytes), ['image']);
        let image;
        try { image = validateImageInput(body.image); } catch (error) { throw new HttpError(400, 'invalid_image', (error as Error).message); }
        const config = { ...settings };
        if (!config.model) throw new HttpError(400, 'configuration_required', '请先设置服务地址与模型名称');
        const controller = new AbortController();
        active.add(controller);
        let timedOut = false;
        const onClose = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', onClose);
        request.on('aborted', onClose);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.recognitionTimeoutMs ?? 90_000);
        timer.unref();
        try {
          if (response.destroyed || request.aborted) controller.abort();
          const upstream = await fetchImpl(`${config.baseUrl}/chat/completions`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body: JSON.stringify({ model: config.model, messages: [
              { role: 'system', content: RECOGNITION_PROMPT },
              { role: 'user', content: [
                { type: 'text', text: `Locate the visible Western blot bands and labels in this ${image.width} by ${image.height} pixel screenshot. Return the required JSON only.` },
                { type: 'image_url', image_url: { url: image.dataUrl } },
              ] },
            ] }),
          });
          if (!upstream.ok) {
            await upstream.body?.cancel();
            if (upstream.status === 401 || upstream.status === 403) throw new HttpError(502, 'provider_auth', '视觉服务认证失败，请检查 API Key 和访问权限');
            if (upstream.status === 429) throw new HttpError(502, 'provider_rate_limit', '视觉服务达到额度或速率限制，请检查账户后重试');
            throw new HttpError(502, 'provider_http', `视觉服务返回 HTTP ${upstream.status}，请检查地址、模型及服务状态`);
          }
          const upstreamText = await limitedResponse(upstream, maxResponseBytes);
          let payload: { choices?: { message?: { content?: unknown } }[] };
          try { payload = JSON.parse(upstreamText); } catch { throw new HttpError(502, 'invalid_response', '视觉服务响应不是 JSON'); }
          const content = payload?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, 'invalid_response', '视觉服务未返回文本识别结果');
          // A provider must not be able to reflect the bearer secret into an export.
          const rawResponse = config.apiKey ? content.split(config.apiKey).join('[REDACTED]') : content;
          let detection;
          try { detection = parseDetectionResponse(rawResponse); } catch (error) { throw new HttpError(502, 'invalid_detection', `无法使用模型结果：${(error as Error).message}。可重试或人工框选`); }
          const result: RecognitionResult = { detection, rawResponse, promptVersion: PROMPT_VERSION, model: config.model, providerBaseUrl: config.baseUrl, createdAt: new Date().toISOString() };
          if (!controller.signal.aborted) send(response, 200, result);
          else if (timedOut) throw new HttpError(504, 'provider_timeout', '视觉识别超时，图像已保留，可重试或人工框选');
        } catch (error) {
          if (timedOut) throw new HttpError(504, 'provider_timeout', '视觉识别超时，图像已保留，可重试或人工框选');
          if (controller.signal.aborted) throw new HttpError(499, 'cancelled', '识别已取消');
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, 'provider_connection', '无法连接视觉服务，请检查地址、网络和服务兼容性（不允许重定向）');
        } finally {
          clearTimeout(timer); active.delete(controller);
          response.off('close', onClose); request.off('aborted', onClose);
        }
        return;
      }
      throw new HttpError(404, 'not_found', '接口或请求方法不存在');
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(500, 'internal_error', '本机服务处理失败，请重试');
      send(response, failure.status, { error: { code: failure.code, message: failure.message } });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => { for (const controller of active) controller.abort(); settings = { baseUrl: '', model: '', apiKey: '' }; });
  return server;
}
