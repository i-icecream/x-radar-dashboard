#!/usr/bin/env node

import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const port = Number(process.env.PORT || process.argv[2] || 4173);
const host = process.env.HOST || '127.0.0.1';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function resolvePublicPath(urlPath) {
  const parsed = decodeURIComponent((urlPath || '/').split('?')[0]);
  const requested = parsed === '/' ? '/index.html' : parsed;
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const fullPath = join(PUBLIC_DIR, normalized);
  if (!fullPath.startsWith(PUBLIC_DIR)) return null;
  return fullPath;
}

const server = createServer(async (req, res) => {
  const filePath = resolvePublicPath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const info = existsSync(filePath) ? await stat(filePath) : null;
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const type = mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store'
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.message);
  }
});

function localNetworkUrls() {
  const urls = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  return urls;
}

server.listen(port, host, () => {
  console.log(`X radar dashboard: http://127.0.0.1:${port}`);
  if (host === '0.0.0.0') {
    for (const url of localNetworkUrls()) {
      console.log(`LAN: ${url}`);
    }
  }
});
