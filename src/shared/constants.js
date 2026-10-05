/** Values shared across the extension. Kept in one place so nothing drifts. */

export const PRODUCT_NAME = 'CrediClean';

/** Sites the content script is allowed to run on. Mirrors manifest.json. */
export const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com'];

/**
 * Size limits. Processing is pure byte copying, so it is fast, but a very large
 * file still has to be held in memory two or three times over.
 */
export const SIZE_LIMITS = {
  /** Above this we warn the user before processing. */
  WARN_BYTES: 25 * 1024 * 1024,
  /** Above this we refuse, rather than risk hanging the tab. */
  MAX_BYTES: 64 * 1024 * 1024,
};

/** How long to wait for an image fetch before giving up. */
export const FETCH_TIMEOUT_MS = 30000;

export const STORAGE_KEY = 'crediclean.settings';

export const DEFAULT_SETTINGS = {
  /** Master switch. When false the content script adds nothing to the page. */
  enabled: true,
  /** Show the per-image action button. */
  showImageButtons: true,
  /**
   * Also remove an XMP packet when it carries a provenance reference to the
   * manifest being removed. See credential-processor.js for the trade-off.
   */
  removeXmpProvenanceReference: true,
};
