import { readFile, stat } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import path from 'node:path';
import { createReviewerServer, type ServerOptions } from './app';

export async function startLocalApp({ root: reviewerRoot, port, production, publicOrigin, allowedProviderUrls }: { root: string; port: number; production: boolean } & Pick<ServerOptions, 'publicOrigin' | 'allowedProviderUrls'>) {
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须为 1–65535 的整数');
if (publicOrigin && !production) throw new Error('公网模式必须使用生产构建');
let closeWeb = async () => {};
let handler: RequestListener;
if (!production) {
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: path.join(reviewerRoot, 'vite.config.ts'), server: { middlewareMode: true, host: '127.0.0.1', hmr: false } });
  handler = (request, response) => vite.middlewares(request, response, () => { response.writeHead(404); response.end('Not found'); });
  closeWeb = () => vite.close();
} else {
  const dist = path.join(reviewerRoot, 'dist');
  await stat(path.join(dist, 'index.html')).catch(() => { throw new Error('尚未构建网页，请先运行 npm run build'); });
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
  handler = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      let file = path.resolve(dist, `.${pathname}`);
      if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) { response.writeHead(403); response.end(); return; }
      if (!path.extname(pathname)) file = path.join(dist, 'index.html');
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404); response.end('Not found'); }
  };
}
const server = createReviewerServer({ webHandler: handler, publicOrigin, allowedProviderUrls });
server.on('error', () => { console.error('WB 本机服务启动失败，请检查端口是否被占用。'); process.exitCode = 1; void closeWeb(); });
server.listen(port, '127.0.0.1', () => { console.log(`WB 截图趋势核对工具：http://127.0.0.1:${port}`); });
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  await closeWeb();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

return { server, close: shutdown };
}
