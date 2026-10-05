/**
 * Image detection across the four supported platforms.
 *
 * These exercise the decision logic with plain stand-in objects rather than a
 * real browser. That covers the rules, but it CANNOT prove the selectors match
 * any real page. Only ChatGPT has been confirmed on the live site. See
 * docs/PLATFORM_TEST_MATRIX.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyImageUrl,
  evaluateImage,
  isImageLoaded,
  CLASSIFICATION,
  MIN_CONTENT_EDGE_PX,
} from '../src/content/image-detector.js';
import { chatgptAdapter } from '../src/platforms/chatgpt.js';
import { geminiAdapter } from '../src/platforms/gemini.js';
import { grokAdapter } from '../src/platforms/grok.js';
import { adapterForHost, allImageHosts, allPageHosts, supportMatrix, SUPPORT } from '../src/platforms/index.js';

/** A stand-in for an <img>, exposing only the properties the detector reads. */
function fakeImage({
  src = 'https://files.oaiusercontent.com/file-abc123',
  naturalWidth = 1024,
  naturalHeight = 1024,
  complete = true,
  ancestors = [],
  alt = '',
} = {}) {
  return {
    src,
    currentSrc: src,
    naturalWidth,
    naturalHeight,
    clientWidth: naturalWidth,
    clientHeight: naturalHeight,
    complete,
    getAttribute: (name) => (name === 'src' ? src : name === 'alt' ? alt : null),
    closest: (selector) => (ancestors.includes(selector) ? { tagName: 'DIV' } : null),
  };
}

/* ---------------------------------------------------------------- */
/* The registry                                                      */
/* ---------------------------------------------------------------- */

test('each platform host routes to its own adapter', () => {
  assert.equal(adapterForHost('chatgpt.com').id, 'chatgpt');
  assert.equal(adapterForHost('chat.openai.com').id, 'chatgpt');
  assert.equal(adapterForHost('gemini.google.com').id, 'gemini');
  assert.equal(adapterForHost('grok.com').id, 'grok');
  assert.equal(adapterForHost('x.com').id, 'grok');
});

test('subdomains route to the right adapter', () => {
  assert.equal(adapterForHost('www.chatgpt.com').id, 'chatgpt');
  assert.equal(adapterForHost('sub.gemini.google.com').id, 'gemini');
});

test('an unsupported site gets no adapter at all', () => {
  assert.equal(adapterForHost('example.com'), null);
  assert.equal(adapterForHost('notchatgpt.com'), null);
  assert.equal(adapterForHost(''), null);
  assert.equal(adapterForHost(undefined), null);
});

test('the registry does not claim broad or dangerous hosts', () => {
  for (const host of [...allPageHosts(), ...allImageHosts()]) {
    assert.ok(host.includes('.'), `not a real host: ${host}`);
    assert.ok(!host.startsWith('*'), `wildcard host in registry: ${host}`);
    // A bare registrable domain for a huge property would be too broad.
    assert.ok(!['google.com', 'microsoft.com', 'com'].includes(host), `too broad: ${host}`);
  }
});

test('Grok credential support is recorded as unknown, not as supported', () => {
  const matrix = supportMatrix();
  assert.equal(matrix.grok.c2paDetection, SUPPORT.UNKNOWN);
  assert.equal(matrix.grok.processing, SUPPORT.UNKNOWN);
  // ChatGPT is the only platform confirmed on a live site.
  assert.equal(matrix.chatgpt.c2paDetection, SUPPORT.VERIFIED);
  assert.equal(matrix.gemini.c2paDetection, SUPPORT.UNVERIFIED);
});

/* ---------------------------------------------------------------- */
/* ChatGPT: the verified platform. These must not regress.           */
/* ---------------------------------------------------------------- */

test('ChatGPT: content hosts are treated as content', () => {
  assert.equal(classifyImageUrl('https://files.oaiusercontent.com/file-abc', chatgptAdapter), CLASSIFICATION.CONTENT);
  assert.equal(classifyImageUrl('https://sdmntprwestus.oaiusercontent.com/files/x.png', chatgptAdapter), CLASSIFICATION.CONTENT);
  assert.equal(classifyImageUrl('https://chatgpt.com/backend-api/estuary/content?id=file-1', chatgptAdapter), CLASSIFICATION.CONTENT);
  assert.equal(classifyImageUrl('blob:https://chatgpt.com/8a7f-21', chatgptAdapter), CLASSIFICATION.CONTENT);
});

test('ChatGPT: interface assets are excluded', () => {
  assert.equal(classifyImageUrl('https://cdn.oaistatic.com/assets/logo.svg', chatgptAdapter), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('https://lh3.googleusercontent.com/a/profile-pic', chatgptAdapter), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('data:image/svg+xml;base64,AAAA', chatgptAdapter), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('', chatgptAdapter), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl(null, chatgptAdapter), CLASSIFICATION.INTERFACE);
});

test('ChatGPT: a large generated image is eligible', () => {
  const verdict = evaluateImage(fakeImage(), chatgptAdapter);
  assert.equal(verdict.eligible, true);
});

test('ChatGPT: small images are rejected, keeping avatars and icons clean', () => {
  const small = fakeImage({ naturalWidth: MIN_CONTENT_EDGE_PX - 1, naturalHeight: 512 });
  assert.equal(evaluateImage(small, chatgptAdapter).reason, 'too-small');
});

test('ChatGPT: an image inside interface furniture is rejected however large', () => {
  assert.equal(evaluateImage(fakeImage({ ancestors: ['button'] }), chatgptAdapter).reason, 'inside-interface');
  assert.equal(evaluateImage(fakeImage({ ancestors: ['nav'] }), chatgptAdapter).reason, 'inside-interface');
  assert.equal(evaluateImage(fakeImage({ ancestors: ['header'] }), chatgptAdapter).reason, 'inside-interface');
});

test('ChatGPT: an image still loading is deferred, not rejected', () => {
  const loading = fakeImage({ complete: false, naturalWidth: 0, naturalHeight: 0 });
  assert.equal(evaluateImage(loading, chatgptAdapter).reason, 'not-loaded',
    'the watcher relies on this exact reason to retry later');
});

test('ChatGPT: an image that failed to load is not eligible', () => {
  const broken = fakeImage({ complete: true, naturalWidth: 0, naturalHeight: 0 });
  assert.equal(isImageLoaded(broken), false);
  assert.equal(evaluateImage(broken, chatgptAdapter).eligible, false);
});

test('ChatGPT: an unfamiliar host is accepted only inside a message element', () => {
  const outside = fakeImage({ src: 'https://example.com/picture.png' });
  assert.equal(evaluateImage(outside, chatgptAdapter).reason, 'unknown-host-outside-message');

  const inside = fakeImage({ src: 'https://example.com/picture.png', ancestors: ['[data-message-author-role]'] });
  assert.equal(evaluateImage(inside, chatgptAdapter).eligible, true);
});

/* ---------------------------------------------------------------- */
/* Gemini                                                            */
/* ---------------------------------------------------------------- */

test('Gemini: a Google account profile picture is excluded', () => {
  // This is the important one. Gemini may serve generated images from the same
  // domain as profile pictures, so the exclusion must be path-specific.
  assert.equal(classifyImageUrl('https://lh3.googleusercontent.com/a/ACg8ocK', geminiAdapter), CLASSIFICATION.INTERFACE);
});

test('Gemini: a generated image on the same domain is NOT excluded', () => {
  assert.equal(classifyImageUrl('https://lh3.googleusercontent.com/gg/ABC123', geminiAdapter), CLASSIFICATION.UNKNOWN);
});

test('Gemini: an unknown-host image is accepted inside a model response', () => {
  const src = 'https://lh3.googleusercontent.com/gg/ABC123';
  assert.equal(evaluateImage(fakeImage({ src }), geminiAdapter).reason, 'unknown-host-outside-message');
  assert.equal(evaluateImage(fakeImage({ src, ancestors: ['model-response'] }), geminiAdapter).eligible, true);
});

test('Gemini: interface assets are excluded', () => {
  assert.equal(classifyImageUrl('https://www.gstatic.com/images/branding/x.png', geminiAdapter), CLASSIFICATION.INTERFACE);
});

test('Gemini records SynthID as provenance it cannot remove', () => {
  assert.ok(Array.isArray(geminiAdapter.knownUnremovableProvenance));
  assert.match(geminiAdapter.knownUnremovableProvenance.join(' '), /SynthID/);
});

/* ----------------------------------------------------------------- */
/* Grok                                                              */
/* ---------------------------------------------------------------- */

test('Grok: X media is treated as content but profile images are not', () => {
  assert.equal(classifyImageUrl('https://pbs.twimg.com/media/ABC.jpg', grokAdapter), CLASSIFICATION.CONTENT);
  assert.equal(classifyImageUrl('https://pbs.twimg.com/profile_images/1/x.jpg', grokAdapter), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('https://pbs.twimg.com/profile_banners/1/x.jpg', grokAdapter), CLASSIFICATION.INTERFACE);
  assert.equal(classifyImageUrl('https://abs.twimg.com/emoji/v2/svg/1f600.svg', grokAdapter), CLASSIFICATION.INTERFACE);
});

test('Grok: grok.com assets are treated as content', () => {
  assert.equal(classifyImageUrl('https://assets.grok.com/users/x/generated/abc.jpg', grokAdapter), CLASSIFICATION.CONTENT);
});

test('Grok makes NO claim that credentials exist', () => {
  // The adapter must not assert C2PA support anywhere, because it is unproven.
  assert.equal(grokAdapter.support.c2paDetection, SUPPORT.UNKNOWN);
  assert.equal(grokAdapter.support.processing, SUPPORT.UNKNOWN);
});

/* ---------------------------------------------------------------- */
/* Cross-platform safety                                             */
/* ---------------------------------------------------------------- */

test('no adapter accepts an image when none is supplied', () => {
  assert.equal(evaluateImage(fakeImage(), null).eligible, false);
  assert.equal(evaluateImage(fakeImage(), null).reason, 'no-adapter');
  assert.equal(classifyImageUrl('https://files.oaiusercontent.com/x', null), CLASSIFICATION.INTERFACE);
});

test('malformed elements are handled without throwing, on every platform', () => {
  for (const adapter of [chatgptAdapter, geminiAdapter, grokAdapter]) {
    assert.equal(evaluateImage(null, adapter).eligible, false);
    assert.equal(evaluateImage({}, adapter).eligible, false);
    assert.equal(evaluateImage({ src: '' }, adapter).eligible, false);
  }
});

test('every adapter excludes avatars and tiny decorative images', () => {
  for (const adapter of [chatgptAdapter, geminiAdapter, grokAdapter]) {
    assert.equal(classifyImageUrl('https://example.com/avatar/me.png', adapter), CLASSIFICATION.INTERFACE,
      `${adapter.id} should exclude avatars`);
    assert.equal(classifyImageUrl('https://example.com/favicon.ico', adapter), CLASSIFICATION.INTERFACE,
      `${adapter.id} should exclude favicons`);
    assert.equal(classifyImageUrl('data:image/png;base64,AA', adapter), CLASSIFICATION.INTERFACE,
      `${adapter.id} should exclude inline data URLs`);
  }
});

test('every adapter has the fields the detector relies on', () => {
  for (const adapter of [chatgptAdapter, geminiAdapter, grokAdapter]) {
    assert.ok(adapter.id && adapter.name, 'needs an id and name');
    assert.ok(adapter.hosts.length > 0, `${adapter.id} needs hosts`);
    assert.ok(adapter.imageHosts.length > 0, `${adapter.id} needs image hosts`);
    assert.ok(adapter.conversationSelectors.length > 0, `${adapter.id} needs reply selectors`);
    assert.ok(adapter.interfaceAncestors.length > 0, `${adapter.id} needs interface exclusions`);
    assert.ok(Number.isFinite(adapter.minEdgePx), `${adapter.id} needs a size threshold`);
    assert.ok(adapter.support, `${adapter.id} needs a support status`);
  }
});
