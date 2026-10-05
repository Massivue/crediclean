#!/usr/bin/env node
/**
 * Build the plugin archive you upload to ChatGPT.
 *
 * WHAT THE ARCHIVE IS, AND WHAT IT IS NOT
 *
 * The archive does NOT contain the server, and OpenAI does not run it for you.
 * It is a manifest that says "this plugin is called CrediClean, and its tools
 * live at this address". The server still runs on your machine or your host.
 *
 * So the archive cannot be tested on its own. Point it at a running server
 * first. For local testing, ChatGPT's Secure MCP Tunnel reaches a server on
 * your own machine without putting it on the public internet, which is easier
 * and safer than a tunnel service.
 *
 * HOW SURE WE ARE OF THIS FORMAT: moderately. The manifest shape below comes
 * from OpenAI's plugin packaging documentation as summarised by a search
 * engine, because every OpenAI domain was blocked from the machine this was
 * written on. The JSON here is valid and self-consistent, but a field name
 * could be wrong. If the upload is rejected, the error message names the
 * field, and fixing it is a one-line change in this file.
 *
 * Usage:
 *   node scripts/package-plugin.js https://your-server.example.com
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, '..');
const BUILD = path.join(APP_ROOT, 'build');

const serverUrl = (process.argv[2] || process.env.CREDICLEAN_PUBLIC_URL || '').replace(/\/+$/, '');

if (!serverUrl) {
  console.error(`
Give me the address your MCP server is reachable at.

  node scripts/package-plugin.js https://your-server.example.com

The archive records that address. It does not contain the server, and OpenAI
will not run the server for you: it has to be running and reachable before
ChatGPT can use the plugin.
`);
  process.exit(1);
}

if (!/^https:\/\//.test(serverUrl) && !/^http:\/\/localhost/.test(serverUrl)) {
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
      // Which MCP servers in mcp.json this plugin exposes.
      apps: ['crediclean'],
    },
  },
};

/** Where the tools actually live. */
const mcp = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    crediclean: {
      type: 'streamable-http',
      url: `${serverUrl}/mcp`,
    },
  },
};

/*
 * A second copy of the pointers under .codex-plugin/, which the documentation
 * describes as a compatibility fallback. Harmless if unused, and it costs one
 * small file to not find out the hard way that it was needed.
 */
const codexManifest = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  mcpServers: './mcp.json',
};

function write(relativePath, data) {
  const target = path.join(BUILD, 'crediclean', relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  return target;
}

fs.rmSync(BUILD, { recursive: true, force: true });
write('plugin.json', manifest);
write('mcp.json', mcp);
write('.codex-plugin/plugin.json', codexManifest);

const zipPath = path.join(BUILD, `crediclean-plugin-${pkg.version}.zip`);
execFileSync('zip', ['-r', '-q', zipPath, 'crediclean'], { cwd: BUILD });

/* Prove the archive is readable and holds what we think it holds. */
const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

console.log(`\nPlugin archive: ${zipPath}`);
console.log(`Points at     : ${mcp.mcpServers.crediclean.url}`);
console.log('Contains      :');
for (const entry of listing) console.log(`  ${entry}`);
console.log(`
REMEMBER: this archive does NOT contain the server. Start the server and make
sure the address above answers before uploading, or ChatGPT will install a
plugin whose tools go nowhere.

If the upload is rejected, the error names the field it did not like. The
manifest is built in scripts/package-plugin.js and is a one-line fix.
`);

if (serverUrl.startsWith('http://localhost')) {
  console.log(
    'NOTE: this points at localhost, which ChatGPT cannot reach from its own\n' +
      'servers. For local testing use Secure MCP Tunnel instead of an archive.\n',
  );
}
