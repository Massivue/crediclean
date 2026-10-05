/**
 * Finds the generated images on a supported AI platform.
 *
 * ============================================================================
 * THIS IS THE FRAGILE PART OF THE EXTENSION. IF CREDICLEAN STOPS SHOWING
 * BUTTONS AFTER A SITE UPDATE, THE FIX IS ALMOST CERTAINLY NOT HERE BUT IN
 * THAT PLATFORM'S ADAPTER IN src/platforms/. This file holds the shared
 * decision logic; each site's selectors and address rules live in its adapter.
 * ============================================================================
 *
 * These sites' page structures are not public APIs. They are generated markup
 * that can change without notice, and their CSS class names are compiled and
 * meaningless. So this module deliberately avoids matching class names.
 * Instead it layers three weaker but much more durable signals:
 *
 *   1. The image address. Generated images come from OpenAI's own file hosts,
 *      while avatars and interface icons come from static asset hosts.
 *   2. The rendered size. A generated image is large; avatars and icons are
 *      small.
 *   3. Where the image sits. We prefer images inside a message element, found
 *      through a list of fallback selectors, and ignore images inside obvious
 *      interface furniture such as buttons and navigation.
 *
 * Any one signal failing still leaves the others working.
 */

import {
  CLASSIFICATION,
  DEFAULT_MIN_EDGE_PX,
} from '../platforms/base.js';

export { CLASSIFICATION };

/**
 * The adapter in force for this page. Set once at start-up by the content
 * script; everything below reads its rules rather than hard-coding any one
 * site's structure.
 */
let activeAdapter = null;

export function setAdapter(adapter) {
  activeAdapter = adapter;
}

export function getAdapter() {
  return activeAdapter;
}

/** Minimum rendered edge, in CSS pixels, for an image to count as content. */
export const MIN_CONTENT_EDGE_PX = DEFAULT_MIN_EDGE_PX;

export const HANDLED_ATTRIBUTE = 'data-crediclean-handled';

/**
 * Judge an image address on its own, using the given platform's rules.
 *
 * Pure, so it is directly unit-testable for every platform without a browser.
 *
 * @param {string} url
 * @param {object} [adapter] defaults to the page's adapter
 * @returns {string} one of CLASSIFICATION.*
 */
export function classifyImageUrl(url, adapter = activeAdapter) {
  if (!url || typeof url !== 'string') return CLASSIFICATION.INTERFACE;
  if (!adapter) return CLASSIFICATION.INTERFACE;

  // Inline data URLs are icons and spinners in practice. A real generated image
  // is far too big to be inlined into the markup.
  if (url.startsWith('data:')) return CLASSIFICATION.INTERFACE;

  const lower = url.toLowerCase();
  for (const fragment of adapter.excludedUrlFragments) {
    if (lower.includes(fragment)) return CLASSIFICATION.INTERFACE;
  }
  for (const fragment of adapter.contentUrlFragments) {
    if (lower.includes(fragment)) return CLASSIFICATION.CONTENT;
  }
  // A blob: URL is content the page built in memory, which is how some images
  // are shown immediately after generation.
  if (lower.startsWith('blob:')) return CLASSIFICATION.CONTENT;

  return CLASSIFICATION.UNKNOWN;
}

/**
 * Has the image finished loading enough for us to work with it?
 * `naturalWidth` stays 0 until the bytes arrive, and is 0 forever if it failed.
 */
export function isImageLoaded(img) {
  return Boolean(img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
}

/**
 * How big is this image actually drawn on screen, in CSS pixels?
 *
 * Returns zeroes when the image is not laid out yet, which is a different
 * answer from "small" and is treated differently by the caller.
 *
 * @param {HTMLImageElement|object} img
 * @returns {{width: number, height: number}}
 */
export function renderedSize(img) {
  if (!img) return { width: 0, height: 0 };
  if (typeof img.getBoundingClientRect === 'function') {
    try {
      const rect = img.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        return { width: rect.width, height: rect.height };
      }
    } catch {
      // fall through to the layout properties below
    }
  }
  return { width: img.clientWidth || 0, height: img.clientHeight || 0 };
}

/**
 * Decide whether this image is a generated/content image worth offering an
 * action on.
 *
 * Only reads a small, stable set of element properties, so it can be tested
 * with a plain object stand-in rather than a full browser.
 *
 * @param {HTMLImageElement|object} img
 * @returns {{eligible: boolean, reason: string, url: string|null}}
 */
export function evaluateImage(img, adapter = activeAdapter) {
  if (!img) return { eligible: false, reason: 'no-element', url: null };
  if (!adapter) return { eligible: false, reason: 'no-adapter', url: null };

  const url = img.currentSrc || img.src || (img.getAttribute && img.getAttribute('src')) || null;
  if (!url) return { eligible: false, reason: 'no-source', url: null };

  const classification = classifyImageUrl(url, adapter);
  if (classification === CLASSIFICATION.INTERFACE) {
    return { eligible: false, reason: 'interface-image', url };
  }

  if (img.closest) {
    for (const selector of adapter.interfaceAncestors) {
      if (img.closest(selector)) return { eligible: false, reason: 'inside-interface', url };
    }
  }

  if (!isImageLoaded(img)) return { eligible: false, reason: 'not-loaded', url };

  // The file itself has to be big enough to be a picture rather than an icon.
  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  if (width < adapter.minEdgePx || height < adapter.minEdgePx) {
    return { eligible: false, reason: 'too-small', url };
  }

  /*
   * And it has to be DRAWN big enough.
   *
   * This second check is what keeps the button off a site's own interface
   * pictures. A custom GPT's icon on ChatGPT's store pages comes from the same
   * user-content host as a generated image and its source file is large, so
   * every other signal here says "content". The one thing that separates them
   * is that the icon is drawn at roughly 40px while a generated image fills
   * the message.
   *
   * A size of zero means "not laid out yet", not "tiny": that happens while a
   * page is still building, or inside a collapsed container. Such an image is
   * skipped for now rather than rejected, and the watcher reconsiders it on
   * the next pass, once it can be measured and in fact clicked.
   */
  const drawn = renderedSize(img);
  if (drawn.width <= 0 || drawn.height <= 0) {
    return { eligible: false, reason: 'not-rendered', url };
  }
  if (drawn.width < adapter.minRenderedEdgePx || drawn.height < adapter.minRenderedEdgePx) {
    return { eligible: false, reason: 'rendered-too-small', url };
  }

  // An unknown host is accepted only if it is inside a recognised reply
  // element. On sites where the generated-image host is not confirmed, this
  // structural check is what carries the decision, so it matters most there.
  if (classification === CLASSIFICATION.UNKNOWN) {
    const inReply =
      img.closest && adapter.conversationSelectors.some((selector) => {
        try {
          return img.closest(selector);
        } catch {
          return false; // a selector this browser cannot parse must not throw
        }
      });
    if (!inReply) return { eligible: false, reason: 'unknown-host-outside-message', url };
  }

  return { eligible: true, reason: classification, url };
}

/**
 * Collect every eligible image under `root`.
 *
 * @param {ParentNode} [root]
 * @returns {Array<{img: HTMLImageElement, url: string}>}
 */
export function findContentImages(root = document, adapter = activeAdapter) {
  const found = [];
  if (!adapter) return found;
  let images;
  try {
    images = root.querySelectorAll('img');
  } catch {
    return found;
  }
  for (const img of images) {
    const verdict = evaluateImage(img, adapter);
    if (verdict.eligible) found.push({ img, url: verdict.url });
  }
  return found;
}

/**
 * Watches the page and reports images as they appear.
 *
 * ChatGPT is a single-page app: messages stream in, conversations switch
 * without a page load, and long threads mount and unmount as you scroll. Rather
 * than trying to track each of those events, this debounces any DOM change into
 * a single rescan, which is cheap because the eligibility check is cheap and
 * already-handled images are skipped.
 */
export class ImageWatcher {
  /**
   * @param {(entries: Array<{img: HTMLImageElement, url: string}>) => void} onImages
   * @param {{debounceMs?: number}} [options]
   */
  constructor(onImages, options = {}) {
    this.onImages = onImages;
    this.debounceMs = options.debounceMs ?? 250;
    this.observer = null;
    this.timer = null;
    this.started = false;
    this.pendingLoadListeners = new WeakSet();
  }

  start() {
    if (this.started) return;
    this.started = true;

    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      // Watching every attribute would fire constantly. `src` is the one that
      // matters, since ChatGPT swaps it in when an image finishes generating.
      attributeFilter: ['src', 'srcset'],
    });

    // Coming back to a backgrounded tab can reveal images mounted meanwhile.
    this.visibilityHandler = () => {
      if (!document.hidden) this.scheduleScan();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);

    this.scan();
  }

  stop() {
    this.started = false;
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  scheduleScan() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan();
    }, this.debounceMs);
  }

  scan() {
    if (!this.started) return;

    // An image that has not loaded yet cannot be measured, so attach a one-shot
    // listener and reconsider it once the bytes arrive. Without this, an image
    // that streams in slowly would never get a button.
    for (const img of document.querySelectorAll('img')) {
      if (isImageLoaded(img) || this.pendingLoadListeners.has(img)) continue;
      const verdict = evaluateImage(img);
      if (verdict.reason !== 'not-loaded') continue;
      this.pendingLoadListeners.add(img);
      const rescan = () => this.scheduleScan();
      img.addEventListener('load', rescan, { once: true });
      // A failed image must not leave us waiting forever.
      img.addEventListener('error', rescan, { once: true });
    }

    /*
     * Always report, even when the answer is "none".
     *
     * This used to stay silent on an empty result, which looked harmless and
     * was the reason buttons survived a move to a page with no eligible
     * images: with nothing reported, nothing ever ran the cleanup that removes
     * buttons whose image has gone. The empty call is what prunes them.
     */
    this.onImages(findContentImages(document));
  }
}
