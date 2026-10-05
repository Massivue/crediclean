/**
 * Everything that differs between a laptop and a real deployment.
 *
 * Read once at start-up so a misconfigured server fails immediately and
 * loudly, rather than halfway through someone's first image.
 */

/** Where this server is reachable from the public internet. */
export const PUBLIC_BASE_URL = (process.env.CREDICLEAN_PUBLIC_URL || 'http://localhost:8787')
  .replace(/\/+$/, '');

export const PORT = Number(process.env.PORT || 8787);

/**
 * Hosts this server is willing to download an image from.
 *
 * THIS IS A SECURITY CONTROL, NOT A CONVENIENCE. The server is a public
 * endpoint that fetches a URL someone else supplies. Without a list like this
 * it is a server-side request forgery tool: anyone could point it at
 * `http://169.254.169.254/` and have it fetch cloud credentials for them, or
 * at a private address inside the network it runs in.
 *
 * The defaults are the OpenAI hosts we expect a ChatGPT file download URL to
 * use. They are an INFERENCE, not something OpenAI documents, so a refused
 * host is logged with its name: that one line is all you need to correct this
 * list. Override with CREDICLEAN_ALLOWED_HOSTS as a comma-separated list.
 */
const DEFAULT_ALLOWED_HOSTS = [
  'files.oaiusercontent.com',
  'oaiusercontent.com',
  'api.openai.com',
  'chatgpt.com',
  'cdn.openai.com',
];

export const ALLOWED_DOWNLOAD_HOSTS = (process.env.CREDICLEAN_ALLOWED_HOSTS
  ? process.env.CREDICLEAN_ALLOWED_HOSTS.split(',')
  : DEFAULT_ALLOWED_HOSTS
).map((host) => host.trim().toLowerCase()).filter(Boolean);

/**
 * Refuse anything larger than this, in bytes.
 *
 * Processing is a whole-file operation in memory, so an unbounded upload is a
 * way to exhaust the server. 40 MB is comfortably above any image a chat
 * assistant produces.
 */
export const MAX_IMAGE_BYTES = Number(process.env.CREDICLEAN_MAX_BYTES || 40 * 1024 * 1024);

/** Give up on a slow download rather than holding a request open forever. */
export const DOWNLOAD_TIMEOUT_MS = Number(process.env.CREDICLEAN_DOWNLOAD_TIMEOUT_MS || 20_000);

/**
 * How long a processed file stays available for download, in milliseconds.
 *
 * Deliberately short. The file is somebody's picture and this server has no
 * business keeping it. Long enough for the user to click the link they were
 * just shown; not long enough to be a store of other people's images.
 */
export const PROCESSED_FILE_TTL_MS = Number(process.env.CREDICLEAN_FILE_TTL_MS || 15 * 60 * 1000);

/** Cap on how many processed files are held at once, as a second safety net. */
export const MAX_HELD_FILES = Number(process.env.CREDICLEAN_MAX_HELD_FILES || 200);

export function describeConfig() {
  return {
    publicBaseUrl: PUBLIC_BASE_URL,
    port: PORT,
    allowedDownloadHosts: ALLOWED_DOWNLOAD_HOSTS,
    maxImageBytes: MAX_IMAGE_BYTES,
    processedFileTtlMs: PROCESSED_FILE_TTL_MS,
  };
}
