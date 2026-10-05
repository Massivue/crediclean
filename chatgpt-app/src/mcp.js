/**
 * The MCP server: how ChatGPT sees CrediClean.
 *
 * A ChatGPT app IS an MCP server. It declares tools, ChatGPT decides when to
 * call them, and optionally ChatGPT renders an HTML widget we supply. The
 * OpenAI-specific parts are all in the `_meta` blocks below, and each one is
 * commented with what it does and how sure we are of it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { describeError, inspectImageTool, removeCredentialsTool } from './tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_FILE = path.join(HERE, '..', 'widget', 'panel.html');

/** The URI our widget is addressed by. ChatGPT requires the `ui://` scheme. */
export const WIDGET_URI = 'ui://widget/crediclean-panel.html';

/**
 * The file argument's schema.
 *
 * Deliberately permissive. ChatGPT REPLACES whatever the model put here with
 * its own object once `openai/fileParams` names the field, so a strict schema
 * would reject the very thing we want. `files.js` does the real validation,
 * where it can give a useful message instead of a schema error.
 */
const fileArg = z.any().describe('The image to work on, from the conversation.');

/**
 * Describe the widget to ChatGPT.
 *
 * `openai/outputTemplate` is what links a tool to the HTML it renders.
 * Without it the tool still works, but the user gets only text.
 */
function widgetMeta(extra = {}) {
  return {
    'openai/outputTemplate': WIDGET_URI,
    // Shown while the tool runs and after it finishes. Plain words on purpose:
    // the user reads these, not us.
    'openai/toolInvocation/invoking': 'Reading the image…',
    'openai/toolInvocation/invoked': 'Done',
    ...extra,
  };
}

/**
 * Build the server. A fresh one per request, because the HTTP transport below
 * is stateless and sharing one across requests is how you get crossed wires.
 */
export function createCrediCleanServer() {
  const server = new McpServer(
    { name: 'crediclean', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'CrediClean inspects and removes C2PA Content Credentials from AI-generated ' +
        'images. Use inspect_image_credentials when the user asks what provenance or ' +
        'Content Credentials an image carries. Use remove_image_credentials when they ' +
        'ask to remove or strip them, or to get a clean copy. CrediClean does NOT ' +
        'remove invisible watermarks such as SynthID, and never makes an image ' +
        'untraceable. Do not tell the user otherwise.',
    },
  );

  /* -- The widget ------------------------------------------------------- */

  server.registerResource(
    'crediclean-panel',
    WIDGET_URI,
    { title: 'CrediClean panel', description: 'The CrediClean result card.' },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: 'text/html+skybridge',
          text: await readFile(WIDGET_FILE, 'utf8'),
        },
      ],
    }),
  );

  /* -- Tool 1: look, change nothing ------------------------------------- */

  server.registerTool(
    'inspect_image_credentials',
    {
      title: 'Inspect Content Credentials',
      description:
        'Look at an image from the conversation and report what Content Credentials ' +
        '(C2PA provenance metadata) it carries, along with its format and size. ' +
        'Reads only: the image is not changed.',
      inputSchema: { image: fileArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: widgetMeta({
        // Tells ChatGPT that `image` is a file, which is what makes it replace
        // a /mnt/data path with a real download URL. Everything depends on it.
        'openai/fileParams': ['image'],
      }),
    },
    async ({ image }) => runTool(() => inspectImageTool(image)),
  );

  /* -- Tool 2: remove, and hand back a clean copy ----------------------- */

  server.registerTool(
    'remove_image_credentials',
    {
      title: 'Remove Content Credentials',
      description:
        'Remove the C2PA Content Credentials from an image in the conversation and ' +
        'return a clean copy to download. The picture itself is untouched, pixel for ' +
        'pixel, and nothing is re-compressed. This does NOT remove invisible ' +
        'watermarks such as SynthID and does not make an image untraceable.',
      inputSchema: {
        image: fileArg,
        removeXmpProvenanceReference: z
          .boolean()
          .optional()
          .describe(
            'Also drop an XMP packet that points at the manifest being removed. ' +
              'Defaults to true. Any unrelated XMP fields in that packet go with it.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: widgetMeta({
        'openai/fileParams': ['image'],
        // Lets our own panel call this tool from its button, rather than the
        // user having to ask a second time in words.
        'openai/widgetAccessible': true,
      }),
    },
    async ({ image, removeXmpProvenanceReference }) =>
      runTool(() => removeCredentialsTool(image, { removeXmpProvenanceReference })),
  );

  return server;
}

/**
 * Run a tool and shape the reply.
 *
 * Every reply carries the same three things:
 *  - `structuredContent`, which our widget renders;
 *  - a short text block, because a client that cannot draw the widget (and
 *    mobile may well be one) must still give the user a usable answer;
 *  - on failure, `isError`, so the model says something sensible rather than
 *    inventing a result.
 */
async function runTool(work) {
  let data;
  try {
    data = await work();
  } catch (error) {
    const message = describeError(error);
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: { status: 'error', headline: "Couldn't process this image", message },
    };
  }

  return {
    content: [{ type: 'text', text: summarise(data) }],
    structuredContent: data,
  };
}

/**
 * The text a user sees if no widget is drawn.
 *
 * Written so it is still honest and complete on its own: what was found, and
 * where the file is. It must never imply a removal that did not happen.
 */
function summarise(data) {
  const { facts } = data;
  const lines = [data.headline];
  if (facts) {
    lines.push(`Format: ${facts.format}`, `Size: ${facts.dimensions}`, `File: ${facts.filename}`);
  }
  if (data.removed && data.download) {
    lines.push('', `Download the clean copy: ${data.download.url}`, '', data.note);
  } else if (data.message) {
    lines.push('', data.message);
  } else if (data.canRemove) {
    lines.push('', 'Ask to remove them to get a clean copy.');
  }
  return lines.join('\n');
}
