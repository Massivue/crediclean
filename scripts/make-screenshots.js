#!/usr/bin/env node
/**
 * Regenerate the Chrome Web Store screenshots in `store/screenshots/`.
 *
 * Every shot is the REAL extension, loaded into a real Chromium, acting on a
 * real image that really carries a C2PA manifest. Nothing here is a mockup, so
 * the store listing cannot drift away from what the product does. Re-run it
 * whenever the on-page interface changes, or the screenshots become a picture
 * of a version nobody can install.
 *
 * The page it acts on is our own reconstruction of a chat, not a capture of
 * anyone's product: no third-party logo, wordmark or interface art is copied.
 *
 * Needs Playwright and the ability to listen on port 443:
 *   npm install --no-save playwright
 *   sudo -E node scripts/make-screenshots.js
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildC2paManifestStore, pngChunk } from '../tests/fixtures.js';
import { parsePngChunks, serialisePngChunks } from '../src/formats/png.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'store', 'screenshots');
const CERTS = path.join(ROOT, 'tests', 'e2e');

/** The store requires exactly this, and rejects anything else. */
const SHOT = { width: 1280, height: 800 };

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not available. Install it with: npm install --no-save playwright');
  process.exit(2);
}

/**
 * A presentable demo image carrying a genuine C2PA manifest chunk.
 *
 * The picture is drawn by ImageMagick so the shot shows something a person
 * would plausibly have generated. The manifest is then written into the file
 * with the extension's OWN PNG writer, which means what the panel reports is
 * what the extension actually read, not a caption we typed.
 */
function buildDemoImage() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-shot-'));
  const plain = path.join(scratch, 'demo.png');
  execFileSync('convert', [
    '-size', '1408x768',
    'radial-gradient:#b9a6f5-#4bc8e8',
    '-colorspace', 'sRGB',
    plain,
  ]);
  const bytes = new Uint8Array(fs.readFileSync(plain));
  fs.rmSync(scratch, { recursive: true, force: true });

  const parsed = parsePngChunks(bytes);
  if (!parsed.ok) throw new Error(`the drawn demo image is not a readable PNG: ${parsed.error}`);

  // Rebuild as: everything up to IEND, then the manifest chunk, then IEND.
  const iend = parsed.chunks.findIndex((chunk) => chunk.type === 'IEND');
  if (iend < 0) throw new Error('the drawn demo image has no IEND chunk');
  const before = serialisePngChunks(bytes, parsed.chunks.slice(0, iend));
  const manifest = pngChunk('caBX', buildC2paManifestStore({ claimGenerator: 'DemoImageModel/1.0' }));
  const end = serialisePngChunks(bytes, parsed.chunks.slice(iend)).subarray(8);

  const out = new Uint8Array(before.length + manifest.length + end.length);
  out.set(before, 0);
  out.set(manifest, before.length);
  out.set(end, before.length + manifest.length);
  return out;
}

const demoImage = buildDemoImage();

const PAGE = `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><title>New chat</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#1b1b1d; color:#ececf1;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px;
    border-bottom:1px solid #2e2f33; }
  header .dot { width:28px; height:28px; border-radius:50%;
    background:repeating-linear-gradient(45deg,#8f8f98 0 3px,#5f5f68 3px 6px); }
  header strong { font-size:17px; }
  main { max-width:760px; margin:0 auto; padding:22px 24px 130px; }
  .who { color:#9a9ca3; font-size:13px; margin:0 0 6px; }
  .ask { display:inline-block; background:#303134; border-radius:16px;
    padding:12px 18px; font-size:16px; margin:0 0 22px; }
  .said { font-size:16px; margin:0 0 12px; }
  /* Kept modest so the panel opens BELOW the image, where a reader expects
     it, rather than flipping above to avoid the composer. */
  img.shot { display:block; width:440px; max-height:240px; object-fit:cover;
    border-radius:12px; }
  #composer { position:fixed; left:0; right:0; bottom:0; height:96px;
    background:#1b1b1d; border-top:1px solid #2e2f33;
    display:flex; align-items:center; justify-content:center; }
  #composer div { width:60%; background:#303134; color:#9a9ca3;
    border-radius:26px; padding:16px 22px; font-size:15px; }
</style></head>
<body>
  <header><span class="dot"></span><strong>New chat</strong></header>
  <main>
    <div data-message-author-role="user">
      <p class="who">You</p>
      <p class="ask">Create an image of a team meeting about AI governance</p>
    </div>
    <div data-message-author-role="assistant" data-testid="conversation-turn-2">
      <p class="who">Assistant</p>
      <p class="said">Here's your image.</p>
      <img class="shot" src="/img/demo.png" alt="A generated picture">
    </div>
  </main>
  <div id="composer"><div>Ask anything</div></div>
</body></html>`;

function startServer() {
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(CERTS, 'key.pem')),
      cert: fs.readFileSync(path.join(CERTS, 'cert.pem')),
    },
    (request, response) => {
      if (request.url.startsWith('/img/')) {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': demoImage.length });
        response.end(Buffer.from(demoImage));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    },
  );
  return new Promise((resolve) => server.listen(443, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-shots-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-shots-dl-'));
  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: 'chromium',
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      downloadsPath: downloadDir,
      viewport: SHOT,
      proxy: { server: 'direct://', bypass: '*' },
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)),
      ),
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        '--host-resolver-rules=MAP chatgpt.com 127.0.0.1',
        '--ignore-certificate-errors',
        '--no-proxy-server',
        '--no-sandbox',
        `--window-size=${SHOT.width},${SHOT.height}`,
      ],
    });

    const page = await context.newPage();
    await page.setViewportSize(SHOT);
    await page.goto('https://chatgpt.com/c/demo', { waitUntil: 'load' });
    await page.waitForSelector('.cc-badge', { timeout: 20000 });

    // 1. The button on a generated image, hovered so its tooltip is showing.
    await page.locator('.cc-badge').first().hover();
    await page.waitForTimeout(400);
    await shoot(page, '1-button.png');

    // 2. The report. Move the pointer off the button first, or its tooltip
    //    sits in the shot explaining a button the reader can already see.
    await page.locator('.cc-badge').first().click();
    await page.waitForSelector('.cc-panel', { timeout: 20000 });
    await page.mouse.move(1050, 240);
    await page.waitForTimeout(500);
    await shoot(page, '2-panel.png');

    // 3. Removed and saved, which is the whole point of the product.
    const download = page.waitForEvent('download', { timeout: 20000 });
    await page.locator('.cc-panel .cc-button--primary').click();
    await download;
    await page.waitForSelector('.cc-button--done', { timeout: 20000 });
    await page.mouse.move(1050, 240);
    await page.waitForTimeout(400);
    await shoot(page, '3-saved.png');

    /*
     * 4. The popup.
     *
     * It is about 300px wide, so screenshotting it on a 1280x800 canvas would
     * leave it stranded in a corner. Shoot it at its own size, then centre it
     * on the canvas the store requires.
     */
    const extensionId = await resolveExtensionId(context);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.waitForTimeout(800);
    const size = await popup.evaluate(() => ({
      width: Math.ceil(document.body.getBoundingClientRect().width),
      height: Math.ceil(document.body.getBoundingClientRect().height),
    }));
    await popup.setViewportSize(size);
    await popup.waitForTimeout(300);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-popup-'));
    const bare = path.join(scratch, 'popup.png');
    await popup.screenshot({ path: bare });
    await popup.close();

    execFileSync('convert', [
      '-size', `${SHOT.width}x${SHOT.height}`, 'xc:#1b1b1d',
      '(', bare, '-bordercolor', '#2e2f33', '-border', '1', ')',
      '-gravity', 'center', '-composite',
      path.join(OUT, '4-popup.png'),
    ]);
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log('  wrote 4-popup.png');

    console.log(`\nWrote 4 screenshots at ${SHOT.width}x${SHOT.height} to store/screenshots/`);
  } finally {
    if (context) await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT, name), clip: { x: 0, y: 0, ...SHOT } });
  console.log(`  wrote ${name}`);
}

/** The id Chrome gave this unpacked extension, read off its own service worker. */
async function resolveExtensionId(context) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const worker = context.serviceWorkers()[0];
    if (worker) return new URL(worker.url()).host;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the extension service worker never started, so its id is unknown');
}

main().catch((error) => {
  console.error('\nScreenshots could not be made:', error);
  process.exit(1);
});
