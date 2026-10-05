/**
 * Google Gemini.
 *
 * STATUS: implemented from research, NOT verified against the live site.
 *
 * What is documented by Google: images generated in the Gemini app carry C2PA
 * Content Credentials, and Google also applies SynthID, an invisible watermark
 * carried in the pixels.
 *
 * CrediClean removes the C2PA manifest. It does NOT touch SynthID and cannot.
 * A Gemini image processed here will still carry its SynthID watermark, and
 * that is expected behaviour, not a failure of the removal.
 *
 * What is NOT confirmed: the exact CDN host for generated images. No Google
 * documentation states it. The hosts below are the Google user-content domains
 * generated images are most likely to come from, and detection therefore leans
 * on page structure and image size rather than on the address.
 */

import { defineAdapter, SUPPORT } from './base.js';

export const geminiAdapter = defineAdapter({
  id: 'gemini',
  name: 'Gemini',

  hosts: ['gemini.google.com'],

  // NOT CONFIRMED. Generated images are expected on Google's user-content
  // domains. This one cannot be narrowed further with confidence: Google
  // spreads user content across lh3, lh4, lh5 and similar subdomains, so a
  // single subdomain would miss images. If retrieval fails, the console logs
  // the real host so this list can be corrected.
  imageHosts: ['gemini.google.com', 'googleusercontent.com', 'usercontent.google.com'],

  conversationSelectors: [
    'model-response',
    'message-content',
    '[data-test-id="model-response"]',
    '[role="log"]',
    'main',
  ],

  // Left deliberately narrow: the generated-image host is unconfirmed, so an
  // address allowlist would be a guess. Structure and size carry the decision.
  contentUrlFragments: [],

  // Google account profile pictures live under googleusercontent.com/a/, which
  // the shared exclusions already cover. These are Gemini's own interface assets.
  extraExcludedFragments: ['gstatic.com', 'www.google.com/images'],

  /**
   * Ask Google's image CDN for the ORIGINAL file rather than the derivative
   * shown on the page.
   *
   * THIS IS THE LIKELIEST REASON A GEMINI IMAGE REPORTS NO CREDENTIALS.
   *
   * Google serves images from googleusercontent.com through a resizing CDN.
   * The address in the page ends with an options string after an `=`, such as
   * `=w526-h296-rw`, which asks for a particular width, height and format.
   * What comes back is a **derivative**: the CDN re-encodes it on the fly, and
   * a re-encoded copy does not carry the original's C2PA manifest. Inspecting
   * it will always report no credentials, no matter how correct the engine is.
   *
   * Replacing the options with `=s0` asks for the original, at original
   * resolution and in its original format.
   *
   * INFERENCE, not vendor-documented: the `=s0` convention is well established
   * and widely corroborated, but Google does not publish it as an API. So this
   * returns candidates rather than a single address: if the rewritten one
   * fails, the loader falls back to the address from the page, and the user
   * still gets the behaviour they had before.
   *
   * @param {string} url
   * @returns {string[]} addresses to try, most preferred first
   */
  sourceUrlCandidates(url) {
    const candidates = [];
    try {
      const parsed = new URL(url);
      const isGoogleCdn =
        parsed.hostname.endsWith('googleusercontent.com') ||
        parsed.hostname.endsWith('usercontent.google.com');

      if (isGoogleCdn) {
        // The options string sits at the end of the PATH, after the last '='.
        const path = parsed.pathname;
        const marker = path.lastIndexOf('=');
        const options = marker === -1 ? null : path.slice(marker + 1);
        const looksLikeOptions = options !== null && /^[a-z0-9]+(-[a-z0-9]+)*$/i.test(options);

        const base = looksLikeOptions ? path.slice(0, marker) : path;

        /*
         * Two ways to ask Google's CDN for the real file:
         *   =s0  original resolution, original format
         *   =d   download the original
         * Both are conventions rather than documented API, so both are tried
         * and the page's own address is still kept as the fallback.
         */
        for (const suffix of ['=s0', '=d']) {
          const original = new URL(parsed.href);
          original.pathname = `${base}${suffix}`;
          candidates.push(original.href);
        }
      }
    } catch {
      /* fall through to the page's own address */
    }

    /*
     * Gemini's display images sit under an `/rd-gg/` path. "rd" most plausibly
     * means rendered, so the same identifier under `/gg/` may be the file that
     * was rendered from. A guess, and a cheap one: a wrong address simply
     * fails to load, and anything that does load still has to pass the
     * same-image check before it is used.
     */
    try {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/rd-gg/')) {
        const unrendered = new URL(parsed.href);
        unrendered.pathname = parsed.pathname.replace('/rd-gg/', '/gg/');
        if (!candidates.includes(unrendered.href)) candidates.push(unrendered.href);
      }
    } catch {
      /* ignore */
    }

    // Always keep the address from the page as the last resort.
    if (!candidates.includes(url)) candidates.push(url);
    return candidates;
  },

  /**
   * Find the ORIGINAL image address in the page, when the <img> only has a
   * blob: address.
   *
   * WHY THIS EXISTS. A real Gemini image was diagnosed on 5 October 2026. Its
   * <img> pointed at `blob:https://gemini.google.com/...`, and the bytes
   * behind that blob were a JPEG containing only JFIF, one quantisation
   * segment, a frame header and four Huffman tables. No EXIF, no XMP, no
   * APP11. That is the exact shape of an image a browser has just re-encoded,
   * and re-encoding destroys every piece of metadata.
   *
   * So the page builds a fresh copy of the picture and shows that. By the time
   * CrediClean sees it the credentials are already gone, and no amount of
   * rewriting the address can bring them back, because there is no address:
   * the bytes were manufactured in the page.
   *
   * The only way through is to find where the real file lives. Gemini offers a
   * download for generated images, so a link to the original is usually
   * somewhere near the image in the markup. This looks for one.
   *
   * HEURISTIC, and unverified against the real Gemini markup. It is written to
   * fail safely: if it finds nothing, or finds the wrong thing, the loader
   * falls back to the blob and behaviour is exactly as before.
   *
   * @param {HTMLImageElement} img
   * @returns {string[]} candidate addresses for the original
   */
  domSourceCandidates(img) {
    const found = [];
    const add = (value) => {
      if (typeof value !== 'string') return;
      const url = value.trim();
      if (!/^https:\/\//.test(url)) return;
      if (/googleusercontent\.com\/a\//.test(url)) return; // profile pictures
      if (!found.includes(url)) found.push(url);
    };

    const looksLikeImageHost = (url) =>
      /googleusercontent\.com|usercontent\.google\.com/.test(url);

    // Walk a bounded way up from the image, staying inside its own reply so we
    // cannot pick up a different image from elsewhere in the conversation.
    let node = img;
    for (let depth = 0; node && depth < 6; depth += 1) {
      // 1. A download link is the strongest signal: it points at the real file.
      for (const anchor of node.querySelectorAll ? node.querySelectorAll('a[href]') : []) {
        const href = anchor.getAttribute('href');
        if (anchor.hasAttribute('download') || looksLikeImageHost(href || '')) add(href);
      }

      // 2. A <picture> may carry the real address in a <source>.
      for (const source of node.querySelectorAll ? node.querySelectorAll('source[srcset]') : []) {
        add((source.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0]);
      }

      // 3. Any attribute anywhere holding an image-host address.
      for (const element of node.querySelectorAll ? node.querySelectorAll('*') : []) {
        for (const attribute of element.attributes || []) {
          if (looksLikeImageHost(attribute.value || '')) add(attribute.value);
        }
      }

      if (found.length > 0) break;
      node = node.parentElement;
    }

    // Prefer the original size for anything on Google's resizing CDN.
    const upgraded = [];
    for (const url of found) {
      for (const candidate of this.sourceUrlCandidates(url)) {
        if (!upgraded.includes(candidate)) upgraded.push(candidate);
      }
    }
    return upgraded;
  },

  /**
   * Watch what the page downloads.
   *
   * Gemini shows its generated images from blob: addresses and keeps no
   * address for the original anywhere in the markup, so neither rewriting the
   * address nor searching the DOM can reach the real file. Observing the
   * page's own image downloads is the only remaining route to it.
   *
   * Deliberately opt-in per platform. ChatGPT does not set this, and must not:
   * it works already, and the observer is the most intrusive code here.
   */
  observeNetworkSources: true,

  support: {
    imageDetection: SUPPORT.UNVERIFIED,
    // Documented by Google, but we have not inspected a real Gemini file.
    c2paDetection: SUPPORT.UNVERIFIED,
    processing: SUPPORT.UNVERIFIED,
  },

  /**
   * Shown nowhere in the UI. Recorded so the project never loses track of the
   * fact that removing C2PA here leaves a watermark behind.
   */
  knownUnremovableProvenance: ['SynthID (invisible pixel watermark)'],
});
