/**
 * Grok (xAI).
 *
 * STATUS: image detection implemented from research and NOT verified.
 *         Credential support is genuinely UNKNOWN.
 *
 * This is the honest position, and it is deliberately different from the other
 * three. We could not establish whether Grok attaches C2PA Content Credentials
 * to generated images:
 *
 *   - xAI publishes no documentation saying that it does.
 *   - xAI is not on the C2PA steering committee, unlike OpenAI.
 *   - The sources that state confidently that Grok uses C2PA are watermark
 *     removal services, which sell a product that depends on the claim. They
 *     are not reliable evidence.
 *   - Grok applies a visible corner logo, which is not metadata and is not
 *     something this extension removes.
 *
 * So this adapter makes NO claim about credentials. It finds the image, hands
 * the bytes to the same engine every other platform uses, and reports
 * truthfully whatever that engine finds. If a Grok image carries no supported
 * credentials, the panel says "No supported credentials found" and offers
 * nothing to remove. That is the correct outcome, not a bug.
 *
 * If you confirm Grok's behaviour on a real file, update the support block
 * below and docs/FOUR_PLATFORM_SUPPORT.md together.
 */

import { defineAdapter, SUPPORT } from './base.js';

export const grokAdapter = defineAdapter({
  id: 'grok',
  name: 'Grok',

  // Grok is reachable at its own site and inside X.
  hosts: ['grok.com', 'x.com'],

  // NOT CONFIRMED. assets.grok.com is the expected asset host for grok.com;
  // pbs.twimg.com is X's media host, where a Grok image shown in an X timeline
  // would live. Narrowed to those rather than all of twimg.com, which also
  // serves profile pictures and interface assets.
  imageHosts: ['grok.com', 'assets.grok.com', 'x.com', 'pbs.twimg.com'],

  conversationSelectors: [
    '[data-testid="tweetPhoto"]',
    'article[data-testid="tweet"]',
    '[role="log"]',
    'main',
  ],

  contentUrlFragments: ['assets.grok.com', 'pbs.twimg.com/media/', '/imagine/'],

  // X is a general social network, so a lot of imagery on it is not generated
  // content. These keep the obvious interface assets out.
  extraExcludedFragments: [
    'abs.twimg.com',
    'profile_images',
    'profile_banners',
    'emoji/v2',
    'card_img',
  ],

  support: {
    imageDetection: SUPPORT.UNVERIFIED,
    // The important one. We do not know, so we do not claim.
    c2paDetection: SUPPORT.UNKNOWN,
    // The engine will run; whether it finds anything to process is unknown.
    processing: SUPPORT.UNKNOWN,
  },

  knownUnremovableProvenance: ['Visible corner logo (part of the picture, not metadata)'],

  /**
   * Upgrade an X media address to the full-size original.
   *
   * X serves resized variants of the same image through a `name` parameter:
   * `?format=jpg&name=small` and so on. The address in the page is usually a
   * resized one, so fetching it verbatim would hand the user a downscaled copy
   * and would say nothing useful about the original file's metadata.
   *
   * INFERENCE, not vendor-documented: this parameter's behaviour is well
   * established in practice but xAI and X do not document it. If it ever stops
   * working the fetch still succeeds, just on the resized variant, so the
   * failure mode is mild.
   *
   * @param {string} url
   * @returns {string[]} addresses to try, most preferred first
   */
  sourceUrlCandidates(url) {
    const candidates = [];
    try {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith('pbs.twimg.com') && parsed.searchParams.has('name')) {
        parsed.searchParams.set('name', 'orig');
        candidates.push(parsed.href);
      }
    } catch {
      /* fall through to the page's own address */
    }
    if (!candidates.includes(url)) candidates.push(url);
    return candidates;
  },
});
