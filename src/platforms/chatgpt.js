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

/**
 * The pages of ChatGPT that are conversations.
 *
 * ChatGPT is one web app covering a chat, a GPT store, a settings area and
 * other sections, all swapped in without a page load. CrediClean belongs in
 * the conversation and nowhere else, so this is an ALLOW-LIST rather than a
 * list of places to avoid: a section OpenAI adds tomorrow is excluded by
 * default instead of silently inheriting the buttons.
 *
 * The trade-off is the other way round, and worth stating plainly: if OpenAI
 * changes how conversation addresses are written, the buttons stop appearing
 * until this list is updated. That is a visible, easily-reported failure,
 * where the opposite mistake is buttons showing up where they do not belong.
 *
 * Verified by hand on the live site. If you change these, re-test on
 * chatgpt.com before shipping.
 */
const CONVERSATION_PATHS = [
  /*
   * The start page. There is nothing to put a button on here, but a brand new
   * conversation is composed at "/" and the address only becomes /c/<id> once
   * the conversation exists. Excluding it risks missing the first generated
   * image of a chat, so it is allowed and the image rules do the real work.
   */
  /^\/$/,
  /** An ordinary conversation. */
  /^\/c\/[^/]+\/?$/,
  /** A conversation with a custom GPT. Note the /c/ segment: without it this
   *  is the GPT's own landing page, which is a store page, not a chat. */
  /^\/g\/[^/]+\/c\/[^/]+\/?$/,
  /** A shared conversation, opened from a link. */
  /^\/share\//,
];

/** Settings opens over whatever page you were on, and is not a conversation. */
const NON_CONVERSATION_HASHES = [/^#settings/i];

export function isChatgptConversationRoute({ pathname = '/', hash = '' } = {}) {
  if (NON_CONVERSATION_HASHES.some((pattern) => pattern.test(hash))) return false;
  return CONVERSATION_PATHS.some((pattern) => pattern.test(pathname));
}

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

  isSupportedRoute: isChatgptConversationRoute,

  support: {
    imageDetection: SUPPORT.VERIFIED,
    c2paDetection: SUPPORT.VERIFIED,
    processing: SUPPORT.VERIFIED,
  },
});
