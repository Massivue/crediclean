/**
 * Tests against REAL C2PA-signed images, rather than fixtures we built ourselves.
 *
 * Fixtures prove the code does what we think it does. Only real signed files
 * prove we understood the format correctly in the first place. These are the
 * tests that caught a genuine bug during development: a manifest split across
 * two JPEG APP11 segments was only being read as far as the first segment.
 *
 * The sample files are third-party test assets, so they are NOT committed to
 * this repository. Fetch them first:
 *
 *     npm run fetch-samples
 *
 * Without them, every test here is skipped rather than silently passing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectImage, STATUS } from '../src/processing/metadata-inspector.js';
import { removeCredentials, OUTCOME } from '../src/processing/credential-processor.js';

const SAMPLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'samples');

/** Each sample, with what we expect to find in it. */
const SAMPLES = [
  { file: 'CA.jpg', format: 'jpeg', credentials: true, splitAcrossSegments: true },
  { file: 'C.jpg', format: 'jpeg', credentials: true, splitAcrossSegments: false },
  { file: 'exp-test1.png', format: 'png', credentials: true, splitAcrossSegments: false },
  { file: 'libpng-test.png', format: 'png', credentials: false },
  { file: 'sample1.webp', format: 'webp', credentials: false },
];

function read(file) {
  const full = path.join(SAMPLE_DIR, file);
  if (!fs.existsSync(full)) return null;
  return new Uint8Array(fs.readFileSync(full));
}

const available = SAMPLES.filter((sample) => fs.existsSync(path.join(SAMPLE_DIR, sample.file)));

test('real sample files are present', { skip: available.length === 0 && 'run: npm run fetch-samples' }, () => {
  assert.ok(available.length > 0);
});

for (const sample of SAMPLES) {
  const skip = !fs.existsSync(path.join(SAMPLE_DIR, sample.file)) && `${sample.file} not downloaded`;

  test(`real sample ${sample.file}: inspected correctly`, { skip }, () => {
    const report = inspectImage(read(sample.file));
    assert.equal(report.format, sample.format);
    assert.equal(
      report.status,
      sample.credentials ? STATUS.CREDENTIALS_DETECTED : STATUS.NO_CREDENTIALS_DETECTED,
    );
    assert.ok(report.dimensions && report.dimensions.width > 0 && report.dimensions.height > 0);
    // Reading a real manifest must not produce "partly read" warnings.
    assert.deepEqual(report.warnings, [], `unexpected warnings: ${report.warnings.join('; ')}`);
  });

  if (sample.credentials) {
    test(`real sample ${sample.file}: credentials removed, losslessly and verifiably`, { skip }, () => {
      const original = read(sample.file);
      const snapshot = Buffer.from(original);
      const result = removeCredentials(original);

      assert.equal(result.outcome, OUTCOME.REMOVED);
      assert.equal(result.verification.ok, true);
      for (const check of result.verification.checks) {
        assert.equal(check.passed, true, `${check.name}: ${check.detail}`);
      }

      // The input buffer is untouched.
      assert.deepEqual(Buffer.from(original), snapshot);

      // A fresh inspection of the output finds nothing left.
      assert.equal(inspectImage(result.output).status, STATUS.NO_CREDENTIALS_DETECTED);

      // And the identifying byte sequences are genuinely gone from the file.
      const text = Buffer.from(result.output).toString('latin1');
      assert.ok(!text.includes('caBX'), 'a caBX chunk survived');
      assert.ok(!text.includes('jumb'), 'a JUMBF box survived');
    });

    test(`real sample ${sample.file}: reports a signer read from the file`, { skip }, () => {
      const report = inspectImage(read(sample.file));
      assert.ok(report.c2pa.claimGenerators.length > 0, 'should read at least one claim generator');
      assert.ok(report.c2pa.assertionLabels.length > 0, 'should read at least one assertion label');
      for (const label of report.c2pa.assertionLabels) {
        assert.match(label, /^[\w.\-:]+$/, `assertion label looks malformed: ${label}`);
      }
    });
  }

  if (sample.splitAcrossSegments) {
    test(`real sample ${sample.file}: multi-segment manifest fully removed`, { skip }, () => {
      const result = removeCredentials(read(sample.file));
      assert.equal(result.ok, true);
      assert.match(result.removed[0].location, /contiguous JPEG APP11 segments/);
      assert.ok(!Buffer.from(result.output).toString('latin1').includes('jumb'));
    });
  }
}
