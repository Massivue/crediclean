#!/usr/bin/env node
/**
 * The whole app, end to end, driven by a real MCP client.
 *
 * WHAT THIS PROVES: our server speaks MCP correctly, declares the tools and
 * the OpenAI metadata ChatGPT needs, fetches an image over HTTPS from an
 * allowed host, runs the real credential engine on it, and hands back a
 * downloadable file that is verifiably clean and pixel-identical.
 *
 * WHAT THIS DOES NOT PROVE: that ChatGPT behaves the way we assume. Nothing
 * runnable from here can prove that, because it needs ChatGPT. In particular
 * it cannot prove that ChatGPT resolves `openai/fileParams` for an image IT
 * generated, which is the single fact the whole app depends on. See
 * docs/CHATGPT_NATIVE_PLUGIN_FEASIBILITY.md section 2, and the live checklist
 * in chatgpt-app/README.md.
 *
 * Run with:  npm run test:e2e
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, '..', '..');
const REPO_ROOT = path.join(APP_ROOT, '..');

/*
 * Config for the run, set BEFORE the server modules are imported, because they
 * read it once at start-up.
 *
 * The allowlist is pointed at localhost only here. Production defaults stay
 * strict, and the unit tests cover the guard itself against real attack
 * addresses. TLS verification is relaxed only for this process, because the
 * mock file host uses the project's throwaway self-signed certificate.
 */
const FILE_HOST_PORT = 8443;
const APP_PORT = 8788;
process.env.CREDICLEAN_ALLOWED_HOSTS = 'localhost';
process.env.CREDICLEAN_PUBLIC_URL = `http://localhost:${APP_PORT}`;
process.env.PORT = String(APP_PORT);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { createHttpServer } = await import('../../src/server.js');
const { inspectImage, STATUS } = await import(
  path.join(REPO_ROOT, 'src/processing/metadata-inspector.js')
);
const { comparePixelData } = await import(
  path.join(REPO_ROOT, 'src/processing/credential-processor.js')
);
const { buildPng, buildC2paManifestStore } = await import(path.join(REPO_ROOT, 'tests/fixtures.js'));

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

/* The images our mock OpenAI file host serves. */
const signed = buildPng({
  width: 1536,
  height: 1024,
  c2pa: buildC2paManifestStore({ claimGenerator: 'OpenAI/DALL-E' }),
  xmp: 'provenance',
});
const unsigned = buildPng({ width: 800, height: 600 });

/** Stands in for OpenAI's file host. HTTPS, because the server insists on it. */
function startFileHost() {
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(REPO_ROOT, 'tests/e2e/key.pem')),
      cert: fs.readFileSync(path.join(REPO_ROOT, 'tests/e2e/cert.pem')),
    },
    (request, response) => {
      const bytes = request.url.includes('unsigned') ? unsigned : signed;
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': bytes.length,
      });
      response.end(Buffer.from(bytes));
    },
  );
  return new Promise((resolve) => server.listen(FILE_HOST_PORT, '127.0.0.1', () => resolve(server)));
}

const fileUrl = (name) => `https://localhost:${FILE_HOST_PORT}/${name}`;

/** What ChatGPT is documented to pass once `openai/fileParams` resolves. */
const fileRef = (name) => ({
  download_url: fileUrl(name),
  file_id: `file-${name}`,
  mime_type: 'image/png',
  file_name: `${name}.png`,
});

async function connectClient() {
  const client = new Client({ name: 'crediclean-test-host', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${APP_PORT}/mcp`));
  await client.connect(transport);
  return { client, transport };
}

/** Pull the structured result out of a tool call, whatever shape it arrives in. */
function structured(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((part) => part.type === 'text')?.text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textOf(result) {
  return (result?.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

async function main() {
  const fileHost = await startFileHost();
  const app = createHttpServer();
  await new Promise((resolve) => app.listen(APP_PORT, '127.0.0.1', resolve));

  let client;
  let transport;
  try {
    /* ---------------------------------------------------------------- */
    console.log('\n--- Connecting, the way ChatGPT would ---');
    ({ client, transport } = await connectClient());
    check('the server completes an MCP handshake', true);

    /* ---------------------------------------------------------------- */
    console.log('\n--- What ChatGPT would see ---');
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    check('both tools are offered', tools.length === 2, tools.map((t) => t.name).join(', '));
    check('inspect_image_credentials exists', Boolean(byName.inspect_image_credentials));
    check('remove_image_credentials exists', Boolean(byName.remove_image_credentials));

    for (const name of ['inspect_image_credentials', 'remove_image_credentials']) {
      const meta = byName[name]?._meta || {};
      check(`${name}: declares openai/fileParams for the image`,
        Array.isArray(meta['openai/fileParams']) && meta['openai/fileParams'].includes('image'),
        JSON.stringify(meta['openai/fileParams']));
      check(`${name}: points at the widget`,
        meta['openai/outputTemplate'] === 'ui://widget/crediclean-panel.html',
        String(meta['openai/outputTemplate']));
    }
    check('the removal tool can be called from our own panel',
      byName.remove_image_credentials?._meta?.['openai/widgetAccessible'] === true);
    check('inspection is marked read-only, so the host knows it is safe',
      byName.inspect_image_credentials?.annotations?.readOnlyHint === true);

    const descriptions = tools.map((tool) => tool.description).join(' ');
    /*
     * The word "untraceable" is ALLOWED here, because the description says the
     * tool does NOT make an image untraceable. What must never appear is the
     * affirmative claim.
     *
     * A regex for "claim but not denial" is the kind of clever that gets this
     * wrong quietly, so this is written out: find every occurrence of the
     * word, and require a negation close in front of it.
     */
    const claimWords = /untraceable|undetectable/gi;
    const unnegated = [];
    for (const match of descriptions.matchAll(claimWords)) {
      const before = descriptions.slice(Math.max(0, match.index - 60), match.index);
      if (!/\b(not|never|cannot|doesn't|does not)\b/i.test(before)) unnegated.push(match[0]);
    }
    check('no tool description claims an image is made untraceable',
      unnegated.length === 0, unnegated.join(', '));
    check('and one of them explicitly denies it',
      [...descriptions.matchAll(claimWords)].length > 0,
      'the denial should be stated, not merely implied by silence');
    check('the removal tool states that watermarks are not removed',
      /SynthID/i.test(byName.remove_image_credentials?.description || ''));

    /* ---------------------------------------------------------------- */
    console.log('\n--- The widget ---');
    const widget = await client.readResource({ uri: 'ui://widget/crediclean-panel.html' });
    const html = widget.contents?.[0]?.text || '';
    check('the widget resource is served', html.length > 500, `${html.length} bytes`);
    check('it is declared as the type ChatGPT renders',
      widget.contents?.[0]?.mimeType === 'text/html+skybridge',
      String(widget.contents?.[0]?.mimeType));
    /*
     * The widget renders a filename read out of an image file, which is
     * untrusted input. Assigning that to innerHTML would be a script-injection
     * hole. The word may appear in a comment warning against it; what must
     * never appear is an assignment to it.
     */
    check('the widget never assigns to innerHTML', !/\.innerHTML\s*=/.test(html));
    check('and it does use textContent', /textContent/.test(html));

    /* ---------------------------------------------------------------- */
    console.log('\n--- Inspecting a signed image ---');
    const inspected = await client.callTool({
      name: 'inspect_image_credentials',
      arguments: { image: fileRef('signed') },
    });
    const report = structured(inspected);
    check('credentials are found', report?.status === 'credentials-detected', report?.status);
    check('the headline is the plain one', report?.headline === 'Content Credentials found');
    check('it offers removal', report?.canRemove === true);
    check('the real dimensions are reported', report?.facts?.dimensions === '1536 × 1024',
      report?.facts?.dimensions);
    check('the format is reported', /PNG/i.test(report?.facts?.format || ''));
    check('no C2PA jargon leaks into what the user reads',
      !/\bC2PA\b|manifest|jumbf/i.test(textOf(inspected)), textOf(inspected).slice(0, 120));

    /* ---------------------------------------------------------------- */
    console.log('\n--- Inspecting an image with nothing in it ---');
    const clean = structured(await client.callTool({
      name: 'inspect_image_credentials',
      arguments: { image: fileRef('unsigned') },
    }));
    check('it says so plainly', clean?.headline === 'No supported credentials found', clean?.headline);
    check('it offers nothing to remove', clean?.canRemove === false);

    /* ---------------------------------------------------------------- */
    console.log('\n--- Removing, and getting the file back ---');
    const removedResult = await client.callTool({
      name: 'remove_image_credentials',
      arguments: { image: fileRef('signed') },
    });
    const removed = structured(removedResult);
    check('the removal reports success', removed?.removed === true, removed?.status);
    check('a download address comes back', typeof removed?.download?.url === 'string',
      String(removed?.download?.url));
    check('the filename marks it as processed',
      /-processed\.png$/.test(removed?.download?.filename || ''), removed?.download?.filename);
    check('the download expires', Boolean(removed?.download?.expiresAt));
    check('the honest note about watermarks is included',
      /SynthID/i.test(removed?.note || ''));
    check('the text reply never claims the image is untraceable',
      !/untraceable|undetectable/i.test(textOf(removedResult)));

    /* ---------------------------------------------------------------- */
    console.log('\n--- The file a user would actually download ---');
    const response = await fetch(removed.download.url);
    check('the download works', response.ok, `HTTP ${response.status}`);
    check('it is sent as a file to save, with its name',
      /attachment/.test(response.headers.get('content-disposition') || '') &&
        (response.headers.get('content-disposition') || '').includes('-processed.png'),
      String(response.headers.get('content-disposition')));
    check('it is served as a PNG', response.headers.get('content-type') === 'image/png');
    check('nothing caches somebody’s picture',
      /no-store/.test(response.headers.get('cache-control') || ''));

    const processed = new Uint8Array(await response.arrayBuffer());
    const after = inspectImage(processed);
    check('the processed file has NO credentials left',
      after.status === STATUS.NO_CREDENTIALS_DETECTED, after.status);
    check('it is still a valid PNG', after.format === 'png', after.format);
    check('the dimensions survived',
      after.dimensions?.width === 1536 && after.dimensions?.height === 1024,
      JSON.stringify(after.dimensions));
    check('it got smaller, because something really was removed', processed.length < signed.length,
      `${signed.length} -> ${processed.length}`);

    const pixels = comparePixelData(signed, processed, 'png');
    check('the picture is pixel-for-pixel identical to the original', pixels.identical === true,
      JSON.stringify(pixels));

    /* ---------------------------------------------------------------- */
    console.log('\n--- Removing from an image with nothing to remove ---');
    const nothing = structured(await client.callTool({
      name: 'remove_image_credentials',
      arguments: { image: fileRef('unsigned') },
    }));
    check('it reports nothing to remove', nothing?.removed === false, nothing?.status);
    check('it offers no file', nothing?.download === undefined);
    check('it does not imply anything was done',
      !/removed and saved|cleaned/i.test(nothing?.message || ''), nothing?.message);

    /* ---------------------------------------------------------------- */
    console.log('\n--- The failure that matters: ChatGPT sends a path, not a file ---');
    const unresolved = await client.callTool({
      name: 'inspect_image_credentials',
      arguments: { image: '/mnt/data/image.png' },
    });
    check('the request fails rather than crashing the server', unresolved?.isError === true);
    check('the message explains it is a platform limit, in plain words',
      /file path/i.test(textOf(unresolved)), textOf(unresolved).slice(0, 160));
    check('it does not blame the user’s image',
      !/corrupt|invalid image|bad file/i.test(textOf(unresolved)));

    /* ---------------------------------------------------------------- */
    console.log('\n--- A download address we should refuse ---');
    const ssrf = await client.callTool({
      name: 'inspect_image_credentials',
      arguments: {
        image: { download_url: 'http://169.254.169.254/latest/meta-data/', file_name: 'x.png' },
      },
    });
    check('a cloud-metadata address is refused', ssrf?.isError === true);
    check('the refusal does not echo the address back to the model',
      !textOf(ssrf).includes('169.254.169.254'), textOf(ssrf));

    /* ---------------------------------------------------------------- */
    console.log('\n--- Download links are not guessable, and do expire ---');
    const missing = await fetch(`http://localhost:${APP_PORT}/files/not-a-real-token`);
    check('an unknown download token gives 404', missing.status === 404, String(missing.status));

    const health = await fetch(`http://localhost:${APP_PORT}/health`);
    check('the health endpoint answers', health.ok);

    /* ---------------------------------------------------------------- */
    console.log('\n--- The server survives rubbish ---');
    const junk = await fetch(`http://localhost:${APP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    });
    check('malformed input is rejected, not crashed on', junk.status >= 400 && junk.status < 500,
      String(junk.status));
    const stillUp = await fetch(`http://localhost:${APP_PORT}/health`);
    check('and the server is still running afterwards', stillUp.ok);
  } finally {
    if (transport) await transport.close().catch(() => {});
    if (client) await client.close().catch(() => {});
    app.close();
    fileHost.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nThe app tests could not run:', error);
  process.exit(2);
});
