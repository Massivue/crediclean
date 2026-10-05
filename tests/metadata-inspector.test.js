/** Inspection: what the extension reports about an image, and what it refuses to claim. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectImage, STATUS, readClaimGenerator } from '../src/processing/metadata-inspector.js';
import { FORMAT } from '../src/formats/detect.js';
import { buildPng, buildJpeg, buildWebp, buildC2paManifestStore, concat } from './fixtures.js';

test('a PNG carrying a manifest is reported as having credentials', () => {
  const report = inspectImage(buildPng({ c2pa: buildC2paManifestStore() }));
  assert.equal(report.status, STATUS.CREDENTIALS_DETECTED);
  assert.equal(report.c2pa.present, true);
  assert.equal(report.c2pa.locations[0].location, 'PNG caBX chunk');
  assert.ok(report.c2pa.locations[0].bytes > 0);
});

test('a PNG with no manifest is reported as having none', () => {
  const report = inspectImage(buildPng());
  assert.equal(report.status, STATUS.NO_CREDENTIALS_DETECTED);
  assert.equal(report.c2pa.present, false);
  assert.deepEqual(report.c2pa.locations, []);
});

test('manifest contents are read out of the file, not invented', () => {
  const store = buildC2paManifestStore({
    assertions: ['c2pa.actions', 'stds.schema-org.CreativeWork'],
    claimGenerator: 'OpenAI ChatGPT/2.0',
  });
  const report = inspectImage(buildPng({ c2pa: store }));

  assert.equal(report.c2pa.manifestCount, 1);
  assert.deepEqual(report.c2pa.assertionLabels.sort(), ['c2pa.actions', 'stds.schema-org.CreativeWork']);
  assert.deepEqual(report.c2pa.claimGenerators, ['OpenAI ChatGPT/2.0']);
});

test('a JPEG manifest in one APP11 segment is found', () => {
  const report = inspectImage(buildJpeg({ c2pa: buildC2paManifestStore() }));
  assert.equal(report.status, STATUS.CREDENTIALS_DETECTED);
  assert.equal(report.c2pa.locations[0].location, 'JPEG APP11 segment');
});

test('a JPEG manifest split across segments is reassembled and fully read', () => {
  const store = buildC2paManifestStore({
    assertions: ['c2pa.actions', 'c2pa.hash.data', 'c2pa.ingredient'],
    padding: 150000,
  });
  const report = inspectImage(buildJpeg({ c2pa: store, maxApp11Payload: 60000 }));

  assert.equal(report.status, STATUS.CREDENTIALS_DETECTED);
  assert.match(report.c2pa.locations[0].location, /contiguous JPEG APP11 segments/);
  assert.equal(report.c2pa.assertionLabels.length, 3);
  // Reassembly must be complete, so nothing is reported as partly read.
  assert.deepEqual(report.warnings, []);
});

test('a WebP manifest is found', () => {
  const report = inspectImage(buildWebp({ c2pa: buildC2paManifestStore() }));
  assert.equal(report.status, STATUS.CREDENTIALS_DETECTED);
  assert.equal(report.c2pa.locations[0].location, 'WebP C2PA chunk');
});

test('XMP is reported separately, and only flagged when it really links to a credential', () => {
  const linked = inspectImage(buildPng({ c2pa: buildC2paManifestStore(), xmp: 'provenance' }));
  const xmpLinked = linked.otherMetadata.find((entry) => entry.kind === 'xmp');
  assert.ok(xmpLinked);
  assert.equal(xmpLinked.hasProvenanceReference, true);

  const plain = inspectImage(buildPng({ xmp: 'plain' }));
  const xmpPlain = plain.otherMetadata.find((entry) => entry.kind === 'xmp');
  assert.ok(xmpPlain);
  assert.equal(xmpPlain.hasProvenanceReference, false);
});

test('an unsupported format is reported as unsupported, NOT as having no credentials', () => {
  const gif = concat([Uint8Array.from('GIF89a', (c) => c.charCodeAt(0)), new Uint8Array(64)]);
  const report = inspectImage(gif);
  assert.equal(report.status, STATUS.UNSUPPORTED_FORMAT);
  assert.notEqual(report.status, STATUS.NO_CREDENTIALS_DETECTED);
  assert.equal(report.format, FORMAT.GIF);
});

test('unreadable bytes are reported as unreadable, NOT as clean', () => {
  const report = inspectImage(new Uint8Array(200).fill(0x5a));
  assert.notEqual(report.status, STATUS.NO_CREDENTIALS_DETECTED);
  assert.equal(report.status, STATUS.UNSUPPORTED_FORMAT);
});

test('a corrupt file of a supported format is reported as unreadable, NOT as clean', () => {
  const bytes = buildPng();
  // Keep the PNG signature but destroy the chunk structure after it.
  bytes.fill(0xff, 8, 20);
  const report = inspectImage(bytes);
  assert.notEqual(report.status, STATUS.NO_CREDENTIALS_DETECTED);
  assert.equal(report.status, STATUS.UNREADABLE);
  assert.ok(report.structureError);
});

test('an empty file is handled without throwing', () => {
  const report = inspectImage(new Uint8Array(0));
  assert.equal(report.status, STATUS.UNREADABLE);
  assert.equal(report.byteLength, 0);
});

test('the inspector never mutates the image it is given', () => {
  const bytes = buildPng({ c2pa: buildC2paManifestStore(), xmp: 'provenance' });
  const copy = Buffer.from(bytes);
  inspectImage(bytes);
  assert.deepEqual(Buffer.from(bytes), copy);
});

test('claim generator decoding refuses to guess when the bytes do not match exactly', () => {
  // "claim_generator" present as plain text, but not as a CBOR key.
  const junk = Uint8Array.from('xxclaim_generatorxxnot-cbor', (c) => c.charCodeAt(0));
  assert.equal(readClaimGenerator(junk, 0, junk.length), null);
});

test('a provenance container that is not C2PA is reported as a warning, not as a credential', () => {
  // A JUMBF box with a non-C2PA uuid/label.
  const store = buildC2paManifestStore();
  // Overwrite the superbox label "c2pa" with something else, in both the UUID
  // prefix and the label, so it no longer identifies as a C2PA store.
  const text = Buffer.from(store);
  const first = text.indexOf('c2pa', 12);
  text.write('zzzz', first);
  const second = text.indexOf('c2pa', first + 4);
  if (second > 0) text.write('zzzz', second);

  const report = inspectImage(buildPng({ c2pa: new Uint8Array(text) }));
  assert.equal(report.c2pa.present, false);
  assert.equal(report.status, STATUS.NO_CREDENTIALS_DETECTED);
  assert.ok(report.warnings.length > 0, 'should warn that something unidentified was found');
  assert.match(report.warnings[0], /could not be identified/i);
});
