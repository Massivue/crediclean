/**
 * The Python in the skill must behave EXACTLY like the JavaScript engine.
 *
 * WHY THIS TEST IS THE IMPORTANT ONE
 *
 * The skill runs inside ChatGPT's sandbox, which is Python, so the credential
 * logic had to be written a second time. Two implementations of the same thing
 * is how quiet divergence starts: one gets a fix, the other does not, and the
 * one nobody runs locally is the one users get.
 *
 * So this does not test the Python against its own idea of correct. It runs
 * BOTH over the same bytes and requires the outputs to be identical, byte for
 * byte. The JavaScript side is the reference because it is the one verified
 * against real C2PA-signed files from the Content Authenticity Initiative,
 * with ImageMagick confirming zero differing pixels.
 *
 * If this ever fails, the Python is wrong until proven otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeCredentials, OUTCOME } from '../../../src/processing/credential-processor.js';
import { inspectImage, STATUS } from '../../../src/processing/metadata-inspector.js';
import {
  buildPng,
  buildJpeg,
  buildWebp,
  buildC2paManifestStore,
} from '../../../tests/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', '..', 'skill', 'scripts', 'crediclean.py');

/** Run the skill's Python on some bytes and read back what it did. */
function runPython(command, bytes, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crediclean-parity-'));
  const input = path.join(dir, 'image.bin');
  const output = path.join(dir, 'out.bin');
  fs.writeFileSync(input, Buffer.from(bytes));

  try {
    const args = command === 'remove'
      ? [SCRIPT, 'remove', input, output, ...extraArgs]
      : [SCRIPT, 'inspect', input, ...extraArgs];
    let stdout = '';
    let failed = false;
    try {
      stdout = execFileSync('python3', args, { encoding: 'utf8' });
    } catch (error) {
      // A refusal is a real answer, not a crash: it prints JSON and exits 1.
      failed = true;
      stdout = error.stdout || '';
    }
    const report = JSON.parse(stdout);
    const produced = command === 'remove' && !failed && fs.existsSync(output)
      ? new Uint8Array(fs.readFileSync(output))
      : null;
    return { report, output: produced };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* The same fixtures the JavaScript engine's own tests use. */
const CASES = [
  {
    name: 'PNG with a C2PA manifest and a provenance XMP packet',
    bytes: buildPng({
      width: 1536,
      height: 1024,
      c2pa: buildC2paManifestStore({ claimGenerator: 'OpenAI/DALL-E' }),
      xmp: 'provenance',
    }),
  },
  {
    name: 'PNG with a manifest but XMP that does NOT reference it',
    bytes: buildPng({ width: 800, height: 600, c2pa: buildC2paManifestStore(), xmp: 'plain' }),
  },
  {
    name: 'PNG with a manifest and no XMP at all',
    bytes: buildPng({ width: 64, height: 64, c2pa: buildC2paManifestStore() }),
  },
  {
    name: 'JPEG with a C2PA manifest and a provenance XMP packet',
    bytes: buildJpeg({
      width: 1024,
      height: 768,
      c2pa: buildC2paManifestStore({ claimGenerator: 'OpenAI/DALL-E' }),
      xmp: 'provenance',
    }),
  },
  {
    name: 'JPEG whose manifest is split across several APP11 segments',
    bytes: buildJpeg({
      width: 2048,
      height: 1536,
      // Large enough that it cannot fit in one 64 KiB segment, which is the
      // case that used to be read only as far as its first segment.
      c2pa: buildC2paManifestStore({ claimGenerator: 'Big/1.0', payloadBytes: 160_000 }),
      xmp: 'provenance',
    }),
  },
  {
    name: 'WebP with a C2PA manifest',
    bytes: buildWebp({ width: 640, height: 480, c2pa: buildC2paManifestStore(), xmp: 'provenance' }),
  },
];

for (const testCase of CASES) {
  test(`parity, removal: ${testCase.name}`, () => {
    const js = removeCredentials(testCase.bytes, { removeXmpProvenanceReference: true });
    const py = runPython('remove', testCase.bytes);

    assert.equal(js.ok, true, `the JavaScript reference refused: ${js.message}`);
    assert.equal(py.report.ok, true, `the Python refused: ${JSON.stringify(py.report)}`);

    assert.equal(
      py.output.length,
      js.output.length,
      `output lengths differ: python ${py.output.length}, javascript ${js.output.length}`,
    );
    assert.deepEqual(
      Buffer.from(py.output),
      Buffer.from(js.output),
      'the two implementations produced different bytes',
    );
  });

  test(`parity, inspection: ${testCase.name}`, () => {
    const js = inspectImage(testCase.bytes);
    const py = runPython('inspect', testCase.bytes).report;

    assert.equal(
      py.credentials_found,
      js.status === STATUS.CREDENTIALS_DETECTED,
      'the two disagree about whether credentials are present',
    );
    assert.equal(py.format, js.formatLabel, 'the two disagree about the format');
    if (js.dimensions) {
      assert.deepEqual(
        py.dimensions,
        { width: js.dimensions.width, height: js.dimensions.height },
        'the two disagree about the dimensions',
      );
    }
  });
}

test('parity: keeping XMP produces the same bytes in both', () => {
  const bytes = buildPng({
    width: 300,
    height: 200,
    c2pa: buildC2paManifestStore(),
    xmp: 'provenance',
  });
  const js = removeCredentials(bytes, { removeXmpProvenanceReference: false });
  const py = runPython('remove', bytes, ['--keep-xmp']);

  assert.equal(js.ok, true);
  assert.equal(py.report.ok, true, JSON.stringify(py.report));
  assert.deepEqual(Buffer.from(py.output), Buffer.from(js.output));
});

test('parity: an image with nothing to remove is refused by both', () => {
  const bytes = buildPng({ width: 400, height: 300 });
  const js = removeCredentials(bytes);
  const py = runPython('remove', bytes);

  assert.equal(js.outcome, OUTCOME.NOTHING_TO_REMOVE);
  assert.equal(py.report.ok, false);
  assert.equal(py.report.reason, 'nothing-to-remove');
  assert.equal(py.output, null, 'the Python must not write a file when there is nothing to do');
});

test('parity: an unsupported format is refused by both', () => {
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
  const js = removeCredentials(gif);
  const py = runPython('remove', gif);

  assert.equal(js.outcome, OUTCOME.UNSUPPORTED_FORMAT);
  assert.equal(py.report.ok, false);
  assert.equal(py.report.reason, 'unsupported-format');
});

test('parity: rubbish is refused by both rather than crashing', () => {
  const junk = new Uint8Array(200).fill(0x41);
  const js = removeCredentials(junk);
  const py = runPython('remove', junk);

  assert.equal(js.ok, false);
  assert.equal(py.report.ok, false);
});

test('the skill makes no network access, which the privacy policy promises', () => {
  /*
   * PRIVACY.md states the skill sends nothing anywhere and makes no network
   * requests. That is only true while this stays true, so it is asserted
   * rather than trusted: a stray `import urllib` would quietly turn a
   * published privacy promise into a false one.
   */
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const imported = new Set();
  for (const match of source.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)) {
    imported.add(match[1].split('.')[0]);
  }
  assert.deepEqual(
    [...imported].sort(),
    ['json', 'sys'],
    'the skill imported something new; if it can reach the network, PRIVACY.md is now false',
  );

  // And no network calls smuggled in without an import.
  for (const banned of ['urlopen', 'socket.', 'requests.', 'http.client', 'subprocess']) {
    assert.ok(!source.includes(banned), `the skill used ${banned}`);
  }
});

test('the Python never claims an image is untraceable', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  /*
   * The word is allowed where the script says it does NOT make an image
   * untraceable. What must never appear is the claim, so find each use and
   * require a negation close in front of it.
   */
  const unnegated = [];
  for (const match of source.matchAll(/untraceable|undetectable/gi)) {
    const before = source.slice(Math.max(0, match.index - 60), match.index);
    if (!/\b(not|never|NOT)\b/.test(before)) unnegated.push(match[0]);
  }
  assert.deepEqual(unnegated, [], 'an unqualified claim about traceability appeared');
  assert.match(source, /SynthID/, 'the watermark limit must be stated, not left implied');
});
