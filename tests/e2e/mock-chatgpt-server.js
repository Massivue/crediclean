/**
 * A small HTTPS server that stands in for ChatGPT during the browser test.
 *
 * It serves a page whose structure mirrors the parts of ChatGPT's markup that
 * the detector relies on, plus images on the same URL shapes ChatGPT uses. The
 * browser is pointed at it by mapping chatgpt.com to 127.0.0.1, so the
 * extension runs under its real match patterns rather than a relaxed test-only
 * configuration.
 *
 * This proves the extension loads, injects, detects, inspects, removes and
 * downloads. It does NOT prove the selectors match the real ChatGPT, because
 * the markup here is our reconstruction of it. See docs/TESTING.md.
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Make a throwaway self-signed certificate for the test server, if one is not
 * already there.
 *
 * It is generated on demand rather than committed, because committing a
 * private key, even a worthless test one, is a bad habit and trips secret
 * scanners. The files are ignored by git.
 */
function ensureCertificate() {
  const key = path.join(HERE, 'key.pem');
  const cert = path.join(HERE, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert };

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '7',
    '-subj', '/CN=chatgpt.com',
    '-addext', 'subjectAltName=DNS:chatgpt.com,DNS:chat.openai.com,IP:127.0.0.1',
  ], { stdio: 'ignore' });

  return { key, cert };
}

const PAGE = `<!doctype html>
<html lang="en" class="dark" id="root">
<head><meta charset="utf-8"><title>Mock ChatGPT</title>
<style>
  body { background:#212121; color:#ececf1; font-family:system-ui; margin:0; }
  header { display:flex; align-items:center; gap:8px; padding:12px; }
  main { max-width:760px; margin:0 auto; padding:24px 24px 160px; }
  #composer {
    position: fixed; bottom: 0; left: 0; right: 0; height: 120px;
    background:#303030; border-top:1px solid #444;
    display:flex; align-items:center; justify-content:center; z-index: 5;
  }
  #composer input { width:60%; padding:14px; border-radius:24px; border:0; }
  .turn { margin:32px 0; }
  img.generated { max-width:100%; border-radius:12px; display:block; }
</style></head>
<body>
  <header>
    <!-- Must NOT get a button: small, and an avatar address. -->
    <img id="avatar" src="/avatar/user.png" width="32" height="32" alt="Profile">
    <button id="toolbar-button">
      <!-- Must NOT get a button: inside a button element. -->
      <img id="icon-in-button" src="/backend-api/estuary/content?id=icon-big" width="200" height="200" alt="">
    </button>
  </header>
  <main>
    <div class="turn" data-message-author-role="user"><p>Draw me a picture.</p></div>
    <div class="turn" data-message-author-role="assistant" data-testid="conversation-turn-2">
      <p>Here is your image.</p>
      <!-- SHOULD get a button: large, content address, inside a message. -->
      <img id="signed" class="generated" src="/backend-api/estuary/content?id=file-signed" alt="A generated picture">
    </div>
    <div class="turn" data-message-author-role="assistant" data-testid="conversation-turn-4">
      <p>And one without credentials.</p>
      <!-- SHOULD get a button, and should report no credentials. -->
      <img id="unsigned" class="generated" src="/backend-api/estuary/content?id=file-unsigned" alt="Another picture">
    </div>
    <div class="turn" data-message-author-role="assistant" data-testid="conversation-turn-6">
      <p>And one with a very long filename.</p>
      <!-- Tests that a long name cannot stretch or break the panel. -->
      <img id="longname" class="generated"
           src="/backend-api/estuary/content/a-really-extremely-long-generated-image-filename-that-should-be-truncated-in-the-panel-1234567890.png?id=file-signed"
           alt="Long name picture">
    </div>
  </main>
  <!-- Stands in for ChatGPT's message composer: pinned to the bottom of the
       window, which is exactly what the panel has to avoid sitting behind. -->
  <div id="composer"><input placeholder="Message ChatGPT"></div>
  <script>
    // Mimic ChatGPT streaming an image in after the page has settled, so the
    // test also covers images that appear late.
    window.addLateImage = function () {
      const turn = document.createElement('div');
      turn.className = 'turn';
      turn.setAttribute('data-message-author-role', 'assistant');
      const img = document.createElement('img');
      img.id = 'late';
      img.className = 'generated';
      img.src = '/backend-api/estuary/content?id=file-late';
      img.alt = 'A late picture';
      turn.append(img);
      document.querySelector('main').append(turn);
    };
  </script>
</body></html>`;

export function startMockServer({ port = 443, images }) {
  const paths = ensureCertificate();
  const server = https.createServer(
    {
      key: fs.readFileSync(paths.key),
      cert: fs.readFileSync(paths.cert),
    },
    (request, response) => {
      const url = new URL(request.url, 'https://chatgpt.com');

      if (url.pathname === '/' || url.pathname === '/c/test') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE);
        return;
      }

      if (url.pathname.startsWith('/backend-api/estuary/content')) {
        const id = url.searchParams.get('id');
        const body = images[id];
        if (!body) {
          response.writeHead(404);
          response.end('no such image');
          return;
        }
        response.writeHead(200, {
          'content-type': body.contentType,
          'content-length': body.bytes.length,
        });
        response.end(Buffer.from(body.bytes));
        return;
      }

      if (url.pathname === '/favicon.ico') {
        // Serve something, so a 404 here does not masquerade as a real page error.
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(Buffer.from(images.avatar.bytes));
        return;
      }

      if (url.pathname.startsWith('/avatar/')) {
        const body = images.avatar;
        response.writeHead(200, { 'content-type': body.contentType });
        response.end(Buffer.from(body.bytes));
        return;
      }

      response.writeHead(404);
      response.end('not found');
    },
  );

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
