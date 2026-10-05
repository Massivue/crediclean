/**
 * The overlay layer that CrediClean draws its controls into.
 *
 * Two decisions worth explaining, because they are what keep this stable:
 *
 * 1. WE DO NOT INSERT ANYTHING INTO CHATGPT'S OWN ELEMENT TREE.
 *    ChatGPT is a React application. Anything we add inside its elements can be
 *    torn out the next time it re-renders that part of the page, and setting
 *    styles on its elements can break its layout. Instead we keep one container
 *    attached to <body> and position our controls over the images using page
 *    coordinates. ChatGPT's own DOM is left exactly as we found it.
 *
 * 2. EVERYTHING LIVES IN A SHADOW ROOT.
 *    A shadow root is a separate, sealed branch of the page. The page's CSS
 *    cannot reach inside it and our CSS cannot leak out. Without this, a
 *    ChatGPT stylesheet update could silently wreck our controls, or ours could
 *    affect their interface.
 */

const HOST_ID = 'crediclean-overlay-host';

export class Overlay {
  constructor() {
    this.host = null;
    this.root = null;
    this.layer = null;
    this.anchors = new Map(); // element -> {element, target, placement}
    this.frame = null;
    this.listening = false;
  }

  /** Create the host and shadow root. Safe to call more than once. */
  mount() {
    if (this.host && this.host.isConnected) return;

    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    // The host itself must never intercept clicks or affect layout.
    this.host.style.cssText = [
      'all: initial',
      'position: absolute',
      'top: 0',
      'left: 0',
      'width: 0',
      'height: 0',
      'pointer-events: none',
      'z-index: 2147483000',
    ].join(';');

    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = chrome.runtime.getURL('src/content/content.css');
    this.root.appendChild(style);

    this.layer = document.createElement('div');
    this.layer.className = 'cc-layer';
    this.root.appendChild(this.layer);

    document.body.appendChild(this.host);
    this.applyTheme();
    this.watchTheme();
    this.startListening();
  }

  /**
   * Choose light or dark by measuring the page's actual background colour.
   *
   * We deliberately do not use `prefers-color-scheme`: ChatGPT has its own
   * light/dark setting, so a user on a dark desktop can be reading a light
   * ChatGPT, and vice versa. Measuring the page is correct in both cases and
   * does not depend on any ChatGPT class name.
   */
  applyTheme() {
    if (!this.layer) return;
    this.layer.setAttribute('data-theme', detectPageTheme());
  }

  /** ChatGPT can switch theme without a reload, so watch for it. */
  watchTheme() {
    if (this.themeObserver) return;
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
  }

  unmount() {
    for (const anchor of this.anchors.values()) {
      if (anchor.resizeObserver) anchor.resizeObserver.disconnect();
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }
    this.stopListening();
    this.anchors.clear();
    if (this.host) this.host.remove();
    this.host = null;
    this.root = null;
    this.layer = null;
  }

  /** Add an element to the overlay, positioned relative to `target`. */
  add(element, target, placement = 'bottom-left') {
    this.mount();
    this.layer.appendChild(element);
    const anchor = { element, target, placement };
    this.anchors.set(element, anchor);

    /*
     * Watch the panel's own size.
     *
     * The panel is added before its content is built, and its height changes
     * again as the user moves from ready to working to saved. Position depends
     * on height: we cannot decide whether it fits below the image without
     * knowing how tall it is. Without this, the first placement is computed
     * from an empty panel and can leave the panel overlapping the composer.
     */
    if (placement === 'panel' && typeof ResizeObserver === 'function') {
      anchor.resizeObserver = new ResizeObserver(() => this.scheduleReposition());
      anchor.resizeObserver.observe(element);
    }

    this.reposition();
  }

  remove(element) {
    const anchor = this.anchors.get(element);
    if (anchor && anchor.resizeObserver) anchor.resizeObserver.disconnect();
    this.anchors.delete(element);
    if (element && element.parentNode) element.remove();
  }

  /** Drop anchors whose target image has left the page. */
  pruneDetached() {
    for (const [element, anchor] of this.anchors) {
      if (!anchor.target || !anchor.target.isConnected) this.remove(element);
    }
  }

  startListening() {
    if (this.listening) return;
    this.listening = true;
    this.onViewportChange = () => this.scheduleReposition();
    // A resize can move or reveal the composer, so the cached measurement for
    // every anchor has to go.
    this.onResize = () => {
      for (const anchor of this.anchors.values()) anchor.safeBottom = undefined;
      this.scheduleReposition();
    };
    // Capture phase with passive listeners: ChatGPT scrolls an inner container,
    // not the window, so we need to see scroll events from anywhere in the tree.
    window.addEventListener('scroll', this.onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  stopListening() {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('scroll', this.onViewportChange, { capture: true });
    window.removeEventListener('resize', this.onResize);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  scheduleReposition() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.reposition();
    });
  }

  /** Move every anchored element to sit over its target image. */
  /** Move every anchored element to sit over its target image. */
  reposition() {
    if (!this.layer) return;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    for (const [element, anchor] of this.anchors) {
      const target = anchor.target;
      if (!target || !target.isConnected) {
        this.remove(element);
        continue;
      }

      const rect = target.getBoundingClientRect();
      const isPanel = anchor.placement === 'panel';

      // Hide controls for images that are off screen or collapsed. This keeps
      // the overlay quiet in long conversations.
      //
      // An open panel is exempt. It is a dialog the user is reading, and a
      // small scroll can easily carry its image off screen. Making the panel
      // vanish mid-read would lose their place and their work, so it stays
      // visible and is kept inside the viewport instead.
      const offScreen =
        rect.bottom < -40 ||
        rect.top > viewportHeight + 40 ||
        rect.right < -40 ||
        rect.left > viewportWidth + 40 ||
        rect.width < 8 ||
        rect.height < 8;

      if (offScreen && !isPanel) {
        element.classList.add('cc-hidden');
        continue;
      }
      element.classList.remove('cc-hidden');

      if (isPanel) {
        this.positionPanel(element, rect, anchor);
        continue;
      }

      // Page coordinates, because the host is positioned absolutely at the
      // document origin rather than fixed to the viewport.
      const pageTop = rect.top + window.scrollY;
      const pageLeft = rect.left + window.scrollX;
      const inset = 10;

      let top;
      let left;
      switch (anchor.placement) {
        case 'top-left':
          top = pageTop + inset;
          left = pageLeft + inset;
          break;
        case 'bottom-right':
          top = pageTop + rect.height - inset;
          left = pageLeft + rect.width - inset;
          element.style.transform = 'translate(-100%, -100%)';
          break;
        case 'bottom-left':
        default:
          top = pageTop + rect.height - inset;
          left = pageLeft + inset;
          element.style.transform = 'translateY(-100%)';
          break;
      }

      element.style.top = `${Math.round(top)}px`;
      element.style.left = `${Math.round(Math.max(left, window.scrollX + 4))}px`;
    }
  }

  /**
   * Place the panel so the whole of it is always visible.
   *
   * The rules, in order:
   *   1. Prefer directly below the image, which is where the eye already is.
   *   2. If it would not fit there, flip it above the image.
   *   3. If it fits in neither, put it in whichever gap is larger and clamp.
   *   4. Clamp horizontally so it never runs off either edge.
   *
   * "Below" accounts for anything pinned to the bottom of the window, such as
   * ChatGPT's message composer, so the panel does not end up behind it.
   */
  positionPanel(element, rect, anchor) {
    const gap = 8;
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const height = element.offsetHeight || 0;
    const width = element.offsetWidth || 0;

    // The usable bottom edge: the window, or the top of whatever is pinned
    // there. Measured on open and on resize rather than every scroll frame.
    if (anchor.safeBottom === undefined) anchor.safeBottom = measureSafeBottom();
    const safeBottom = Math.min(anchor.safeBottom, viewportHeight) - margin;

    const spaceBelow = safeBottom - rect.bottom - gap;
    const spaceAbove = rect.top - margin - gap;

    let top;
    if (spaceBelow >= height) {
      top = rect.bottom + gap; // 1. below, the preferred position
    } else if (spaceAbove >= height) {
      top = rect.top - height - gap; // 2. above
    } else if (spaceBelow >= spaceAbove) {
      top = safeBottom - height; // 3. more room below, so sit on that edge
    } else {
      top = margin;
    }

    // 4. Never leave the viewport, whatever the arithmetic above produced.
    top = Math.max(margin, Math.min(top, Math.max(margin, safeBottom - height)));

    let left = rect.left;
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin));

    element.style.transform = '';
    element.style.top = `${Math.round(top + window.scrollY)}px`;
    element.style.left = `${Math.round(left + window.scrollX)}px`;
  }
}

/**
 * Work out whether the page is dark, by reading the first opaque background
 * colour up the tree from <body> and measuring its brightness.
 *
 * @returns {'light'|'dark'}
 */
export function detectPageTheme() {
  const candidates = [document.body, document.documentElement];
  for (const node of candidates) {
    if (!node) continue;
    const colour = getComputedStyle(node).backgroundColor;
    const parsed = parseRgb(colour);
    if (!parsed || parsed.alpha === 0) continue;
    // Rec. 601 luma, which is a good enough brightness measure here.
    const luma = (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
    return luma < 0.5 ? 'dark' : 'light';
  }
  // Nothing readable: fall back to the operating system preference.
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function parseRgb(value) {
  if (!value) return null;
  const match = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i);
  if (!match) return null;
  return {
    r: parseFloat(match[1]),
    g: parseFloat(match[2]),
    b: parseFloat(match[3]),
    alpha: match[4] === undefined ? 1 : parseFloat(match[4]),
  };
}

/**
 * Find the top edge of anything pinned to the bottom of the window, so the
 * panel can avoid sitting behind it. On ChatGPT this is the message composer.
 *
 * Rather than look for ChatGPT's own elements, which would be another brittle
 * selector to maintain, this asks the browser what is actually painted at the
 * bottom of the window and keeps anything that is pinned there and wide. That
 * works for any site and survives any redesign.
 *
 * @returns {number} a viewport y coordinate; the window height if nothing is pinned
 */
export function measureSafeBottom() {
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  let safeBottom = viewportHeight;

  if (typeof document.elementsFromPoint !== 'function') return safeBottom;

  // Probe a few x positions: a composer is usually centred, but need not be.
  for (const x of [viewportWidth / 2, viewportWidth / 3, (viewportWidth * 2) / 3]) {
    let found;
    try {
      found = document.elementsFromPoint(Math.round(x), viewportHeight - 8);
    } catch {
      continue;
    }
    for (const node of found) {
      const style = getComputedStyle(node);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;

      const box = node.getBoundingClientRect();
      // A bar across the bottom, not a small floating button...
      if (box.width < viewportWidth * 0.3) continue;
      // ...actually reaching the bottom...
      if (box.bottom < viewportHeight - 24) continue;
      // ...and not a full-window overlay, which would leave nowhere to go.
      if (box.top < viewportHeight * 0.4) continue;

      safeBottom = Math.min(safeBottom, box.top);
      break;
    }
  }
  return safeBottom;
}
