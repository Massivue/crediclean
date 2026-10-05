/**
 * The file layer: reading what ChatGPT sends, refusing what we should not
 * fetch, and holding a processed file for the shortest sensible time.
 *
 * The SSRF guard tests matter most. This server is a public endpoint that
 * fetches a URL someone else supplies, which is the classic shape of a
 * server-side request forgery hole. A guard nobody tests is a guard nobody
 * should trust.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ImageError,
  clearHeldFiles,
  heldFileCount,
  holdProcessedFile,
  isAllowedDownloadUrl,
  readFileParam,
  takeProcessedFile,
} from '../../src/files.js';

const ALLOWED = ['files.oaiusercontent.com', 'oaiusercontent.com'];

/* ------------------------------------------------------------------ */
/* Reading the file argument                                           */
/* ------------------------------------------------------------------ */

test('a proper file reference is read, snake_case as ChatGPT sends it', () => {
  const file = readFileParam({
    download_url: 'https://files.oaiusercontent.com/file-abc',
    file_id: 'file-abc',
    mime_type: 'image/png',
    file_name: 'picture.png',
  });
  assert.equal(file.downloadUrl, 'https://files.oaiusercontent.com/file-abc');
  assert.equal(file.fileId, 'file-abc');
  assert.equal(file.mimeType, 'image/png');
  assert.equal(file.fileName, 'picture.png');
});

test('camelCase is accepted too, so a rename cannot silently break us', () => {
  const file = readFileParam({ downloadUrl: 'https://files.oaiusercontent.com/x', fileName: 'a.png' });
  assert.equal(file.downloadUrl, 'https://files.oaiusercontent.com/x');
  assert.equal(file.fileName, 'a.png');
});

test('a bare /mnt/data path gets its own clear error, not a crash', () => {
  /*
   * This is THE failure mode the research flagged: when fileParams does not
   * resolve, ChatGPT passes the sandbox path as a plain string. It must be
   * recognised and explained, because it means the platform did not hand over
   * the file, not that the image is bad.
   */
  assert.throws(
    () => readFileParam('/mnt/data/image.png'),
    (error) => error instanceof ImageError && error.code === 'file-param-not-resolved',
  );
});

test('an object with no download address is refused with a reason', () => {
  assert.throws(
    () => readFileParam({ file_id: 'file-abc' }),
    (error) => error instanceof ImageError && error.code === 'no-download-url',
  );
});

test('nothing at all is refused', () => {
  for (const value of [null, undefined, 42]) {
    assert.throws(() => readFileParam(value), (error) => error instanceof ImageError);
  }
});

/* ------------------------------------------------------------------ */
/* The SSRF guard                                                      */
/* ------------------------------------------------------------------ */

test('an allowed OpenAI host passes', () => {
  assert.equal(isAllowedDownloadUrl('https://files.oaiusercontent.com/file-abc', ALLOWED).ok, true);
});

test('a subdomain of an allowed host passes', () => {
  assert.equal(isAllowedDownloadUrl('https://cdn.oaiusercontent.com/f', ALLOWED).ok, true);
});

test('a lookalike host does NOT pass', () => {
  // The check must be host equality or a dotted suffix, never "contains".
  for (const url of [
    'https://files.oaiusercontent.com.evil.test/f',
    'https://notoaiusercontent.com/f',
    'https://evil.test/?x=files.oaiusercontent.com',
  ]) {
    const verdict = isAllowedDownloadUrl(url, ALLOWED);
    assert.equal(verdict.ok, false, url);
    assert.equal(verdict.reason, 'host-not-allowed', url);
  }
});

test('internal and cloud-metadata addresses are refused', () => {
  /*
   * The reason the allowlist exists. Each of these, fetched by a server, hands
   * an attacker something: cloud credentials, an internal service, a local
   * file.
   */
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'https://169.254.169.254/latest/meta-data/',
    'http://localhost:8787/files/anything',
    'https://127.0.0.1/admin',
    'http://[::1]/admin',
    'https://10.0.0.5/internal',
    'https://metadata.google.internal/computeMetadata/v1/',
  ]) {
    assert.equal(isAllowedDownloadUrl(url, ALLOWED).ok, false, url);
  }
});

test('non-https schemes are refused, including file: and data:', () => {
  for (const url of [
    'http://files.oaiusercontent.com/f',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'ftp://files.oaiusercontent.com/f',
    'gopher://files.oaiusercontent.com/f',
  ]) {
    assert.equal(isAllowedDownloadUrl(url, ALLOWED).ok, false, url);
  }
});

test('something that is not a URL at all is refused', () => {
  const verdict = isAllowedDownloadUrl('/mnt/data/image.png', ALLOWED);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not-a-url');
});

/* ------------------------------------------------------------------ */
/* Holding a processed file                                            */
/* ------------------------------------------------------------------ */

test('a held file can be fetched back, intact', () => {
  clearHeldFiles();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const stored = holdProcessedFile(bytes, { filename: 'clean.png', contentType: 'image/png' });

  assert.match(stored.url, /\/files\/[A-Za-z0-9_-]+$/);
  assert.ok(stored.expiresAt > Date.now(), 'it should expire in the future');

  const got = takeProcessedFile(stored.token);
  assert.deepEqual([...got.bytes], [1, 2, 3, 4, 5]);
  assert.equal(got.filename, 'clean.png');
  assert.equal(got.contentType, 'image/png');
});

test('tokens are long and unguessable, and never repeat', () => {
  clearHeldFiles();
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { token } = holdProcessedFile(new Uint8Array([i]), {
      filename: 'a.png',
      contentType: 'image/png',
    });
    assert.ok(token.length >= 32, `token too short: ${token.length}`);
    assert.equal(seen.has(token), false, 'a token repeated');
    seen.add(token);
  }
});

test('an unknown token returns nothing rather than throwing', () => {
  clearHeldFiles();
  assert.equal(takeProcessedFile('not-a-real-token'), null);
});

test('the number of held files is capped, so a burst cannot fill memory', () => {
  clearHeldFiles();
  for (let i = 0; i < 260; i += 1) {
    holdProcessedFile(new Uint8Array([i & 0xff]), { filename: 'a.png', contentType: 'image/png' });
  }
  assert.ok(heldFileCount() <= 200, `held ${heldFileCount()}, expected the cap to hold`);
  clearHeldFiles();
});
