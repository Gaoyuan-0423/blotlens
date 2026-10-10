import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalApp } from './start';

await startLocalApp({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), port: Number(process.env.REVIEWER_PORT ?? '4317'), production: process.argv.includes('--production') });
