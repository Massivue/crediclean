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

/** Which supported platform is the active tab on, if any? */
async function currentPlatform() {
  try {
    /*
     * Deliberately NOT requesting the "tabs" permission. tabs.query works
     * without it; `tab.url` is simply only filled in for addresses matching
     * our host permissions, which is exactly the set we care about. Every
     * other site reads as undefined, which is the right answer here.
     */
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return null;
    const { hostname, protocol } = new URL(tab.url);
    if (protocol !== 'https:') return null;
    return adapterForHost(hostname);
  } catch {
    return null;
  }
}

function describeStatus(settings, platform) {
  if (!settings.enabled) {
    statusDot.classList.remove('status__dot--on');
    statusText.textContent = 'Turned off';
    return;
  }
  if (platform) {
    statusDot.classList.add('status__dot--on');
    statusText.textContent = settings.showImageButtons
      ? `Active on ${platform.name}`
      : `Active on ${platform.name}, buttons hidden`;
    return;
  }
  statusDot.classList.remove('status__dot--on');
  statusText.textContent = 'Open one of the sites below';
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
  const platform = await currentPlatform();

  for (const [key, input] of Object.entries(fields)) {
    if (!input) continue;
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', async () => {
      const next = await saveSettings({ [key]: input.checked });
      flashSaved();
      describeStatus(next, platform);
    });
  }

  describeStatus(settings, platform);
  renderSites(platform);
  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
}

init().catch((error) => {
  statusText.textContent = 'Could not load settings.';
  console.warn('[CrediClean] Popup failed to initialise.', error);
});
