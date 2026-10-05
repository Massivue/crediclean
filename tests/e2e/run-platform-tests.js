#!/usr/bin/env node
/**
 * Runs the whole CrediClean flow against a reconstructed page for each of the
 * four supported platforms, with the real extension loaded in a real Chromium.
 *
 * WHAT THIS PROVES: the platform registry routes each host to the right
 * adapter, each adapter's rules find the generated image and reject the
 * avatar, and the shared credential engine, UI and download work identically
 * on all three.
 *
 * WHAT THIS DOES NOT PROVE: that the selectors still match the real Gemini or
 * Grok on any given day. The markup here is our reconstruction. All three
 * platforms have been confirmed working on their live sites by hand, but these
 * tests cannot re-check that. See docs/PLATFORM_TEST_MATRIX.md.
 *
 * Run with:  npm run test:platforms
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { pageHtml, chatgptStoreMain, PLATFORM_PAGES } from './platform-pages.js';
import { buildPng, buildC2paManifestStore } from '../fixtures.js';
import { inspectImage, STATUS } from '../../src/processing/metadata-inspector.js';
import { ADAPTERS } from '../../src/platforms/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, '..', '..');

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is not available. Install it with: npm install --no-save playwright');
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const signed = buildPng({
  width: 1024,
  height: 768,
  c2pa: buildC2paManifestStore({ claimGenerator: 'MockPlatform/1.0' }),
  xmp: 'provenance',
});
const unsigned = buildPng({ width: 1024, height: 768 });
/* What a resizing CDN returns: same picture, smaller, credentials gone. */
const strippedDerivative = buildPng({ width: 526, height: 296 });
/* A different image entirely, to prove a wrong candidate is refused. */
const decoy = buildPng({ width: 300, height: 900, c2pa: buildC2paManifestStore() });
/* Gemini, to scale: the rendered derivative shown in the conversation... */
const geminiDisplay = buildPng({ width: 1024, height: 559 });
/* ...and the genuine full-size original, which is where the credentials are. */
const geminiOriginal = buildPng({
  width: 1408,
  height: 768,
  c2pa: buildC2paManifestStore({ claimGenerator: 'Google Gemini/1.0' }),
  xmp: 'provenance',
});
const avatar = buildPng({ width: 32, height: 32 });
/*
 * A custom GPT's icon from ChatGPT's store pages. Deliberately a LARGE file:
 * that is what made it indistinguishable from a generated image on every
 * signal except how big it is drawn.
 */
const gptIcon = buildPng({ width: 512, height: 512 });

/** What the app swaps into <main> when it navigates to the store page. */
const STORE_MARKUP = chatgptStoreMain();

/** One HTTPS server answering for every platform host. */
function startServer() {
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(HERE, 'key.pem')),
      cert: fs.readFileSync(path.join(HERE, 'cert.pem')),
    },
    (request, response) => {
      // The mock page fetches its own image cross-origin to build a blob, just
      // as a real app would from its own CDN. Allow that here.
      response.setHeader('access-control-allow-origin', '*');
      const host = (request.headers.host || '').split(':')[0];
      const url = new URL(request.url, `https://${host}`);
      const platform = Object.keys(PLATFORM_PAGES).find((id) => PLATFORM_PAGES[id].host === host);

      /*
       * Google's resizing CDN, reproduced.
       *
       * `=s0` means "give me the original" and returns the signed file.
       * Any other options string is a derivative the CDN re-encoded, so it
       * carries no credentials. This is the behaviour that made real Gemini
       * images report "no supported credentials found".
       */
      /*
       * The conversation API response. The full-size original's address
       * appears here, JSON-escaped, and nowhere else.
       */
      if (url.pathname === '/api/conversation') {
        const body = JSON.stringify({
          turns: [
            {
              text: 'Here is your image.',
              media: [
                {
                  display: 'https://lh3.googleusercontent.com/rd-gg/DISPLAYID',
                  fullSize: 'https://lh3.googleusercontent.com/FULLSIZEID',
                },
              ],
            },
          ],
        }).replace(/\//g, '\\/'); // escape slashes, as a real JSON payload does
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
        return;
      }

      if (host === 'lh3.googleusercontent.com') {
        if (url.pathname.startsWith('/a/')) {
          response.writeHead(200, { 'content-type': 'image/png' });
          response.end(Buffer.from(avatar));
          return;
        }
        // A differently shaped image the extension must refuse to process.
        if (url.pathname.startsWith('/gg/DECOYID')) {
          response.writeHead(200, { 'content-type': 'image/png', 'content-length': decoy.length });
          response.end(Buffer.from(decoy));
          return;
        }
        // The rendered derivative the conversation shows: no credentials.
        if (url.pathname.startsWith('/rd-gg/')) {
          response.writeHead(200, { 'content-type': 'image/png', 'content-length': geminiDisplay.length });
          response.end(Buffer.from(geminiDisplay));
          return;
        }
        // The genuine full-size original, with credentials.
        if (url.pathname.startsWith('/FULLSIZEID')) {
          response.writeHead(200, { 'content-type': 'image/png', 'content-length': geminiOriginal.length });
          response.end(Buffer.from(geminiOriginal));
          return;
        }
        const bytes = url.pathname.endsWith('=s0') ? signed : strippedDerivative;
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
        response.end(Buffer.from(bytes));
        return;
      }

      if (url.pathname === '/img') {
        const id = url.searchParams.get('id');
        const bytes = id === 'file-signed' ? signed : id === 'gpt-icon' ? gptIcon : unsigned;
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
        response.end(Buffer.from(bytes));
        return;
      }
      if (url.pathname.startsWith('/avatar/') || url.pathname.startsWith('/a/') ||
          url.pathname.startsWith('/profile_images/') || url.pathname === '/favicon.ico') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(Buffer.from(avatar));
        return;
      }
      if (platform) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(pageHtml(platform, url.pathname));
        return;
      }
      response.writeHead(404);
      response.end('not found');
    },
  );
  return new Promise((resolve) => server.listen(443, '127.0.0.1', () => resolve(server)));
}

async function testPlatform(context, adapter) {
  const { host } = PLATFORM_PAGES[adapter.id];
  const expectCredentials = adapter.id !== 'grok'; // Grok's page serves an unsigned image on purpose
  /*
   * Gemini is the exception: its conversation shows a 1024x559 derivative
   * while the real original is 1408x768, so the extension is expected to end
   * up on the larger file. Everywhere else the displayed image is the file.
   */
  const expected = adapter.id === 'gemini' ? { width: 1408, height: 768 } : { width: 1024, height: 768 };
  console.log(`\n--- ${adapter.name} (${host}) ---`);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  try {
    await page.goto(`https://${host}/`, { waitUntil: 'load' });
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    await page.waitForTimeout(700);

    check(`${adapter.id}: the extension activates on this host`, true);

    const badges = await page.locator('.cc-badge').count();
    check(`${adapter.id}: exactly one button, on the generated image`, badges === 1, `found ${badges}`);

    const onGenerated = await page.locator('#generated[data-crediclean-handled]').count();
    const onAvatar = await page.locator('#avatar[data-crediclean-handled]').count();
    check(`${adapter.id}: the generated image was detected`, onGenerated === 1);
    check(`${adapter.id}: the avatar was NOT detected`, onAvatar === 0);

    await page.locator('.cc-badge').first().click();
    await page.waitForSelector('.cc-panel', { timeout: 15000 });
    const panelText = await page.locator('.cc-panel').innerText();

    check(`${adapter.id}: the panel shows Format, Size and File`,
      /Format/.test(panelText) && /Size/.test(panelText) && /File/.test(panelText), panelText.slice(0, 120));
    check(`${adapter.id}: the panel shows the real dimensions`,
      new RegExp(`${expected.width}\\s*[x×]\\s*${expected.height}`).test(panelText),
      panelText.slice(0, 120));
    check(`${adapter.id}: the panel shows no technical credential detail`,
      !/\bC2PA\b|manifest|c2pa\.|provenance/i.test(panelText), panelText.slice(0, 160));

    if (adapter.id === 'gemini') {
      /*
       * The point of this whole platform. The page shows a blob it built
       * itself, holding a re-encoded copy with no credentials. Finding
       * credentials at all proves the extension located the real file through
       * the markup instead of giving up on the blob.
       */
      const blobShown = await page.evaluate(
        () => (document.getElementById('generated').src || '').startsWith('blob:'),
      );
      check('gemini: the page really is showing a blob, as the live site does', blobShown === true);

      // Confirm the reproduction is faithful: the displayed bytes really have
      // been stripped, so finding credentials cannot come from the blob.
      const displayedIsBare = await page.evaluate(async () => {
        const img = document.getElementById('generated');
        const text = new TextDecoder('latin1').decode(
          new Uint8Array(await (await fetch(img.src)).arrayBuffer()),
        );
        return !text.includes('caBX') && !text.includes('jumb');
      });
      check('gemini: the image shown in the conversation really has no credentials',
        displayedIsBare === true);

      check('gemini: no download link exists in the page at all',
        (await page.locator('a[download]').count()) === 0);

      check('gemini: finds credentials WITHOUT any download being clicked',
        /Content Credentials found/i.test(panelText), panelText.slice(0, 160));
      check('gemini: uses the full-size original, not the rendered derivative',
        /1408\s*[x\u00d7]\s*768/.test(panelText) && !/1024|300/.test(panelText), panelText.slice(0, 160));
    }

    if (expectCredentials) {
      check(`${adapter.id}: credentials are detected`, /Content Credentials found/i.test(panelText));

      const removeButton = page.locator('.cc-panel .cc-button--primary');
      check(`${adapter.id}: one removal action is offered`, (await removeButton.count()) === 1);

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        removeButton.click(),
      ]);
      check(`${adapter.id}: ONE click downloads the processed file`, true);

      const saved = new Uint8Array(fs.readFileSync(await download.path()));
      const report = inspectImage(saved);
      check(`${adapter.id}: the downloaded file is a valid image`, report.format === 'png');
      check(`${adapter.id}: the downloaded file has no credentials left`,
        report.status === STATUS.NO_CREDENTIALS_DETECTED, report.status);
      check(`${adapter.id}: dimensions survive`,
        report.dimensions?.width === expected.width && report.dimensions?.height === expected.height,
        JSON.stringify(report.dimensions));
      check(`${adapter.id}: no credential bytes survive`,
        !Buffer.from(saved).toString('latin1').includes('jumb'));

      await page.waitForFunction(
        () => /Saved/.test(
          document.getElementById('crediclean-overlay-host')?.shadowRoot?.querySelector('.cc-panel')?.innerText || '',
        ),
        undefined,
        { timeout: 10000 },
      );
      check(`${adapter.id}: the success state appears`, true);
    } else {
      // Grok: we do not know whether its images carry credentials, so the only
      // correct behaviour on an image without them is to say so and offer
      // nothing. Inventing a removal action here would be the failure.
      check(`${adapter.id}: reports no supported credentials, plainly`,
        /No supported credentials found/i.test(panelText), panelText.slice(0, 140));
      check(`${adapter.id}: offers NO removal action when there is nothing to remove`,
        (await page.locator('.cc-panel .cc-button--primary').count()) === 0);
      check(`${adapter.id}: does not imply anything was removed`,
        !/removed/i.test(panelText), panelText.slice(0, 140));
    }

    const realErrors = errors.filter((text) => !/ERR_CERT/i.test(text));
    check(`${adapter.id}: no page errors`, realErrors.length === 0, realErrors.join(' | '));
  } finally {
    await page.close();
  }
}

/**
 * ChatGPT only: the extension must mount in a conversation and nowhere else,
 * and must follow the app as it moves between the two without a page load.
 *
 * This reproduces the reported defect exactly. The buttons appeared on the GPT
 * / plugin pages, and once they had, they survived the trip back to a
 * conversation. Two separate causes, so two separate things to prove here.
 */
async function testChatgptRouting(context) {
  console.log('\n--- ChatGPT: page scope and in-app navigation ---');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const badges = () => page.locator('.cc-badge').count();
  /* Long enough for the detector's debounce and the route poll to both run. */
  const settle = () => page.waitForTimeout(1200);

  try {
    /* 1. A conversation. The button belongs here. */
    await page.goto('https://chatgpt.com/c/abc-123', { waitUntil: 'load' });
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    check('routing: a conversation gets exactly one button', (await badges()) === 1);

    /* 2. The store page, loaded directly. Nothing here is a generated image,
          even though each icon is a large file from the content host. */
    await page.goto('https://chatgpt.com/gpts', { waitUntil: 'load' });
    await settle();
    check('routing: the GPT/plugins page gets NO buttons', (await badges()) === 0,
      `found ${await badges()}`);
    check('routing: no store icon was marked as handled',
      (await page.locator('[data-crediclean-handled]').count()) === 0);

    /* 3. Now the part that needs the route watcher: the same journey made
          INSIDE the app, with pushState and no document load. */
    await page.goto('https://chatgpt.com/c/abc-123', { waitUntil: 'load' });
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    const conversationMarkup = await page.evaluate(() => document.querySelector('main').innerHTML);

    await page.evaluate((storeMarkup) => {
      history.pushState({}, '', '/gpts');
      document.querySelector('main').innerHTML = storeMarkup;
    }, STORE_MARKUP);
    await settle();
    check('routing: pushState away from a conversation removes the buttons',
      (await badges()) === 0, `found ${await badges()}`);
    check('routing: and closes anything else we drew',
      (await page.locator('.cc-panel').count()) === 0);

    /* 4. Back again, the same way. */
    await page.evaluate((markup) => {
      history.pushState({}, '', '/c/abc-123');
      document.querySelector('main').innerHTML = markup;
    }, conversationMarkup);
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    check('routing: returning to the conversation brings the button back',
      (await badges()) === 1, `found ${await badges()}`);

    /* 5. The browser Back button, which is a different mechanism again. */
    await page.evaluate((storeMarkup) => {
      history.pushState({}, '', '/gpts');
      document.querySelector('main').innerHTML = storeMarkup;
    }, STORE_MARKUP);
    await settle();
    await page.goBack();
    await page.evaluate((markup) => {
      document.querySelector('main').innerHTML = markup;
    }, conversationMarkup);
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    check('routing: the browser Back button is handled too', (await badges()) === 1);

    /* 6. Settings opens over the conversation without changing the path. */
    await page.evaluate(() => { location.hash = '#settings'; });
    await settle();
    check('routing: opening settings over a conversation removes the buttons',
      (await badges()) === 0, `found ${await badges()}`);

    await page.evaluate(() => { location.hash = ''; });
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    check('routing: closing settings brings them back', (await badges()) === 1);

    /* 7. The button still does its job after all that moving about. */
    await page.locator('.cc-badge').first().click();
    await page.waitForSelector('.cc-panel', { timeout: 15000 });
    const panelText = await page.locator('.cc-panel').innerText();
    check('routing: the panel still works after navigating back and forth',
      /Content Credentials found/i.test(panelText), panelText.slice(0, 120));

    const realErrors = errors.filter((text) => !/ERR_CERT/i.test(text));
    check('routing: no page errors', realErrors.length === 0, realErrors.join(' | '));
  } finally {
    await page.close();
  }
}

/**
 * The CC control itself: icon only, with the explanation on hover.
 */
async function testBadgeAppearance(context) {
  console.log('\n--- The CC button ---');
  const page = await context.newPage();
  try {
    await page.goto('https://chatgpt.com/c/abc-123', { waitUntil: 'load' });
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    const badge = page.locator('.cc-badge').first();

    const box = await badge.boundingBox();
    check('button: small enough to sit on a picture', box.width <= 40 && box.height <= 40,
      `${Math.round(box.width)}x${Math.round(box.height)}`);
    check('button: still a comfortable click target', box.width >= 24 && box.height >= 24,
      `${Math.round(box.width)}x${Math.round(box.height)}`);
    check('button: roughly square, so it reads as an icon',
      Math.abs(box.width - box.height) <= 2, `${box.width}x${box.height}`);

    /*
     * What a user actually SEES on the button.
     *
     * Deliberately not innerText: that counts text which is only
     * `visibility: hidden`, so the tooltip and the screen-reader label would
     * both show up and the check would pass or fail for the wrong reason.
     */
    const visibleText = await badge.evaluate((node) => {
      let text = '';
      for (const child of node.querySelectorAll('*')) {
        const style = getComputedStyle(child);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (Number(style.opacity) === 0) continue;
        // Clipped to a single pixel: present for screen readers, not drawn.
        const rect = child.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) continue;
        text += child.textContent;
      }
      return text.trim();
    });
    check('button: shows the CC mark and no caption', visibleText === 'CC',
      JSON.stringify(visibleText));
    check('button: still tells a screen reader what it does',
      /inspect credentials/i.test(await badge.getAttribute('aria-label') || ''));

    const tip = badge.locator('.cc-badge__tip');
    check('button: the tooltip is hidden until hovered',
      (await tip.evaluate((node) => getComputedStyle(node).visibility)) === 'hidden');
    await badge.hover();
    await page.waitForTimeout(250);
    check('button: hovering reveals "Inspect credentials"',
      (await tip.evaluate((node) => getComputedStyle(node).visibility)) === 'visible' &&
        (await tip.innerText()).trim() === 'Inspect credentials');
  } finally {
    await page.close();
  }
}

async function main() {
  const server = await startServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-platforms-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-dl-'));

  // Point every supported host at the local mock server.
  const hostRules = [
    ...Object.values(PLATFORM_PAGES).map((p) => `MAP ${p.host} 127.0.0.1`),
    ...Object.values(PLATFORM_PAGES).filter((p) => p.imageHost).map((p) => `MAP ${p.imageHost} 127.0.0.1`),
  ].join(',');

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: 'chromium',
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      downloadsPath: downloadDir,
      proxy: { server: 'direct://', bypass: '*' },
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)),
      ),
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        `--host-resolver-rules=${hostRules}`,
        '--ignore-certificate-errors',
        '--no-proxy-server',
        '--no-sandbox',
      ],
    });

    for (const adapter of ADAPTERS) {
      if (!PLATFORM_PAGES[adapter.id]) {
        check(`${adapter.id}: has a test page`, false, 'no reconstruction exists for this adapter');
        continue;
      }
      await testPlatform(context, adapter);
    }

    // ChatGPT-specific: which pages the extension runs on, and the control.
    await testChatgptRouting(context);
    await testBadgeAppearance(context);
  } finally {
    if (context) await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nThe platform tests could not run:', error);
  process.exit(2);
});
