#!/usr/bin/env node
/**
 * End-to-end browser test: loads the real extension into a real Chromium and
 * drives it through the whole workflow.
 *
 * It is kept out of `npm test` because it needs a browser and a privileged
 * port. Run it with:  npm run test:e2e
 *
 * What it proves:
 *   - the extension loads with no manifest errors;
 *   - the content script injects on a chatgpt.com address;
 *   - buttons appear on generated images and NOT on avatars or icons;
 *   - images that arrive after page load also get buttons;
 *   - inspection reports credentials correctly, both present and absent;
 *   - removal produces a real download whose bytes are clean and lossless.
 *
 * What it does NOT prove: that the detector's selectors match the real
 * ChatGPT. The markup here is our reconstruction of it.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockServer } from './mock-chatgpt-server.js';
import { buildPng, buildC2paManifestStore } from '../fixtures.js';
import { inspectImage, STATUS } from '../../src/processing/metadata-inspector.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, '..', '..');

/*
 * Playwright may be installed globally rather than in this project, and ES
 * module resolution does not look in the global folder. CommonJS resolution
 * does, so borrow it.
 */
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error(
    'Playwright is not available. Install it with:  npm install --no-save playwright\n' +
      'Then run this test again. The rest of the suite (npm test) does not need it.',
  );
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

async function main() {
  // A signed image big enough to pass the size filter, and a clean one.
  const signed = buildPng({
    width: 600,
    height: 400,
    c2pa: buildC2paManifestStore({
      assertions: ['c2pa.actions', 'stds.schema-org.CreativeWork'],
      claimGenerator: 'MockOpenAI/1.0',
    }),
    xmp: 'provenance',
  });
  const unsigned = buildPng({ width: 600, height: 400 });
  const avatar = buildPng({ width: 32, height: 32 });

  // Sanity-check the fixtures before relying on them in the browser.
  check('fixture: signed image really has credentials',
    inspectImage(signed).status === STATUS.CREDENTIALS_DETECTED);
  check('fixture: unsigned image really has none',
    inspectImage(unsigned).status === STATUS.NO_CREDENTIALS_DETECTED);

  const images = {
    'file-signed': { bytes: signed, contentType: 'image/png' },
    'file-unsigned': { bytes: unsigned, contentType: 'image/png' },
    'file-late': { bytes: signed, contentType: 'image/png' },
    'icon-big': { bytes: unsigned, contentType: 'image/png' },
    avatar: { bytes: avatar, contentType: 'image/png' },
  };

  const server = await startMockServer({ port: 443, images });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-e2e-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-dl-'));

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      // Playwright's default headless binary is a cut-down shell that cannot
      // load extensions. The full Chromium build can, including headless.
      channel: 'chromium',
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      downloadsPath: downloadDir,
      // Playwright picks up HTTPS_PROXY from the environment. This test talks
      // only to a local server, so force a direct connection and strip the
      // proxy variables from the browser's own environment too.
      proxy: { server: 'direct://', bypass: '*' },
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(key),
        ),
      ),
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        // Point chatgpt.com at our mock server, so the extension runs under its
        // real https://chatgpt.com/* match patterns.
        '--host-resolver-rules=MAP chatgpt.com 127.0.0.1,MAP chat.openai.com 127.0.0.1',
        '--ignore-certificate-errors',
        // This environment sets an HTTPS proxy. Chromium would send
        // chatgpt.com through it and never reach the local mock server, so
        // this test must go direct.
        '--no-proxy-server',
        '--proxy-bypass-list=*',
        '--no-sandbox',
      ],
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    await page.goto('https://chatgpt.com/c/test', { waitUntil: 'load' });

    /* --- the extension injects and finds the right images ---------------- */

    // Shadow roots are open, so Playwright can see inside them.
    await page.waitForSelector('.cc-badge', { timeout: 15000 });
    check('content script injected and created at least one button', true);

    await page.waitForTimeout(800); // let the debounced scan settle

    const badgeCount = await page.locator('.cc-badge').count();
    check('exactly three buttons: one per generated image', badgeCount === 3, `found ${badgeCount}`);

    const overlayPresent = await page.locator('#crediclean-overlay-host').count();
    check('overlay host is attached to the page', overlayPresent === 1);

    // The avatar and the icon inside a button must not have been touched.
    const avatarHandled = await page.locator('#avatar[data-crediclean-handled]').count();
    const iconHandled = await page.locator('#icon-in-button[data-crediclean-handled]').count();
    check('no button on the avatar', avatarHandled === 0);
    check('no button on the large icon inside a toolbar button', iconHandled === 0);

    const signedHandled = await page.locator('#signed[data-crediclean-handled]').count();
    check('the generated image was marked as handled', signedHandled === 1);

    /* --- an image that appears later also gets a button ------------------ */

    await page.evaluate(() => window.addLateImage());
    await page.waitForFunction(
      () => document.querySelector('#crediclean-overlay-host')?.shadowRoot?.querySelectorAll('.cc-badge').length === 4,
      undefined,
      { timeout: 10000 },
    );
    check('an image added after load also gets a button', true);

    // Running the scan again must not duplicate anything.
    await page.waitForTimeout(600);
    const afterLate = await page.locator('.cc-badge').count();
    check('no duplicate buttons after rescans', afterLate === 4, `found ${afterLate}`);

    /* --- inspecting an image with credentials ---------------------------- */

    await page.locator('.cc-badge').first().click();
    await page.waitForSelector('.cc-panel', { timeout: 15000 });

    const panelText = await page.locator('.cc-panel').innerText();
    check('panel reports credentials were found', /Content Credentials found/i.test(panelText), panelText.slice(0, 140));

    /* --- the panel is compact and shows ONLY the three facts -------------- */

    check('panel shows Format', /Format/.test(panelText));
    check('panel shows Size', /Size/.test(panelText));
    check('panel shows File', /File/.test(panelText));
    check('panel shows the real dimensions', /600\s*[x\u00d7]\s*400/.test(panelText), panelText);

    // Everything technical must be gone.
    for (const [label, pattern] of [
      ['"What was found" section', /what was found/i],
      ['"The credential states" section', /credential states/i],
      ['assertion labels', /c2pa\.[a-z]/i],
      ['the signer / claim generator', /MockOpenAI/],
      ['the word C2PA', /\bC2PA\b/],
      ['manifest wording', /manifest/i],
      ['provenance wording', /provenance/i],
      ['verification check list', /checks run on/i],
    ]) {
      check(`panel does NOT show ${label}`, !pattern.test(panelText), panelText.slice(0, 200));
    }

    const panelBox = await page.locator('.cc-panel').boundingBox();
    check('panel width is in the 360-420px range',
      panelBox.width >= 360 && panelBox.width <= 420, `width was ${panelBox.width}`);

    const scrollState = await page.evaluate(() => {
      const panel = document.getElementById('crediclean-overlay-host').shadowRoot.querySelector('.cc-panel');
      return { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
    });
    check('panel does not need scrolling',
      scrollState.scrollHeight <= scrollState.clientHeight + 1,
      `content ${scrollState.scrollHeight}px in ${scrollState.clientHeight}px`);
    // The panel it replaced was 506px tall and scrolled.
    check('panel is short', panelBox.height < 250, `height was ${panelBox.height}`);
    check('panel width is in the 360-400px band',
      panelBox.width >= 360 && panelBox.width <= 400, `width was ${panelBox.width}`);

    /* --- the panel is always fully visible and clear of the composer ------ */

    const geometry = () =>
      page.evaluate(() => {
        const root = document.getElementById('crediclean-overlay-host').shadowRoot;
        const panel = root.querySelector('.cc-panel');
        if (!panel) return null;
        const p = panel.getBoundingClientRect();
        const composer = document.getElementById('composer').getBoundingClientRect();
        return {
          panel: { top: p.top, bottom: p.bottom, left: p.left, right: p.right, height: p.height },
          composerTop: composer.top,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        };
      });

    const g1 = await geometry();
    check('panel is fully inside the viewport',
      g1.panel.top >= 0 && g1.panel.bottom <= g1.viewport.h &&
        g1.panel.left >= 0 && g1.panel.right <= g1.viewport.w,
      JSON.stringify(g1.panel));
    check('panel does not sit behind the composer',
      g1.panel.bottom <= g1.composerTop + 1,
      `panel bottom ${g1.panel.bottom} vs composer top ${g1.composerTop}`);

    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);

    /* --- an image low on screen flips the panel above it ------------------ */

    // Put the signed image's bottom just above the composer, so there is no
    // room below it for the panel.
    await page.evaluate(() => {
      const img = document.getElementById('signed');
      const composerTop = document.getElementById('composer').getBoundingClientRect().top;
      const rect = img.getBoundingClientRect();
      window.scrollBy(0, rect.bottom - composerTop + 20);
    });
    await page.waitForTimeout(500);

    const lowImage = await page.evaluate(() => {
      const r = document.getElementById('signed').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });

    await page.locator('#signed[data-crediclean-handled]').scrollIntoViewIfNeeded().catch(() => {});
    const lowBadge = page.locator('.cc-badge').first();
    if (await lowBadge.isVisible()) {
      await lowBadge.click();
      await page.waitForSelector('.cc-panel', { timeout: 10000 });
      const g2 = await geometry();

      check('with no room below, the panel opens ABOVE the image',
        g2.panel.bottom <= lowImage.bottom + 1,
        `panel bottom ${g2.panel.bottom}, image bottom ${lowImage.bottom}`);
      check('the flipped panel is still fully on screen',
        g2.panel.top >= 0 && g2.panel.bottom <= g2.viewport.h,
        JSON.stringify(g2.panel));
      check('the flipped panel still clears the composer',
        g2.panel.bottom <= g2.composerTop + 1,
        `panel bottom ${g2.panel.bottom} vs composer top ${g2.composerTop}`);

      await page.keyboard.press('Escape');
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    } else {
      check('with no room below, the panel opens ABOVE the image', false, 'badge was not clickable');
    }

    /* --- back to a normal position for the removal test ------------------- */

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.locator('.cc-badge').first().click();
    await page.waitForSelector('.cc-panel', { timeout: 10000 });

    /* --- removal happens with ONE click, no second confirmation ---------- */

    const removeButton = page.locator('.cc-panel .cc-button--primary');
    check('one primary action is offered', (await removeButton.count()) === 1);
    check('the action is labelled clearly',
      /Remove credentials & save/i.test(await removeButton.innerText()));

    // The single click must produce the download directly. If a second
    // confirmation existed, no download event would ever arrive here.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      removeButton.click(),
    ]);
    check('ONE click downloads the file, with no second confirmation', true);

    const afterClickText = await page.locator('.cc-panel').innerText();
    check('no "Yes, remove and save" confirmation appeared', !/yes,\s*remove/i.test(afterClickText));
    check('no "are you sure" prompt appeared', !/are you sure/i.test(afterClickText));

    const suggested = download.suggestedFilename();
    check('download filename marks the file as processed', /-processed\.png$/.test(suggested), suggested);

    const savedPath = await download.path();
    const savedBytes = new Uint8Array(fs.readFileSync(savedPath));
    const savedReport = inspectImage(savedBytes);

    check('downloaded file is a valid PNG', savedReport.format === 'png');
    check('downloaded file has no credentials left',
      savedReport.status === STATUS.NO_CREDENTIALS_DETECTED, savedReport.status);
    check('downloaded file keeps its dimensions',
      savedReport.dimensions?.width === 600 && savedReport.dimensions?.height === 400,
      JSON.stringify(savedReport.dimensions));
    check('no caBX chunk survives in the downloaded file',
      !Buffer.from(savedBytes).toString('latin1').includes('caBX'));

    /* --- the saved state -------------------------------------------------- */

    await page.waitForFunction(
      () => /Saved/.test(
        document.getElementById('crediclean-overlay-host').shadowRoot.querySelector('.cc-panel')?.innerText || '',
      ),
      undefined,
      { timeout: 10000 },
    );
    const savedText = await page.locator('.cc-panel').innerText();
    check('button changes to a saved state', /Saved/.test(savedText));
    check('success message is shown', /removed and image saved/i.test(savedText));
    check('success state says the original is unchanged', /original is unchanged/i.test(savedText));
    check('saved button is disabled', await page.locator('.cc-panel .cc-button--done').isDisabled());

    /* --- the image with no credentials ----------------------------------- */

    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(400);

    await page.locator('#unsigned').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.locator('.cc-badge').nth(1).click();
    await page.waitForSelector('.cc-panel', { timeout: 15000 });
    const cleanText = await page.locator('.cc-panel').innerText();

    check('an image with no credentials says so plainly',
      /No supported credentials found/i.test(cleanText), cleanText.slice(0, 140));
    check('it still shows the three facts', /Format/.test(cleanText) && /Size/.test(cleanText) && /File/.test(cleanText));
    check('no removal action is offered when there is nothing to remove',
      (await page.locator('.cc-panel .cc-button--primary').count()) === 0);
    check('it does not imply anything was removed', !/removed/i.test(cleanText), cleanText.slice(0, 160));
    check('a Close button is offered', /Close/.test(cleanText));

    // Close must actually close.
    await page.locator('.cc-panel .cc-button').click();
    await page.waitForTimeout(300);
    check('the Close button closes the panel', (await page.locator('.cc-panel').count()) === 0);

    /* --- a long filename must not break the layout ------------------------ */

    await page.locator('#longname').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const longBadge = page.locator('.cc-badge').nth(2);
    await longBadge.click();
    await page.waitForSelector('.cc-panel', { timeout: 15000 });

    const longBox = await page.locator('.cc-panel').boundingBox();
    check('a long filename does not widen the panel',
      longBox.width >= 360 && longBox.width <= 420, `width was ${longBox.width}`);

    const fileCell = await page.evaluate(() => {
      const root = document.getElementById('crediclean-overlay-host').shadowRoot;
      const cell = root.querySelector('.cc-truncate');
      if (!cell) return null;
      return { clipped: cell.scrollWidth > cell.clientWidth, title: cell.title, text: cell.textContent };
    });
    check('the long filename is visually truncated', fileCell?.clipped === true, JSON.stringify(fileCell));
    check('the full filename stays available as a tooltip',
      typeof fileCell?.title === 'string' && fileCell.title.length > 0 && fileCell.title === fileCell.text);

    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);

    /* --- light theme ------------------------------------------------------ */

    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.body.style.background = '#ffffff';
      document.body.style.color = '#1f2023';
    });
    await page.waitForTimeout(600);
    const theme = await page.evaluate(
      () => document.getElementById('crediclean-overlay-host').shadowRoot.querySelector('.cc-layer').dataset.theme,
    );
    check('light page background switches the panel to the light theme', theme === 'light', `theme was ${theme}`);

    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.body.style.background = '#212121';
    });
    await page.waitForTimeout(600);
    const darkTheme = await page.evaluate(
      () => document.getElementById('crediclean-overlay-host').shadowRoot.querySelector('.cc-layer').dataset.theme,
    );
    check('dark page background switches it back', darkTheme === 'dark', `theme was ${darkTheme}`);

    /* --- the popup page loads -------------------------------------------- */

    const extensionId = context
      .serviceWorkers()
      .map((worker) => new URL(worker.url()).host)
      .find(Boolean);
    if (extensionId) {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.waitForSelector('#status-text');

      /*
       * Proof that the service worker's onInstalled handler ran to completion.
       *
       * That handler used a dynamic import(), which is forbidden inside a
       * service worker and threw an uncaught TypeError on every install. When
       * it throws, the default settings are never written. So finding them in
       * storage shows the handler reached its end, which it could not do
       * before the fix.
       */
      const seeded = await popup.evaluate(async () => {
        const stored = await chrome.storage.sync.get('crediclean.settings');
        return stored['crediclean.settings'] || null;
      });
      check('service worker install handler completed and seeded settings',
        seeded !== null && seeded.enabled === true, JSON.stringify(seeded));
      check('the removed confirmation setting is gone from storage',
        seeded !== null && !('confirmBeforeProcessing' in seeded), JSON.stringify(seeded));

      // The worker must also still be alive and evaluable.
      const worker = context.serviceWorkers()[0];
      const workerAlive = worker ? await worker.evaluate(() => typeof chrome !== 'undefined') : false;
      check('service worker is running', workerAlive === true);

      const statusText = await popup.locator('#status-text').innerText();
      check('popup opens and shows a status', statusText.length > 0 && statusText !== 'Checking…', statusText);
      const popupText = await popup.locator('body').innerText();

      check('popup states that nothing is uploaded',
        /nothing is uploaded/i.test(popupText), popupText.slice(0, 160));
      check('popup keeps the watermark caveat',
        /watermark/i.test(popupText), popupText.slice(0, 160));
      check('popup no longer offers the removed confirmation setting',
        (await popup.locator('#setting-confirm').count()) === 0);

      /*
       * The popup used to describe the extension as ChatGPT-only, which became
       * wrong the moment other platforms were added. It now builds its list
       * from the platform registry, so these checks make sure it keeps doing
       * so rather than drifting back to hard-coded wording.
       */
      const { ADAPTERS } = await import('../../src/platforms/index.js');
      const listed = await popup.locator('.site').allInnerTexts();
      check('popup lists every supported platform',
        ADAPTERS.every((adapter) => listed.includes(adapter.name)),
        `listed: ${listed.join(', ')}`);
      check('popup does not call itself ChatGPT-only',
        !/for ChatGPT images|Open ChatGPT to use it/i.test(popupText), popupText.slice(0, 160));
      check('popup does not name a single provider in its disclaimer',
        !/affiliated with OpenAI/i.test(popupText));

      const popupBox = await popup.evaluate(() => ({
        content: document.body.scrollHeight,
        width: document.body.scrollWidth,
      }));
      check('popup is compact enough not to scroll',
        popupBox.content <= 560, `content height ${popupBox.content}`);
      check('popup is a sensible width', popupBox.width <= 320, `width ${popupBox.width}`);
      await popup.close();
    } else {
      check('popup could be opened', false, 'could not determine the extension id');
    }

    /* --- nothing broke the page ------------------------------------------ */

    // Only certificate noise from the self-signed test cert is tolerated.
    const realErrors = pageErrors.filter((text) => !/ERR_CERT/i.test(text));
    check('no page errors were raised', realErrors.length === 0, realErrors.join(' | '));

    /* --- a look at the result, for the record ----------------------------- */

    if (process.env.CREDICLEAN_SCREENSHOT) {
      await page.locator('#signed').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.locator('.cc-badge').first().click();
      await page.waitForSelector('.cc-panel');
      await page.screenshot({ path: process.env.CREDICLEAN_SCREENSHOT, fullPage: false });
      console.log(`  info screenshot written to ${process.env.CREDICLEAN_SCREENSHOT}`);
    }
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
  console.error('\nThe browser test could not run:', error);
  process.exit(2);
});
