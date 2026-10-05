#!/usr/bin/env node
/**
 * The panel, rendered in a real Chromium with a stand-in for ChatGPT's host.
 *
 * WHAT THIS PROVES: the widget reads what the host gives it, draws the right
 * thing for each outcome, offers the right action, and never injects markup
 * from a filename.
 *
 * WHAT THIS DOES NOT PROVE: that ChatGPT's real host sets the globals the way
 * this stand-in does, or that it renders in the frame the way it does here.
 * Only ChatGPT can show that.
 *
 * Run with:  npm run test:widget
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, '..', '..', 'widget', 'panel.html');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
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

/**
 * Stand in for ChatGPT's host.
 *
 * Installed before the page's own script runs, so the panel sees it on first
 * render, exactly as it would in ChatGPT.
 */
function hostScript(toolOutput, toolInput = {}) {
  return `window.openai = {
    toolOutput: ${JSON.stringify(toolOutput)},
    toolInput: ${JSON.stringify(toolInput)},
    callTool: async (name, args) => {
      window.__called = { name, args };
      return { structuredContent: {
        status: 'removed', headline: 'Credentials removed', removed: true, canRemove: false,
        facts: { format: 'PNG', dimensions: '1536 × 1024', filename: 'picture.png' },
        download: { url: 'https://example.test/files/abc', filename: 'picture-processed.png' },
        note: 'Invisible watermarks inside the picture, such as SynthID, are not affected.'
      } };
    },
  };`;
}

async function withPanel(context, toolOutput, toolInput, run) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(hostScript(toolOutput, toolInput));
  await page.goto(`file://${PANEL}`);
  await page.waitForTimeout(150);
  try {
    await run(page, errors);
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext();

  try {
    /* -------------------------------------------------------------- */
    console.log('\n--- Credentials found ---');
    await withPanel(
      context,
      {
        status: 'credentials-detected',
        headline: 'Content Credentials found',
        canRemove: true,
        facts: { format: 'PNG', dimensions: '1536 × 1024', filename: 'picture.png' },
      },
      { image: { file_id: 'file-1' } },
      async (page, errors) => {
        const text = await page.locator('#card').innerText();
        check('the headline is shown', /Content Credentials found/.test(text));
        check('Format, Size and File are all shown',
          /Format/.test(text) && /Size/.test(text) && /File/.test(text));
        check('the real dimensions are shown', /1536\s*×\s*1024/.test(text));
        check('no technical credential detail reaches the user',
          !/\bC2PA\b|manifest|jumbf/i.test(text), text.slice(0, 120));

        const button = page.locator('button.button--primary');
        check('one removal action is offered', (await button.count()) === 1);
        check('it says what it does',
          (await button.innerText()).trim() === 'Remove credentials & save');

        check('the status dot is the "found" colour',
          (await page.locator('.status--found').count()) === 1);
        check('no page errors', errors.length === 0, errors.join(' | '));
      },
    );

    /* -------------------------------------------------------------- */
    console.log('\n--- Clicking Remove ---');
    await withPanel(
      context,
      {
        status: 'credentials-detected',
        headline: 'Content Credentials found',
        canRemove: true,
        facts: { format: 'PNG', dimensions: '1536 × 1024', filename: 'picture.png' },
      },
      { image: { file_id: 'file-1', download_url: 'https://files.oaiusercontent.com/f' } },
      async (page, errors) => {
        await page.locator('button.button--primary').click();
        await page.waitForSelector('a.button--primary', { timeout: 5000 });

        const called = await page.evaluate(() => window.__called);
        check('it calls our removal tool', called?.name === 'remove_image_credentials',
          JSON.stringify(called));
        check('and passes the same image back', Boolean(called?.args?.image?.file_id),
          JSON.stringify(called?.args));

        const text = await page.locator('#card').innerText();
        check('the panel then shows the result', /Credentials removed/.test(text));

        const link = page.locator('a.button--primary');
        check('a download link appears', (await link.count()) === 1);
        check('it points at the processed file',
          (await link.getAttribute('href')) === 'https://example.test/files/abc');
        check('it saves under the processed name',
          (await link.getAttribute('download')) === 'picture-processed.png');
        check('the watermark limit is repeated, every time', /SynthID/i.test(text));
        check('no page errors', errors.length === 0, errors.join(' | '));
      },
    );

    /* -------------------------------------------------------------- */
    console.log('\n--- Nothing to remove ---');
    await withPanel(
      context,
      {
        status: 'no-credentials-detected',
        headline: 'No supported credentials found',
        canRemove: false,
        facts: { format: 'JPEG', dimensions: '800 × 600', filename: 'photo.jpg' },
        message: 'There is nothing to remove from this image.',
      },
      {},
      async (page, errors) => {
        const text = await page.locator('#card').innerText();
        check('it says so plainly', /No supported credentials found/.test(text));
        check('no action is offered', (await page.locator('button.button--primary').count()) === 0);
        check('no download link is offered', (await page.locator('a.button').count()) === 0);
        check('it never implies anything was removed', !/removed/i.test(text), text);
        check('no page errors', errors.length === 0, errors.join(' | '));
      },
    );

    /* -------------------------------------------------------------- */
    console.log('\n--- Something went wrong ---');
    await withPanel(
      context,
      { status: 'error', headline: "Couldn't process this image", message: 'Please try again.' },
      {},
      async (page, errors) => {
        const text = await page.locator('#card').innerText();
        check('the error is shown in plain words', /Couldn't process this image/.test(text));
        check('it is marked as a warning', (await page.locator('.status--warn').count()) === 1);
        check('no action is offered', (await page.locator('button.button--primary').count()) === 0);
        check('no page errors', errors.length === 0, errors.join(' | '));
      },
    );

    /* -------------------------------------------------------------- */
    console.log('\n--- A filename that tries to inject markup ---');
    await withPanel(
      context,
      {
        status: 'credentials-detected',
        headline: 'Content Credentials found',
        canRemove: true,
        facts: {
          format: 'PNG',
          dimensions: '100 × 100',
          // The filename is read out of an image file, so it is untrusted.
          filename: '<img src=x onerror="window.__pwned=1">evil.png',
        },
      },
      {},
      async (page, errors) => {
        const pwned = await page.evaluate(() => window.__pwned);
        check('no script from the filename ran', pwned === undefined);
        check('no element was created from it',
          (await page.locator('#card img').count()) === 0);
        const text = await page.locator('#card').innerText();
        check('it is shown as literal text instead', text.includes('<img src=x'), text.slice(0, 160));
        check('no page errors', errors.length === 0, errors.join(' | '));
      },
    );

    /* -------------------------------------------------------------- */
    console.log('\n--- A host with no callTool, which mobile may well be ---');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(`window.openai = {
      toolOutput: {
        status: 'credentials-detected', headline: 'Content Credentials found', canRemove: true,
        facts: { format: 'PNG', dimensions: '1536 × 1024', filename: 'picture.png' },
      },
      toolInput: {},
    };`);
    await page.goto(`file://${PANEL}`);
    await page.waitForTimeout(150);
    await page.locator('button.button--primary').click();
    await page.waitForTimeout(150);
    const text = await page.locator('#card').innerText();
    check('the button does not fail silently', /Not available here/.test(text), text.slice(0, 160));
    check('it tells the user what to do instead', /Ask ChatGPT/i.test(text));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.close();

    /* -------------------------------------------------------------- */
    console.log('\n--- Nothing from the host at all ---');
    const bare = await context.newPage();
    const bareErrors = [];
    bare.on('pageerror', (error) => bareErrors.push(String(error)));
    await bare.goto(`file://${PANEL}`);
    await bare.waitForTimeout(150);
    check('it renders something rather than throwing',
      (await bare.locator('#card').innerText()).length > 0);
    check('no page errors', bareErrors.length === 0, bareErrors.join(' | '));
    await bare.close();
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nThe widget tests could not run:', error);
  process.exit(2);
});
