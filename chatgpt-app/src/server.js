#!/usr/bin/env node
/**
 * The HTTP front door.
 *
 * Three jobs, and nothing else:
 *   POST /mcp        the MCP endpoint ChatGPT talks to
 *   GET  /files/:id  a processed image, for a short while after it was made
 *   GET  /health     is this thing running
 *
 * Plain `node:http`, no framework. The whole surface is small enough to read
 * in one sitting, which for a public endpoint that handles other people's
 * images is worth more than convenience.
 */

import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { PORT, describeConfig } from './config.js';
import { takeProcessedFile } from './files.js';
import { createCrediCleanServer } from './mcp.js';

/** Refuse a request body larger than this. MCP messages are small. */
const MAX_BODY_BYTES = 1024 * 1024;

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Read and parse a JSON body, with a cap.
 *
 * The cap matters: without it, anyone can hold memory open by announcing a
 * body and sending it one byte at a time.
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

/**
 * Handle one MCP request.
 *
 * A NEW server and transport per request, deliberately. The transport is
 * stateless (`sessionIdGenerator: undefined`), which means it keeps nothing
 * between calls; reusing one across requests would let two conversations see
 * each other's traffic. Creating them is cheap.
 */
async function handleMcp(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    send(response, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: `Could not read the request: ${error.message}` },
      id: null,
    });
    return;
  }

  const server = createCrediCleanServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Tear both down when the response finishes, however it finishes. Without
  // this, every request leaks a server.
  response.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    console.error('[CrediClean] MCP request failed.', error);
    if (!response.headersSent) {
      send(response, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error.' },
        id: null,
      });
    }
  }
}

/**
 * Serve a processed image.
 *
 * The token is 24 random bytes, so the address is not guessable, and the file
 * disappears on its own after a short while. `Content-Disposition` is what
 * makes a browser save it with the right name rather than render it.
 */
function handleFile(response, token) {
  const file = takeProcessedFile(token);
  if (!file) {
    send(response, 404, { error: 'That file has expired or never existed.' });
    return;
  }
  response.writeHead(200, {
    'content-type': file.contentType,
    'content-length': String(file.bytes.length),
    'content-disposition': `attachment; filename="${file.filename.replace(/"/g, '')}"`,
    // It is somebody's picture held for minutes. Nothing should cache it.
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
  });
  response.end(Buffer.from(file.bytes));
}

export function createHttpServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    /*
     * CORS. The widget runs in a sandboxed frame on an OpenAI origin, so it is
     * cross-origin to us by definition and cannot fetch our download link
     * without these.
     */
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, mcp-protocol-version, accept');
    response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('access-control-expose-headers', 'mcp-session-id, content-disposition');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/health') {
      send(response, 200, { ok: true, service: 'crediclean-chatgpt-app', config: describeConfig() });
      return;
    }

    if (url.pathname.startsWith('/files/')) {
      if (request.method !== 'GET') {
        send(response, 405, { error: 'Use GET.' });
        return;
      }
      handleFile(response, decodeURIComponent(url.pathname.slice('/files/'.length)));
      return;
    }

    if (url.pathname === '/mcp') {
      await handleMcp(request, response);
      return;
    }

    send(response, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
  });
}

/* Start only when run directly, so the tests can import and drive this. */
const runDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (runDirectly) {
  const server = createHttpServer();
  server.listen(PORT, () => {
    const config = describeConfig();
    console.log(`CrediClean ChatGPT app listening on port ${PORT}`);
    console.log(`  MCP endpoint : ${config.publicBaseUrl}/mcp`);
    console.log(`  Downloads    : ${config.publicBaseUrl}/files/<token>`);
    console.log(`  Will fetch images only from: ${config.allowedDownloadHosts.join(', ')}`);
    if (config.publicBaseUrl.startsWith('http://localhost')) {
      console.log(
        '\n  NOTE: CREDICLEAN_PUBLIC_URL is not set, so download links point at ' +
          'localhost.\n  ChatGPT cannot reach those. Set it to your public HTTPS address.',
      );
    }
  });
}
