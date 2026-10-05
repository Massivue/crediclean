/** Filename construction for saved files. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFilename, sourceFilename } from '../src/processing/download-manager.js';
import { FORMAT } from '../src/formats/detect.js';

const FIXED_DATE = new Date('2026-03-04T09:08:07Z');

test('uses the name from the URL and marks the file as processed', () => {
  const name = buildFilename({
    url: 'https://files.oaiusercontent.com/file-ABC123/sunset.png',
    format: FORMAT.PNG,
  });
  assert.equal(name, 'sunset-processed.png');
});

test('keeps the extension matching the real format, not the one in the URL', () => {
  // ChatGPT can serve a WebP from a URL that ends in .png.
  const name = buildFilename({
    url: 'https://files.oaiusercontent.com/file-1/picture.png',
    format: FORMAT.WEBP,
  });
  assert.equal(name, 'picture-processed.webp');
});

test('ignores query strings on signed URLs', () => {
  const name = buildFilename({
    url: 'https://chatgpt.com/backend-api/estuary/content?id=file-9&ts=123&sig=abc',
    format: FORMAT.PNG,
    now: FIXED_DATE,
  });
  assert.equal(name, 'content-processed.png');
});

test('falls back to the alt text when the URL has no usable name', () => {
  const name = buildFilename({
    url: 'https://files.oaiusercontent.com/',
    format: FORMAT.JPEG,
    altText: 'A red bicycle on a beach',
  });
  assert.equal(name, 'A-red-bicycle-on-a-beach-processed.jpg');
});

test('falls back to a dated name when there is nothing else to use', () => {
  const name = buildFilename({
    url: 'https://files.oaiusercontent.com/',
    format: FORMAT.PNG,
    now: FIXED_DATE,
  });
  assert.equal(name, 'crediclean-image-2026-03-04-09-08-07-processed.png');
});

test('strips characters that are unsafe in a filename', () => {
  const name = buildFilename({
    url: 'https://files.oaiusercontent.com/',
    format: FORMAT.PNG,
    altText: 'a/b\\c:d*e?f"g<h>i|j',
  });
  assert.ok(!/[\\/:*?"<>|]/.test(name), `unsafe characters survived: ${name}`);
  assert.ok(name.endsWith('-processed.png'));
});

test('a different suffix is used for an unchanged copy', () => {
  const name = buildFilename({
    url: 'https://files.oaiusercontent.com/file-1/cat.png',
    format: FORMAT.PNG,
    suffix: '-copy',
  });
  assert.equal(name, 'cat-copy.png');
});

test('very long names are shortened', () => {
  const name = buildFilename({
    url: 'https://files.oaiusercontent.com/',
    format: FORMAT.PNG,
    altText: 'x'.repeat(500),
  });
  assert.ok(name.length < 120, `name was ${name.length} characters`);
});

test('an unsupported format still produces a sensible name', () => {
  const name = buildFilename({ url: 'https://example.com/thing.gif', format: FORMAT.GIF });
  assert.equal(name, 'thing-processed.gif');
});

/* The panel's "File" row shows the image's own name, with no suffix. */

test('source filename has no processing suffix', () => {
  const name = sourceFilename({
    url: 'https://files.oaiusercontent.com/file-1/image-1234.png',
    format: FORMAT.PNG,
  });
  assert.equal(name, 'image-1234.png');
});

test('source filename still corrects the extension to the real format', () => {
  const name = sourceFilename({
    url: 'https://files.oaiusercontent.com/file-1/photo.png',
    format: FORMAT.WEBP,
  });
  assert.equal(name, 'photo.webp');
});

test('source filename falls back when the URL carries no name', () => {
  const name = sourceFilename({
    url: 'https://chatgpt.com/backend-api/estuary/content?id=file-9',
    format: FORMAT.PNG,
    altText: 'A mountain at dusk',
  });
  assert.equal(name, 'content.png');
});

test('a very long source filename is capped so it cannot break the panel', () => {
  const name = sourceFilename({
    url: `https://files.oaiusercontent.com/${'a'.repeat(300)}.png`,
    format: FORMAT.PNG,
  });
  assert.ok(name.length <= 84, `name was ${name.length} characters`);
  assert.ok(name.endsWith('.png'));
});

/* ------------------------------------------------------------------ */
/* Fetching the ORIGINAL, not a resized derivative                     */
/* ------------------------------------------------------------------ */

/*
 * These matter more than they look. A resizing CDN re-encodes the image, and
 * a re-encoded copy carries none of the original's credentials. Inspecting one
 * reports "no credentials found" however correct the engine is, which is
 * exactly the Gemini symptom these candidates exist to fix.
 */

test('Gemini asks the Google CDN for the original before the displayed size', async () => {
  const { geminiAdapter } = await import('../src/platforms/gemini.js');
  const candidates = geminiAdapter.sourceUrlCandidates(
    'https://lh3.googleusercontent.com/gg/AbCdEf123=w526-h296-rw',
  );
  assert.equal(candidates[0], 'https://lh3.googleusercontent.com/gg/AbCdEf123=s0',
    'the original must be tried first');
  assert.equal(candidates[1], 'https://lh3.googleusercontent.com/gg/AbCdEf123=d',
    'the explicit download form is tried too');
  assert.ok(candidates.includes('https://lh3.googleusercontent.com/gg/AbCdEf123=w526-h296-rw'),
    'the page address must remain as a fallback');
});

test('Gemini handles every shape of Google image address', async () => {
  const { geminiAdapter } = await import('../src/platforms/gemini.js');
  const expectFirst = (input, first) => {
    assert.equal(geminiAdapter.sourceUrlCandidates(input)[0], first, `for ${input}`);
  };
  expectFirst('https://lh3.googleusercontent.com/gg/A=s512', 'https://lh3.googleusercontent.com/gg/A=s0');
  expectFirst('https://lh3.googleusercontent.com/gg/A', 'https://lh3.googleusercontent.com/gg/A=s0');
  expectFirst('https://lh3.googleusercontent.com/gg/A=w800-h600?authuser=0',
    'https://lh3.googleusercontent.com/gg/A=s0?authuser=0');
});

test('Gemini leaves non-CDN addresses untouched', async () => {
  const { geminiAdapter } = await import('../src/platforms/gemini.js');
  const url = 'https://gemini.google.com/some/path.png';
  assert.deepEqual(geminiAdapter.sourceUrlCandidates(url), [url]);
});

test('Gemini never drops the page address, so a wrong guess cannot break retrieval', async () => {
  const { geminiAdapter } = await import('../src/platforms/gemini.js');
  for (const url of [
    'https://lh3.googleusercontent.com/gg/A=w1-h1',
    'https://lh5.googleusercontent.com/weird=',
    'https://usercontent.google.com/x=s100',
    'not a url at all',
  ]) {
    assert.ok(geminiAdapter.sourceUrlCandidates(url).includes(url), `fallback missing for ${url}`);
  }
});

test('Grok asks X for the full-size original first', async () => {
  const { grokAdapter } = await import('../src/platforms/grok.js');
  const candidates = grokAdapter.sourceUrlCandidates(
    'https://pbs.twimg.com/media/ABC.jpg?format=jpg&name=small',
  );
  assert.equal(candidates[0], 'https://pbs.twimg.com/media/ABC.jpg?format=jpg&name=orig');
  assert.ok(candidates.includes('https://pbs.twimg.com/media/ABC.jpg?format=jpg&name=small'));
});

test('Grok leaves addresses without a size parameter alone', async () => {
  const { grokAdapter } = await import('../src/platforms/grok.js');
  for (const url of [
    'https://assets.grok.com/users/x/generated/abc.jpg',
    'https://pbs.twimg.com/media/ABC.jpg',
    'not a url',
  ]) {
    assert.deepEqual(grokAdapter.sourceUrlCandidates(url), [url]);
  }
});

test('ChatGPT supplies no candidates hook, so its behaviour is unchanged', async () => {
  const { chatgptAdapter } = await import('../src/platforms/chatgpt.js');
  assert.equal(typeof chatgptAdapter.sourceUrlCandidates, 'undefined',
    'adding one here would change the one platform that is confirmed working');
});
