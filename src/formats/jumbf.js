/**
 * Minimal JUMBF (ISO/IEC 19566-5) box-tree reader.
 *
 * A C2PA manifest store is a JUMBF superbox. Each box is:
 *   LBox (4 bytes, big-endian) | TBox (4 ASCII bytes) | payload
 * LBox counts the whole box including LBox and TBox. Two special values:
 *   LBox == 0  -> the box runs to the end of its parent
 *   LBox == 1  -> an 8-byte XLBox follows TBox and carries the real length
 *
 * A superbox ('jumb') begins with a description box ('jumd'):
 *   UUID (16 bytes) | toggles (1 byte) | [label, NUL-terminated, if toggles & 0x02]
 *
 * We walk this tree to report what a manifest contains. We deliberately do NOT
 * attempt cryptographic validation: that needs the signing certificate chain,
 * trust lists and CBOR claim parsing, which is far beyond an MVP. Everything
 * this module returns is structural description, not a validity judgement.
 */

/** The manifest store's UUID begins with these ASCII bytes. */
const C2PA_UUID_PREFIX = 'c2pa';

const TOGGLE_HAS_LABEL = 0x02;
const MAX_BOXES = 20000;
const MAX_DEPTH = 8;

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0
  );
}

function fourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Walk a JUMBF box tree.
 *
 * @param {Uint8Array} bytes buffer holding the box tree
 * @param {number} start offset of the first box
 * @param {number} end exclusive end offset
 * @returns {{boxes: Array<{type: string, label: string|null, offset: number,
 *   length: number, depth: number, children: Array}>, truncated: boolean}}
 */
export function parseJumbfBoxes(bytes, start = 0, end = bytes.length) {
  const state = { count: 0, truncated: false };
  const boxes = walk(bytes, start, end, 0, state);
  return { boxes, truncated: state.truncated };
}

function walk(bytes, start, end, depth, state) {
  const boxes = [];
  let offset = start;

  while (offset + 8 <= end) {
    if (state.count >= MAX_BOXES || depth > MAX_DEPTH) {
      state.truncated = true;
      break;
    }
    state.count += 1;

    let length = readUint32BE(bytes, offset);
    const type = fourCC(bytes, offset + 4);
    let headerLength = 8;

    if (length === 1) {
      // 64-bit extended length. We only support sizes a Number can index.
      if (offset + 16 > end) { state.truncated = true; break; }
      const high = readUint32BE(bytes, offset + 8);
      const low = readUint32BE(bytes, offset + 12);
      if (high !== 0) { state.truncated = true; break; }
      length = low;
      headerLength = 16;
    } else if (length === 0) {
      length = end - offset;
    }

    if (length < headerLength || offset + length > end) {
      state.truncated = true;
      break;
    }

    const box = {
      type,
      label: null,
      offset,
      length,
      depth,
      contentOffset: offset + headerLength,
      contentLength: length - headerLength,
      children: [],
    };

    if (type === 'jumd') {
      const described = readDescription(bytes, box.contentOffset, box.contentOffset + box.contentLength);
      box.label = described.label;
      box.uuidPrefix = described.uuidPrefix;
    } else if (type === 'jumb') {
      box.children = walk(bytes, box.contentOffset, box.contentOffset + box.contentLength, depth + 1, state);
      // A superbox takes its identity from its description box.
      const description = box.children.find((child) => child.type === 'jumd');
      if (description) {
        box.label = description.label;
        box.uuidPrefix = description.uuidPrefix;
      }
    }

    boxes.push(box);
    offset += length;
  }

  return boxes;
}

function readDescription(bytes, start, end) {
  if (start + 17 > end) return { label: null, uuidPrefix: null };
  const uuidPrefix = fourCC(bytes, start);
  const toggles = bytes[start + 16];
  if (!(toggles & TOGGLE_HAS_LABEL)) return { label: null, uuidPrefix };

  let label = '';
  for (let i = start + 17; i < end && i < start + 17 + 512; i += 1) {
    if (bytes[i] === 0) break;
    label += String.fromCharCode(bytes[i]);
  }
  // Labels are UTF-8; re-decode so non-ASCII labels are not mangled.
  try {
    const raw = Uint8Array.from(label, (char) => char.charCodeAt(0) & 0xff);
    label = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  } catch {
    /* keep the Latin-1 reading */
  }
  return { label: label || null, uuidPrefix };
}

/** Does this box tree look like a C2PA manifest store? */
export function looksLikeC2paStore(boxes) {
  return boxes.some(
    (box) => box.type === 'jumb' && (box.label === 'c2pa' || box.uuidPrefix === C2PA_UUID_PREFIX),
  );
}

/**
 * Summarise a manifest store for display: how many manifests it holds, and the
 * assertion labels inside them. Assertion labels are plain strings in the box
 * descriptions, so this needs no CBOR parsing and cannot be wrong about what it
 * reports (though it does not prove the manifest is valid or trustworthy).
 */
export function summariseC2paStore(boxes) {
  const store = boxes.find(
    (box) => box.type === 'jumb' && (box.label === 'c2pa' || box.uuidPrefix === C2PA_UUID_PREFIX),
  );
  if (!store) return { manifests: [], assertionLabels: [] };

  const manifests = [];
  const assertionLabels = new Set();

  for (const manifestBox of store.children) {
    if (manifestBox.type !== 'jumb') continue;
    const manifest = { label: manifestBox.label, assertions: [] };

    for (const section of manifestBox.children) {
      if (section.type !== 'jumb') continue;
      // Within a manifest, 'c2as' holds the assertion store and each child of
      // that is one assertion, labelled with its assertion type.
      if (section.label === 'c2pa.assertions' || section.uuidPrefix === 'c2as') {
        for (const assertion of section.children) {
          if (assertion.type === 'jumb' && assertion.label) {
            manifest.assertions.push(assertion.label);
            assertionLabels.add(assertion.label);
          }
        }
      }
    }
    manifests.push(manifest);
  }

  return { manifests, assertionLabels: [...assertionLabels] };
}
