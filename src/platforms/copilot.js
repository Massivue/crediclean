/**
 * Microsoft Copilot.
 *
 * STATUS: implemented from research, NOT verified against the live site.
 *
 * What is documented by Microsoft: images created with Designer's features
 * inside Copilot carry Content Credentials based on the C2PA standard.
 *
 * Copilot image generation is reachable from several surfaces, which is why
 * more than one host is claimed here: copilot.microsoft.com, and the Bing and
 * Designer surfaces that share the same generation pipeline.
 *
 * What is NOT confirmed: the exact CDN host for generated images. Microsoft
 * does not document it. `th.bing.com` is Bing's long-standing image CDN and is
 * the most likely, but it is an inference, not a confirmed fact.
 */

import { defineAdapter, SUPPORT } from './base.js';

export const copilotAdapter = defineAdapter({
  id: 'copilot',
  name: 'Copilot',

  hosts: ['copilot.microsoft.com', 'designer.microsoft.com'],

  // NOT CONFIRMED beyond the page's own origin. Deliberately narrow: a blanket
  // microsoft.com or bing.com permission would grant far more reach than this
  // extension needs. th.bing.com is Bing's image CDN specifically.
  imageHosts: [
    'copilot.microsoft.com',
    'designer.microsoft.com',
    'th.bing.com',
    'bing.net',
  ],

  conversationSelectors: [
    '[data-content="ai-message"]',
    '[data-testid="message"]',
    '[role="log"]',
    '[role="main"]',
    'main',
  ],

  // th.bing.com serves Bing's generated and thumbnail imagery. Kept as a
  // positive hint rather than a requirement, since it is unconfirmed.
  contentUrlFragments: ['th.bing.com/th/id/', '/images/create/', 'designerapp'],

  extraExcludedFragments: ['r.bing.com', 'sb.scorecardresearch', 'c.bing.com'],

  support: {
    imageDetection: SUPPORT.UNVERIFIED,
    c2paDetection: SUPPORT.UNVERIFIED,
    processing: SUPPORT.UNVERIFIED,
  },
});
