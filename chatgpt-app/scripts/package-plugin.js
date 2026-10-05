#!/usr/bin/env node
/**
 * Build the plugin archive you upload to ChatGPT.
 *
 * TWO KINDS OF ARCHIVE, AND THE DIFFERENCE MATTERS
 *
 * By default this builds a SKILL-ONLY archive. It carries the whole of
 * CrediClean as a skill: instructions plus a Python script that ChatGPT runs
 * in its own sandbox, on a file already there. Nothing to host, nothing to
 * expose, no server, and the image never leaves OpenAI's sandbox. This is the
 * one to test with.
 *
 * Pass a server address and it ALSO wires in the MCP server. That archive does
 * NOT contain the server and OpenAI does not run it: it is a label saying
 * where the tools live, and the server has to be running and reachable. Only
 * useful once there is somewhere to run it.
 *
 * HOW SURE WE ARE OF THIS FORMAT: moderately. The manifest shape comes from
 * OpenAI's plugin packaging documentation as summarised by a search engine,
 * because every OpenAI domain was blocked from the machine this was written
 * on. The JSON is valid and self-consistent, but a field name could be wrong.
 * If an upload is rejected, the error names the field, and fixing it is a
 * one-line change here.
 *
 * Usage:
 *   node scripts/package-plugin.js                                 # skill only
 *   node scripts/package-plugin.js https://your-server.example.com # + MCP server
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, '..');
const BUILD = path.join(APP_ROOT, 'build');

const serverUrl = (process.argv[2] || '').replace(/\/+$/, '');

if (serverUrl && !/^https:\/\//.test(serverUrl) && !/^http:\/\/localhost/.test(serverUrl)) {
  console.error(`Refusing to build with "${serverUrl}". Use an https:// address.`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

/**
 * The portable plugin manifest.
 *
 * Everything a reviewer or a user reads about CrediClean is here, and every
 * line of it has to be true. In particular the description says what the tool
 * does NOT do, because that is the claim people most often assume.
 */
const manifest = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'crediclean',
  version: pkg.version,
  description:
    'Inspect and remove C2PA Content Credentials from AI-generated images, and get a ' +
    'clean copy back. Does not remove invisible watermarks and does not make an image ' +
    'untraceable.',
  author: { name: 'Massivue' },
  homepage: 'https://github.com/Massivue/crediclean',
  repository: 'https://github.com/Massivue/crediclean',
  license: 'MIT',
  keywords: ['images', 'metadata', 'content credentials', 'c2pa', 'provenance'],

  extensions: {
    'com.openai': {
      interface: {
        displayName: 'CrediClean',
        shortDescription: 'Inspect and remove image Content Credentials',
        longDescription:
          'CrediClean reads the Content Credentials (C2PA provenance metadata) inside an ' +
          'image and can remove them, handing back a clean copy. The picture itself is ' +
          'never re-encoded: the result is pixel-for-pixel identical to the original.\n\n' +
          'What it does not do, stated plainly: it does not remove invisible watermarks ' +
          'such as SynthID, which live in the pixels rather than the metadata, and it ' +
          'never makes an image untraceable or human-made. It removes metadata, and ' +
          'says so.',
        developerName: 'Massivue',
        category: 'productivity',
        privacyPolicyUrl: 'https://github.com/Massivue/crediclean/blob/main/PRIVACY.md',
      },
      // Where the skill lives inside this archive.
      skills: './skills/',
      // Only claim an MCP server when one was actually given an address.
      ...(serverUrl ? { apps: ['crediclean'] } : {}),
    },
  },
};

/** Where the MCP tools live, when there are any. */
const mcp = serverUrl
  ? {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        crediclean: { type: 'streamable-http', url: `${serverUrl}/mcp` },
      },
    }
  : null;

/*
 * A second copy of the pointers under .codex-plugin/, which the documentation
 * describes as a compatibility fallback. Harmless if unused, and it costs one
 * small file to not find out the hard way that it was needed.
 */
const codexManifest = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  skills: './skills/',
  ...(serverUrl ? { mcpServers: './mcp.json' } : {}),
};

function write(relativePath, data) {
  const target = path.join(BUILD, 'crediclean', relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  return target;
}

fs.rmSync(BUILD, { recursive: true, force: true });
write('plugin.json', manifest);
if (mcp) write('mcp.json', mcp);
write('.codex-plugin/plugin.json', codexManifest);

/*
 * The skill itself: SKILL.md plus the Python that does the work. This is the
 * part that makes the archive useful on its own, because ChatGPT runs it in
 * its own sandbox rather than calling out to anything.
 */
const skillSource = path.join(APP_ROOT, 'skill');
const skillTarget = path.join(BUILD, 'crediclean', 'skills', 'crediclean');
fs.cpSync(skillSource, skillTarget, { recursive: true });

/*
 * Prove the script survived the copy and is still valid Python. A compile
 * check, not a run: running it with no arguments prints usage and exits 2,
 * which is correct behaviour but would look like a failure here.
 */
execFileSync('python3', ['-m', 'py_compile', path.join(skillTarget, 'scripts', 'crediclean.py')], {
  stdio: 'inherit',
});
// py_compile leaves a __pycache__ behind; it has no business in the archive.
fs.rmSync(path.join(skillTarget, 'scripts', '__pycache__'), { recursive: true, force: true });

const zipPath = path.join(BUILD, `crediclean-plugin-${pkg.version}.zip`);
execFileSync('zip', ['-r', '-q', zipPath, 'crediclean'], { cwd: BUILD });

/* Prove the archive is readable and holds what we think it holds. */
const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

console.log(`\nPlugin archive: ${zipPath}`);
console.log(`Kind          : ${serverUrl ? 'skill + MCP server' : 'skill only (nothing to host)'}`);
if (mcp) console.log(`MCP server at : ${mcp.mcpServers.crediclean.url}`);
console.log('Contains      :');
for (const entry of listing) console.log(`  ${entry}`);
if (serverUrl) {
  console.log(`
REMEMBER: this archive does NOT contain the MCP server. Start the server and
make sure the address above answers before uploading, or ChatGPT will install
a plugin whose tools go nowhere. The skill part works regardless.
`);
  if (serverUrl.startsWith('http://localhost')) {
    console.log(
      'NOTE: that address is localhost, which ChatGPT cannot reach. For a local\n' +
        'server use Secure MCP Tunnel instead of putting it in an archive.\n',
    );
  }
} else {
  console.log(`
This archive is self-contained. The skill runs inside ChatGPT's own sandbox,
so there is nothing to host and nothing to expose.

Upload it at: ChatGPT -> Plugins -> Add -> Upload plugin archive
`);
}

console.log(
  'If an upload is rejected, the error names the field it did not like. The\n' +
    'manifest is built in scripts/package-plugin.js and is a one-line fix.\n',
);
