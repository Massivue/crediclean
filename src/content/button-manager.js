/**
 * Builds and manages CrediClean's on-page controls: the small button that sits
 * on each generated image, and the panel that opens when it is used.
 *
 * SECURITY NOTE: strings such as the claim generator and the assertion labels
 * are read out of the image file, which means they are untrusted input. Every
 * one of them is written with `textContent`, never `innerHTML`, so a crafted
 * image cannot inject markup or script into the page.
 */

import { STATUS } from '../processing/metadata-inspector.js';
import { PRODUCT_NAME } from '../shared/constants.js';
import { HANDLED_ATTRIBUTE } from './image-detector.js';

/**
 * One short line per outcome. Deliberately plain: the panel is a consumer
 * tool, not a credential inspector, so it states what was found and nothing
 * about how the underlying standard works.
 */
const STATUS_TEXT = {
  [STATUS.CREDENTIALS_DETECTED]: { title: 'Content Credentials found', tone: 'found' },
  [STATUS.NO_CREDENTIALS_DETECTED]: { title: 'No supported credentials found', tone: 'clear' },
  [STATUS.UNSUPPORTED_FORMAT]: { title: 'This image format is not supported', tone: 'warn' },
  [STATUS.UNREADABLE]: { title: "Couldn't read this image", tone: 'warn' },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export class ButtonManager {
  /**
   * @param {object} args
   * @param {import('./overlay.js').Overlay} args.overlay
   * @param {(entry: {img: HTMLImageElement, url: string}, ui: object) => void} args.onInspect
   */
  constructor({ overlay, onInspect }) {
    this.overlay = overlay;
    this.onInspect = onInspect;
    this.badges = new Map(); // img -> badge element
    this.openPanel = null;
  }

  /** Give every entry a button, skipping any that already has a live one. */
  attach(entries) {
    for (const entry of entries) {
      const existing = this.badges.get(entry.img);
      if (existing && existing.isConnected) continue;
      if (existing) this.badges.delete(entry.img);
      this.createBadge(entry);
    }
    this.overlay.pruneDetached();
    this.cleanupStaleBadges();
  }

  cleanupStaleBadges() {
    for (const [img, badge] of this.badges) {
      if (!img.isConnected) {
        this.overlay.remove(badge);
        this.badges.delete(img);
      }
    }
  }

  detachAll() {
    for (const [img, badge] of this.badges) {
      this.overlay.remove(badge);
      if (img.removeAttribute) img.removeAttribute(HANDLED_ATTRIBUTE);
    }
    this.badges.clear();
    this.closePanel();
  }

  createBadge(entry) {
    const badge = element('button', 'cc-badge');
    badge.type = 'button';
    badge.setAttribute('aria-label', `Inspect image credentials with ${PRODUCT_NAME}`);
    badge.title = `${PRODUCT_NAME}: inspect this image's Content Credentials`;

    const mark = element('span', 'cc-badge__mark', 'CC');
    mark.setAttribute('aria-hidden', 'true');
    const label = element('span', 'cc-badge__label', 'Inspect credentials');
    const spinner = element('span', 'cc-badge__spinner');
    spinner.setAttribute('aria-hidden', 'true');

    badge.append(mark, label, spinner);

    badge.addEventListener('click', (event) => {
      // Stop the click reaching ChatGPT, which would open its image viewer.
      event.preventDefault();
      event.stopPropagation();
      this.handleBadgeClick(entry, badge, label);
    });

    entry.img.setAttribute(HANDLED_ATTRIBUTE, 'true');
    this.badges.set(entry.img, badge);
    this.overlay.add(badge, entry.img, 'bottom-left');
  }

  handleBadgeClick(entry, badge, label) {
    if (badge.dataset.busy === 'true') return;

    const ui = {
      setBusy: (busy, text) => {
        badge.dataset.busy = busy ? 'true' : 'false';
        badge.classList.toggle('cc-badge--busy', busy);
        badge.setAttribute('aria-busy', busy ? 'true' : 'false');
        label.textContent = text || (busy ? 'Working...' : 'Inspect credentials');
      },
      showPanel: (build) => this.showPanel(entry, build),
      closePanel: () => this.closePanel(),
    };

    this.onInspect(entry, ui);
  }

  showPanel(entry, build) {
    this.closePanel();

    const panel = element('div', 'cc-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${PRODUCT_NAME} credential report`);
    panel.tabIndex = -1;

    const header = element('div', 'cc-panel__header');
    const brand = element('div', 'cc-panel__brand');
    brand.append(element('span', 'cc-panel__mark', 'CC'), element('span', null, PRODUCT_NAME));
    const close = element('button', 'cc-panel__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closePanel();
    });
    header.append(brand, close);

    const body = element('div', 'cc-panel__body');
    panel.append(header, body);

    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.closePanel();
      }
    });

    this.openPanel = { panel, img: entry.img, body };
    this.overlay.add(panel, entry.img, 'panel');
    build(body, { close: () => this.closePanel() });
    // Position again now the content exists, so the first paint is already in
    // the right place rather than visibly jumping once the observer fires.
    this.overlay.reposition();
    panel.focus({ preventScroll: true });

    // Clicking anywhere else closes the panel. Clicks that originate inside
    // our own overlay are retargeted by the shadow boundary to the host
    // element, so they are identified and ignored here rather than relying
    // only on stopPropagation further down.
    const handler = (event) => {
      if (event.target === this.overlay.host) return;
      this.closePanel();
    };
    this.outsideClickHandler = handler;
    // Deferred by a tick so the click that opened this panel does not
    // immediately close it again. The handler is captured in a local so a
    // panel closed before the tick cannot register a later panel's handler.
    setTimeout(() => {
      if (this.outsideClickHandler === handler) document.addEventListener('click', handler);
    }, 0);

    return this.openPanel;
  }

  closePanel() {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    if (this.openPanel) {
      this.overlay.remove(this.openPanel.panel);
      this.openPanel = null;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Panel content                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Render the whole panel body for a given state.
 *
 * There is one renderer rather than several, so every phase of the flow shares
 * exactly the same layout and the panel never jumps around as the user moves
 * through it. The caller re-invokes this with a new `phase` instead of patching
 * individual nodes.
 *
 * @param {HTMLElement} body the panel body element
 * @param {object} state
 * @param {object} state.report the inspection report
 * @param {string} state.filename the image's own filename, for display
 * @param {'ready'|'working'|'saved'|'error'} state.phase
 * @param {string} [state.message] error text, used only in the error phase
 * @param {() => void} [state.onRemove]
 * @param {() => void} [state.onClose]
 */
export function renderPanel(body, state) {
  const { report, filename, phase } = state;
  body.replaceChildren();

  if (phase === 'error') {
    body.append(statusLine('warn', "Couldn't process this image"));
    body.append(element('p', 'cc-hint', state.message || 'Please try again.'));
    body.append(singleButton('Close', state.onClose, 'cc-button'));
    return;
  }

  const canRemove = report.status === STATUS.CREDENTIALS_DETECTED;

  // 1. One short status line.
  if (phase === 'saved') {
    body.append(statusLine('clear', 'Credentials removed and image saved'));
  } else {
    const descriptor = STATUS_TEXT[report.status] || STATUS_TEXT[STATUS.UNREADABLE];
    body.append(statusLine(descriptor.tone, descriptor.title));
  }

  // 2. The only three details a user needs.
  body.append(renderFacts(report, filename));

  // 3. One action.
  if (phase === 'saved') {
    const done = element('button', 'cc-button cc-button--primary cc-button--done', 'Saved \u2713');
    done.type = 'button';
    done.disabled = true;
    body.append(wrapAction(done));
    body.append(
      element(
        'p',
        'cc-hint',
        `Saved as ${filename ? withSuffix(filename) : 'a new file'}. Your original is unchanged, ` +
          'and watermarks inside the picture are not affected.',
      ),
    );
    return;
  }

  if (!canRemove) {
    // Nothing to remove, so offer only a way out. Never imply anything was done.
    if (report.status === STATUS.NO_CREDENTIALS_DETECTED) {
      body.append(element('p', 'cc-hint', 'There is nothing to remove from this image.'));
    } else if (report.structureError) {
      body.append(element('p', 'cc-hint', report.structureError));
    }
    body.append(singleButton('Close', state.onClose, 'cc-button'));
    return;
  }

  const working = phase === 'working';
  const remove = element(
    'button',
    `cc-button cc-button--primary${working ? ' cc-button--busy' : ''}`,
    working ? 'Removing\u2026' : 'Remove credentials & save',
  );
  remove.type = 'button';
  remove.disabled = working;
  if (working) remove.setAttribute('aria-busy', 'true');
  if (!working && state.onRemove) {
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.onRemove();
    });
  }
  body.append(wrapAction(remove));
}

/** The three facts, and only these three. */
function renderFacts(report, filename) {
  const facts = element('dl', 'cc-facts');

  addFact(facts, 'Format', report.formatLabel);
  addFact(
    facts,
    'Size',
    report.dimensions ? `${report.dimensions.width} \u00d7 ${report.dimensions.height}` : 'Unknown',
  );

  const fileValue = addFact(facts, 'File', filename || 'Unknown');
  if (filename) {
    // A long name must not stretch the panel, but the user should still be
    // able to read it in full.
    fileValue.classList.add('cc-truncate');
    fileValue.title = filename;
  }
  return facts;
}

/** A status line: a coloured dot plus text, so colour is never the only signal. */
export function statusLine(tone, text) {
  const line = element('div', `cc-status cc-status--${tone}`);
  const dot = element('span', 'cc-status__dot');
  dot.setAttribute('aria-hidden', 'true');
  line.append(dot, element('span', 'cc-status__text', text));
  return line;
}

function wrapAction(button) {
  const row = element('div', 'cc-actions');
  row.append(button);
  return row;
}

function singleButton(label, onClick, className) {
  const button = element('button', className, label);
  button.type = 'button';
  if (onClick) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }
  return wrapAction(button);
}

/** Show the saved name rather than the source name once a file has been written. */
function withSuffix(filename) {
  return filename.replace(/(\.[A-Za-z0-9]+)$/, '-processed$1');
}

/** Render a short error state, used before a report exists. */
export function renderError(body, message) {
  body.replaceChildren();
  body.append(statusLine('warn', "Couldn't process this image"));
  body.append(element('p', 'cc-hint', message || 'Please try again.'));
}

export function addFact(list, label, value) {
  list.append(element('dt', null, label));
  const dd = element('dd', null, value);
  list.append(dd);
  return dd;
}

export { element as createElement };
