#!/usr/bin/env node
/**
 * Check the extension package before loading or shipping it.
 *
 * This catches the failures that are silent at load time and only show up as
 * "the buttons never appear": a file listed in the manifest that does not
 * exist, a module imported by a content script but missing from
 * web_accessible_resources, or a permission requested that nothing uses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];
const notes = [];

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* 1. Every file the manifest points at must exist. */
const referenced = [];
if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
for (const script of manifest.content_scripts || []) {
  referenced.push(...(script.js || []), ...(script.css || []));
}
if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
for (const icons of [manifest.icons, manifest.action?.default_icon]) {
  if (icons) referenced.push(...Object.values(icons));
}
for (const entry of manifest.web_accessible_resources || []) {
  referenced.push(...(entry.resources || []));
}

for (const file of new Set(referenced)) {
  if (file.includes('*')) continue;
  if (!exists(file)) problems.push(`manifest references a file that does not exist: ${file}`);
}

/* 2. Every module reachable from the content script must be web-accessible,
      or the dynamic import will fail at run time and no buttons will appear. */
const accessible = new Set(
  (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []),
);

function importsOf(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const found = new Set();
  // Static imports and re-exports.
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]/g)) {
    found.add(match[1]);
  }
  // Dynamic imports with a literal path.
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(match[1]);
  // Our own runtime.getURL('src/...') pattern.
  for (const match of source.matchAll(/getURL\(\s*[`'"]([^`'"$]+)[`'"]\s*\)/g)) found.add(match[1]);
  for (const match of source.matchAll(/moduleUrl\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(`src/${match[1]}`);
  return [...found];
}

const contentEntry = (manifest.content_scripts || []).flatMap((script) => script.js || []);
const seen = new Set();
const queue = [...contentEntry];

while (queue.length > 0) {
  const current = queue.shift();
  if (seen.has(current) || !exists(current)) continue;
  seen.add(current);

  for (const specifier of importsOf(current)) {
    let target;
    if (specifier.startsWith('.')) {
      target = path.posix.normalize(path.posix.join(path.posix.dirname(current), specifier));
    } else if (specifier.startsWith('src/')) {
      target = specifier;
    } else {
      continue; // a bare specifier would be a packaging mistake; flagged below
    }

    if (!exists(target)) {
      problems.push(`${current} imports a file that does not exist: ${target}`);
      continue;
    }
    // The content script entry point is injected by Chrome, so it does not need
    // to be web-accessible. Everything it pulls in at run time does.
    if (current !== contentEntry[0] || specifier.startsWith('src/')) {
      if (!accessible.has(target)) {
        problems.push(
          `${target} is loaded by the content script but is not in web_accessible_resources`,
        );
      }
    }
    queue.push(target);
  }
}

/* 3. Permissions should match what the code actually uses. */
const sourceFiles = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (/\.(js|html)$/.test(entry.name)) sourceFiles.push(relative);
  }
})('src');

const allSource = sourceFiles.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');

const PERMISSION_USAGE = {
  storage: /chrome\.storage\./,
  downloads: /chrome\.downloads\./,
  scripting: /chrome\.scripting\./,
  notifications: /chrome\.notifications\./,
  cookies: /chrome\.cookies\./,
  webRequest: /chrome\.webRequest\./,
};

// A permission that is requested but unused is an unnecessary install warning.
for (const permission of manifest.permissions || []) {
  const pattern = PERMISSION_USAGE[permission];
  if (pattern && !pattern.test(allSource)) {
    warnings.push(`permission "${permission}" is requested but no code appears to use it`);
  }
}

// A permission that is used but not requested is a run-time failure.
for (const [permission, pattern] of Object.entries(PERMISSION_USAGE)) {
  if (!(manifest.permissions || []).includes(permission) && pattern.test(allSource)) {
    problems.push(`code uses chrome.${permission} but "${permission}" is not in permissions`);
  }
}

/* chrome.tabs needs careful handling, because the rules are not obvious:
   - tabs.create needs no permission at all;
   - tabs.query works without the "tabs" permission, but the url, title and
     favIconUrl of a result are only filled in for tabs whose address matches
     one of our host_permissions.
   We rely on exactly that: the popup reads tab.url only to tell whether the
   user is on ChatGPT, which our host_permissions already cover. Requesting
   "tabs" would widen access to every tab's address for no benefit. */
if (/chrome\.tabs\.query/.test(allSource) && !(manifest.permissions || []).includes('tabs')) {
  if ((manifest.host_permissions || []).length === 0) {
    problems.push('chrome.tabs.query reads tab URLs but there is no "tabs" permission and no host_permissions');
  } else {
    notes.push('tabs.query is used without the "tabs" permission: tab URLs resolve only for host_permissions, which is intended');
  }
}

/* 4. The service worker's fetch allowlist must not exceed host_permissions. */
const workerSource = fs.readFileSync(path.join(ROOT, manifest.background.service_worker), 'utf8');
const allowlist = [...workerSource.matchAll(/'([a-z0-9.-]+\.[a-z]{2,})'/g)]
  .map((match) => match[1])
  .filter((host) => /\./.test(host) && !host.endsWith('.js'));
const hostPermissionHosts = (manifest.host_permissions || []).map((pattern) =>
  pattern.replace(/^https:\/\//, '').replace(/^\*\./, '').replace(/\/\*$/, ''),
);

for (const host of new Set(allowlist)) {
  if (!hostPermissionHosts.includes(host)) {
    problems.push(
      `service worker allows fetching from "${host}" but it is not in host_permissions`,
    );
  }
}
notes.push(`host permissions: ${(manifest.host_permissions || []).join(', ')}`);
notes.push(`permissions: ${(manifest.permissions || []).join(', ') || '(none)'}`);
notes.push(`modules reachable from the content script: ${seen.size}`);

/* 5. The manifest must still agree with the platform registry, which is the
      single source of truth for which sites are supported. */
const registry = await import('../src/platforms/index.js');
const pageHosts = registry.allPageHosts();
const imageHosts = registry.allImageHosts();

const matches = (manifest.content_scripts || []).flatMap((script) => script.matches || []);
for (const host of pageHosts) {
  const pattern = `https://${host}/*`;
  if (!matches.includes(pattern)) {
    problems.push(`platform registry lists ${host} but no content script matches ${pattern}`);
  }
}
const hostPermissions = manifest.host_permissions || [];
for (const host of imageHosts) {
  const covered = hostPermissions.some(
    (pattern) => pattern === `https://${host}/*` || pattern === `https://*.${host}/*`,
  );
  if (!covered) problems.push(`platform registry allows fetching from ${host} but host_permissions does not`);
}
for (const pattern of hostPermissions) {
  const host = pattern.replace(/^https:\/\//, '').replace(/^\*\./, '').replace(/\/\*$/, '');
  if (!pageHosts.includes(host) && !imageHosts.includes(host)) {
    warnings.push(`host_permissions includes ${pattern}, which no platform adapter asks for`);
  }
}
notes.push(`platforms: ${registry.ADAPTERS.map((a) => a.id).join(', ')}`);

/* Report. */
for (const note of notes) console.log(`  info    ${note}`);
for (const warning of warnings) console.log(`  warning ${warning}`);
for (const problem of problems) console.error(`  PROBLEM ${problem}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log(`\nManifest verified. ${warnings.length} warning(s).`);
