/**
 * Notices when a single-page app moves between pages without a page load.
 *
 * WHY THIS IS NOT JUST A pushState PATCH, WHICH IS THE OBVIOUS ANSWER
 *
 * The usual recipe for this is to wrap `history.pushState` and
 * `history.replaceState` and watch them being called. That does not work from
 * a content script, and failing quietly is the worst way to find out.
 *
 * A content script runs in what Chrome calls an isolated world: it shares the
 * page's DOM but has its own JavaScript context, with its own wrappers around
 * objects like `history`. Overwriting `history.pushState` here replaces OUR
 * copy. The page keeps calling its own, and we are never told. The patch looks
 * correct in review, runs without error, and catches nothing.
 *
 * So this watches the things that do cross the boundary:
 *
 *   1. `popstate` and `hashchange`, which are real events on the shared window
 *      and are delivered to both worlds.
 *   2. The Navigation API's `navigate` event, where the browser has it. This
 *      covers same-document navigations that fire no popstate.
 *   3. A poll of `location.href`. Unglamorous, but it is the only mechanism
 *      that cannot be bypassed, and comparing two strings a few times a second
 *      costs nothing measurable.
 *
 * The poll is the guarantee. The events exist so the common case feels
 * instant rather than waiting up to one interval.
 */

export class RouteWatcher {
  /**
   * @param {(url: string) => void} onChange called with the new href
   * @param {{pollMs?: number}} [options]
   */
  constructor(onChange, options = {}) {
    this.onChange = onChange;
    this.pollMs = options.pollMs ?? 250;
    this.current = currentHref();
    this.timer = null;
    this.started = false;
    this.listeners = [];
    this.navigationHandler = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.current = currentHref();

    const check = () => this.check();

    for (const type of ['popstate', 'hashchange']) {
      window.addEventListener(type, check);
      this.listeners.push([type, check]);
    }

    /*
     * The Navigation API, where it exists. Guarded because it is not in every
     * browser this extension can run in, and because we must never be the
     * reason a page breaks: a failure to subscribe just leaves the poll doing
     * the work.
     */
    try {
      if (typeof navigation !== 'undefined' && typeof navigation.addEventListener === 'function') {
        // Deferred to a microtask: the event fires as navigation starts, so
        // reading location immediately can still give the old address.
        this.navigationHandler = () => Promise.resolve().then(check);
        navigation.addEventListener('navigate', this.navigationHandler);
      }
    } catch {
      this.navigationHandler = null;
    }

    this.timer = setInterval(check, this.pollMs);
  }

  stop() {
    this.started = false;
    for (const [type, handler] of this.listeners) window.removeEventListener(type, handler);
    this.listeners = [];
    if (this.navigationHandler) {
      try {
        navigation.removeEventListener('navigate', this.navigationHandler);
      } catch {
        // The page is going away; nothing useful to do.
      }
      this.navigationHandler = null;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Compare and report. Safe to call as often as you like. */
  check() {
    if (!this.started) return;
    const href = currentHref();
    if (href === this.current) return;
    this.current = href;
    try {
      this.onChange(href);
    } catch (error) {
      console.warn('[CrediClean] Route change handler failed.', error);
    }
  }
}

function currentHref() {
  return typeof location === 'undefined' ? '' : location.href;
}

/**
 * Should the extension be mounted on this page?
 *
 * Kept separate from the watcher, and pure, so every adapter's rules can be
 * unit-tested without a browser.
 *
 * @param {object} adapter
 * @param {{pathname?: string, hash?: string}} [route] defaults to this page
 * @returns {boolean}
 */
export function routeIsSupported(adapter, route) {
  if (!adapter) return false;
  if (typeof adapter.isSupportedRoute !== 'function') return true;
  const where = route || (typeof location === 'undefined' ? {} : location);
  try {
    return Boolean(adapter.isSupportedRoute({
      pathname: where.pathname || '/',
      hash: where.hash || '',
    }));
  } catch (error) {
    /*
     * A broken rule must not take the extension down with it. Staying mounted
     * is the safer failure: the image rules still decide what gets a button,
     * so the worst case is the old behaviour rather than a dead extension.
     */
    console.warn('[CrediClean] Route rule failed; staying active.', error);
    return true;
  }
}
