/**
 * Shared ground rules for every platform adapter.
 *
 * An adapter's job is narrow: say which images on this site are generated
 * content, and where the original file lives. It must contain no credential
 * parsing at all. Everything after "here are the bytes" is the same code for
 * every platform, which is what stops four slightly different and slightly
 * wrong C2PA implementations existing.
 */

/** Support status values. These are internal; users never see them. */
export const SUPPORT = {
  /** Verified working against the live site. */
  VERIFIED: 'verified',
  /** Written from research and tested against a reconstruction, not the live site. */
  UNVERIFIED: 'implemented-unverified',
  /** We genuinely do not know. Never presented to the user as support. */
  UNKNOWN: 'unknown',
  /** Known not to work. */
  UNSUPPORTED: 'not-supported',
};

/**
 * Elements an image must not be inside to count as content, on any site.
 * These are roles and tag names rather than class names, so they survive
 * redesigns.
 */
export const DEFAULT_INTERFACE_ANCESTORS = [
  'button',
  '[role="button"]',
  'nav',
  'header',
  'aside',
  '[role="navigation"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="toolbar"]',
  '[role="tablist"]',
];

/**
 * Address fragments that mean "interface furniture" anywhere.
 *
 * Note `googleusercontent.com/a/`: that path prefix is Google account profile
 * pictures specifically. It is deliberately narrow, because Gemini may serve
 * real generated images from other paths on the same domain, and excluding the
 * whole domain would break Gemini.
 */
export const DEFAULT_EXCLUDED_FRAGMENTS = [
  'gravatar.com',
  'googleusercontent.com/a/',
  '/avatar',
  'avatar.',
  '/favicon',
  'favicon.',
  '/logo',
  'logo.',
  '/icon',
  'icon.',
  'sprite',
  'placeholder',
  'emoji',
];

/** Minimum rendered edge, in CSS pixels, for an image to count as content. */
export const DEFAULT_MIN_EDGE_PX = 96;

export const CLASSIFICATION = {
  CONTENT: 'content',
  INTERFACE: 'interface',
  UNKNOWN: 'unknown',
};

/**
 * Build an adapter, filling in the shared defaults.
 *
 * @param {object} config
 * @param {string} config.id stable identifier
 * @param {string} config.name human name, used in logs only
 * @param {string[]} config.hosts hostnames the adapter claims
 * @param {string[]} config.imageHosts hosts the original file may be fetched from
 * @param {string[]} config.conversationSelectors containers that hold replies
 * @param {string[]} [config.contentUrlFragments] addresses that positively mean content
 * @param {string[]} [config.excludedUrlFragments] extra exclusions for this site
 * @param {object} config.support internal support status
 * @returns {object} the adapter
 */
export function defineAdapter(config) {
  return {
    contentUrlFragments: [],
    extraExcludedFragments: [],
    minEdgePx: DEFAULT_MIN_EDGE_PX,
    ...config,
    interfaceAncestors: config.interfaceAncestors || DEFAULT_INTERFACE_ANCESTORS,
    excludedUrlFragments: [
      ...DEFAULT_EXCLUDED_FRAGMENTS,
      ...(config.extraExcludedFragments || []),
    ],
  };
}

/**
 * Does `hostname` belong to this adapter? Matches the host itself and any
 * subdomain of it.
 */
export function hostMatches(hostname, hosts) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  return hosts.some((host) => lower === host || lower.endsWith(`.${host}`));
}
