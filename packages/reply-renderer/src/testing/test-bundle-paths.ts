import { tmpdir } from 'node:os';
import path from 'node:path';

export const bundleDirectory = path.join(tmpdir(), 'st-miniapp-reply-renderer');
export const workerBundlePath = path.join(bundleDirectory, 'worker.mjs');
export const mainBundlePath = path.join(bundleDirectory, 'main.mjs');
