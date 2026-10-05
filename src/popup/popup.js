/**
 * Popup: say whether CrediClean is active here, offer the supported sites, and
 * edit the three settings.
 *
 * The list of sites is built from the platform registry rather than written
 * out here, so adding or removing a platform updates this automatically and
 * the popup can never claim support that does not exist.
 */

import { loadSettings, saveSettings } from '../shared/settings.js';
import { ADAPTERS, adapterForHost } from '../platforms/index.js';
import { routeIsSupported } from '../content/route-watcher.js';

const fields = {
  enabled: document.getElementById('setting-enabled'),
  showImageButtons: document.getElementById('setting-buttons'),
  removeXmpProvenanceReference: document.getElementById('setting-xmp'),
};

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const savedNote = document.getElementById('saved-note');
const sites = document.getElementById('sites');

let savedTimer = null;
function flashSaved() {
  savedNote.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedNote.hidden = true;
  }, 1400);
}

/**
 * Where is the active tab, as far as CrediClean is concerned?
 *
 * Returns the platform AND whether this particular page of it is one the
 * extension runs on. The two are different: ChatGPT's store and settings
 * pages are still ChatGPT, but CrediClean is not active there, and saying
 * "Active on ChatGPT" on a page where no button will ever appear would be
 * telling the user something untrue.
 *
 * @returns {{platform: object|null, onSupportedRoute: boolean}}
 */
async function currentLocation() {
  try {
    /*
     * Deliberately NOT requesting the "tabs" permission. tabs.query works
     * without it; `tab.url` is simply only filled in for addresses matching
     * our host permissions, which is exactly the set we care about. Every
     * other site reads as undefined, which is the right answer here.
     */
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return { platform: null, onSupportedRoute: false };
    const url = new URL(tab.url);
    if (url.protocol !== 'https:') return { platform: null, onSupportedRoute: false };
    const platform = adapterForHost(url.hostname);
    if (!platform) return { platform: null, onSupportedRoute: false };
    return { platform, onSupportedRoute: routeIsSupported(platform, url) };
  } catch {
    return { platform: null, onSupportedRoute: false };
  }
}

function describeStatus(settings, where) {
  const { platform, onSupportedRoute } = where;
  const off = (text) => {
    statusDot.classList.remove('status__dot--on');
    statusText.textContent = text;
  };

  if (!settings.enabled) return off('Turned off');
  if (!platform) return off('Open one of the sites below');

  // On the right site, but on a page the extension does not run on: its store,
  // its settings, anything that is not a conversation.
  if (!onSupportedRoute) return off('Not active on this page');

  if (!settings.showImageButtons) return off(`${platform.name}: buttons hidden`);

  statusDot.classList.add('status__dot--on');
  statusText.textContent = `Active on ${platform.name}`;
  return undefined;
}

/** One button per supported site, with the current one highlighted. */
function renderSites(platform) {
  sites.replaceChildren();
  for (const adapter of ADAPTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = adapter.id === platform?.id ? 'site site--here' : 'site';
    button.textContent = adapter.name;
    button.title = `Open ${adapter.name}`;
    button.addEventListener('click', async () => {
      await chrome.tabs.create({ url: `https://${adapter.hosts[0]}/` });
      window.close();
    });
    sites.append(button);
  }
}

async function init() {
  const settings = await loadSettings();
  const where = await currentLocation();

  for (const [key, input] of Object.entries(fields)) {
    if (!input) continue;
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', async () => {
      const next = await saveSettings({ [key]: input.checked });
      flashSaved();
      describeStatus(next, where);
    });
  }

  describeStatus(settings, where);
  renderSites(where.platform);
  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
}

init().catch((error) => {
  statusText.textContent = 'Could not load settings.';
  console.warn('[CrediClean] Popup failed to initialise.', error);
});
