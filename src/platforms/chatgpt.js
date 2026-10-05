/**
 * ChatGPT (OpenAI).
 *
 * STATUS: verified against the live site. The button appears on generated
 * images, credentials are detected, and removal and download work.
 *
 * Do not change these rules without re-testing on chatgpt.com. They are the
 * only set in this file that has been confirmed on a real page.
 */

import { defineAdapter, SUPPORT } from './base.js';

export const chatgptAdapter = defineAdapter({
  id: 'chatgpt',
  name: 'ChatGPT',

  hosts: ['chatgpt.com', 'chat.openai.com'],

  // Confirmed: ChatGPT serves generated image files from this domain.
  imageHosts: ['chatgpt.com', 'chat.openai.com', 'oaiusercontent.com'],

  // `data-message-author-role` and `data-testid` are semantic attributes rather
  // than styling, so they are the most likely to survive a redesign.
  conversationSelectors: [
    '[data-message-author-role]',
    '[data-testid^="conversation-turn"]',
    '[role="log"]',
    'main',
  ],

  contentUrlFragments: [
    'oaiusercontent.com',
    '/backend-api/estuary/content',
    '/backend-api/files/',
    '/backend-api/content',
  ],

  extraExcludedFragments: ['oaistatic.com', 'cdn.openai.com'],

  support: {
    imageDetection: SUPPORT.VERIFIED,
    c2paDetection: SUPPORT.VERIFIED,
    processing: SUPPORT.VERIFIED,
  },
});
