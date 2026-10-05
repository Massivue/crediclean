# Four-platform support research

Written 5 October 2026 for CrediClean 0.2.0.

## How to read this document

Every claim below is labelled:

- **Confirmed by us** — we inspected real bytes or tested it ourselves.
- **Vendor-documented** — the vendor says so, and we have read a summary of
  their page but could not open the page itself.
- **Not confirmed** — we could not establish it. Treated as unknown.

### Two limitations on this research, stated up front

1. **We could not generate images on Gemini, Copilot or Grok.** This build
   environment has no accounts for them. Everything about those three is
   research plus testing against a reconstruction, not a real file.
2. **The network here blocks several vendor domains.** `blog.google` and
   `support.microsoft.com` could not be opened, so the Gemini and Copilot
   findings come from search-result summaries **of** those first-hand pages,
   not from the pages themselves. That is weaker evidence and is labelled
   "vendor-documented" rather than confirmed.

## The thing that matters most

**C2PA metadata and invisible watermarks are different things, and CrediClean
only handles the first.**

| | What it is | Can CrediClean remove it? |
|---|---|---|
| C2PA Content Credentials | A signed block of data inside the file | **Yes**, and verifiably |
| SynthID (Google) | A pattern hidden in the pixels | **No**, and we do not try |
| Visible logo (Grok) | Part of the picture itself | **No**, and we do not try |

An image that has been through CrediClean has had its metadata removed. It has
not been made untraceable, and the product never says otherwise.

---

## ChatGPT

| Item | Finding |
|---|---|
| Domain | `chatgpt.com`, `chat.openai.com` — **confirmed by us** |
| Image host | `*.oaiusercontent.com`, and `chatgpt.com/backend-api/...` — **confirmed by us** |
| How images are shown | Ordinary `<img>` inside a `[data-message-author-role]` element — **confirmed by us** |
| Retrieving the original | Fetch the signed URL in `src`/`srcset`. The URLs are short-lived — **confirmed by us** |
| Format | PNG and WebP — **vendor-documented** |
| C2PA | Present — **confirmed by us**, by the product owner on the live site |
| Other provenance | OpenAI documents watermarking alongside C2PA — **vendor-documented** |
| Detection | Working — **confirmed by us** |
| Processing | Working, losslessly — **confirmed by us** |
| Local only | Yes — **confirmed by us** |

**Limitations:** image URLs expire, so a stale tab may fail to fetch. Nothing
else known.

---

## Google Gemini

| Item | Finding |
|---|---|
| Domain | `gemini.google.com` — **vendor-documented** |
| Image host | `lh3.googleusercontent.com` and similar — **confirmed by the product owner's test**, which reached a Google CDN address |
| How images are shown | **Not confirmed.** Adapter targets `model-response` / `message-content` elements |
| Retrieving the original | Same mechanism as ChatGPT, assuming the host is reachable — **not confirmed** |
| Format | **Not confirmed** |
| C2PA | Gemini-app images carry C2PA manifests — **vendor-documented** |
| Other provenance | **SynthID**, an invisible pixel watermark — **vendor-documented** |
| Detection | **Confirmed working** on the live site: the button appears and the panel opens |
| Processing | Engine is shared with ChatGPT, so it will work on any C2PA file — **not confirmed** for Gemini files specifically |
| Local only | Yes, by construction |

### The real cause: the page re-encodes the image before we see it

A live Gemini image was diagnosed on 5 October 2026. The result was decisive
and different from the first theory.

The `<img>` pointed at `blob:https://gemini.google.com/...`, and the bytes
behind that blob were a JPEG containing **only** a JFIF header, one
quantisation segment, a frame header and four Huffman tables:

```
FFE0:14  FFDB:130  FFC0:15  FFC4:28  FFC4:100  FFC4:25  FFC4:63
```

No `FFE1` (EXIF or XMP) and no `FFEB` (APP11, where C2PA lives). That is the
signature of an image a browser has just re-encoded. The single 130-byte
quantisation segment is characteristic of a canvas encode; a file from a tool
like ImageMagick splits it into two.

**So the Gemini page builds a fresh copy of the picture and displays that.** By
the time CrediClean sees anything, the credentials have already been destroyed
inside the page. This cannot be fixed by changing the address, because there is
no address: the bytes were manufactured in memory.

**First attempt, which failed:** search the markup for the original's address.
Running a DOM dump on the live page returned empty lists for both links and
attributes. Gemini keeps no address for the original anywhere in the page, so
there is nothing to find. The code remains as a cheap fallback for sites that
do expose one, but it cannot help here.

**Second attempt, current:** watch what the page downloads.

The page must fetch the picture from somewhere before re-encoding it. A small
script running in the page's own JavaScript world records the addresses of
image responses as they happen, and the extension asks it for that list when
the user inspects a blob-backed image.

This is the most intrusive code in the extension, so it is tightly bounded:

- injected **only on Gemini**, because only Gemini needs it. ChatGPT does not
  get it, deliberately: that platform works and nothing should risk it;
- it never blocks, delays, rewrites or retries a request;
- it never reads a response body, so no stream the page depends on is consumed;
- it records addresses and content types only, never image data;
- every wrapper calls through to the original and is wrapped in try/catch, so a
  failure inside it falls straight through to normal behaviour.

Anything recovered this way is checked against the image on screen, same aspect
ratio within 2 percent and at least as many pixels, before it is used. Handing
back somebody else's picture would be far worse than failing.

### What observing the downloads revealed

The observer worked. On a live Gemini image it recovered four real
`lh3.googleusercontent.com/rd-gg/...` addresses and fetched one instead of the
blob.

The result was the decisive finding of this whole investigation:

```
From the blob         : jpeg 167736 bytes 1024x559
                        FFE0:14 FFDB:130 FFC0:15 FFC4:28 FFC4:100 FFC4:25 FFC4:63
From Google's server  : jpeg 167736 bytes 1024x559
                        FFE0:14 FFDB:130 FFC0:15 FFC4:28 FFC4:100 FFC4:25 FFC4:63
```

**Identical byte length, identical dimensions, identical container.** So the
page is not re-encoding anything, which disproves the canvas theory as well. It
downloads this file and shows it directly.

**Google's own server is serving a JPEG with no Content Credentials in it.**
The credentials are removed before anything reaches the browser.

That changes what is left to try. Two possibilities remain:

1. A different address serves the credentialed original. The adapter now also
   tries the `=s0` and `=d` forms of every observed address, and prefers
   whichever candidate actually turns out to carry credentials rather than
   trusting the order.
2. Gemini's own download button fetches from a different endpoint. Because the
   observer records what the page downloads, clicking that button before
   inspecting makes its address available too.

**If neither works, this is not fixable from a browser extension.** If Google
never serves a file with credentials to the browser, then no extension running
in the browser can find any, and "no supported credentials found" is the
correct and honest answer.

### Resolved: Gemini serves two different files

Confirmed on a live image, 5 October 2026:

| | Shown in the conversation | Gemini's full-size download |
|---|---|---|
| Address | `lh3.googleusercontent.com/rd-gg/AJWXcNen2jLL...` | `.../AJWXcNcIkIpyV0n2...` |
| Format | JPEG | **PNG** |
| Dimensions | 1024 x 559 | **1408 x 768** |
| Credentials | none | **present** |

They are separate files with separate identifiers that diverge after a few
characters, so the full-size address cannot be derived from the display one.
The conversation shows a rendered derivative; the credentials live only in the
original.

**So Gemini images can be processed.** The problem was never the credential
engine, and never the format. It was that the extension was reading the wrong
file.

### How the original is found, without the user downloading anything

Gemini's own download button knows the full-size address, which means the app
was told it, which means it arrived in an API response. So the page-world
observer now scans text responses for Google image addresses, including
JSON-escaped ones. The response is **cloned** before reading, and cloning does
not consume the body, so the page's own use of it is unaffected.

Everything else was already in place: the candidate list tries each address,
and the loader prefers whichever one actually carries credentials rather than
trusting the order. That is what lands on the original rather than the
derivative.

A browser test reproduces this exactly: the conversation displays a
credential-free derivative from a blob, the page contains no download link at
all, and the full-size address appears only inside a JSON API response. The
test asserts the extension finds the credentials with nothing clicked. If Google's servers hand the browser an
already-stripped image, then nothing reaches the browser that has credentials
in it, no extension can recover them, and "no supported credentials found" is
simply the correct answer. The way to settle this is to download an image using
Gemini's own download button and inspect the bytes.

### The resized-derivative problem, and the fix

On 5 October 2026 a real Gemini image reported "No supported credentials
found". Detection was working; retrieval was not.

**Cause:** Google serves images through a resizing CDN. The address in the page
ends with an options string such as `=w526-h296-rw`, asking for a particular
width, height and format. What comes back is a **derivative** that the CDN
re-encoded on the fly, and a re-encoded copy carries none of the original's
C2PA manifest. Inspecting it will always report nothing found, however correct
the credential engine is.

**Fix:** the Gemini adapter now rewrites the options to `=s0`, which asks for
the original at original resolution and format, and tries that first. The
address from the page is kept as a fallback, so if the rewrite is ever wrong
the extension behaves exactly as it did before rather than breaking.

`=s0` is **an inference, not vendor-documented**. Google does not publish this
as an API, though the convention is well established and widely corroborated.
The fallback is what makes relying on it safe.

A browser test reproduces the whole failure: the mock page shows a stripped
derivative and serves the signed original only at `=s0`, so the test fails
unless the adapter genuinely asks for the original.

**The SynthID point, because it is the one most likely to mislead a user:**
Google applies both C2PA metadata and SynthID. CrediClean removes the first.
The second stays in the pixels and Google's detector will still find it. This
is expected and is not a failure of the removal. The adapter records this fact
in `knownUnremovableProvenance` so the project cannot lose track of it.

**Main remaining risk:** whether the `=s0` original itself carries C2PA. If
Google strips credentials from everything its CDN serves, no address will have
them and the correct answer really is "none found". The built-in diagnosis
distinguishes these: see `docs/TROUBLESHOOTING.md`.

---

## Microsoft Copilot

| Item | Finding |
|---|---|
| Domain | `copilot.microsoft.com`, `designer.microsoft.com` — **vendor-documented** |
| Image host | **Not confirmed.** `th.bing.com` is Bing's long-standing image CDN and is the most likely, but this is an inference |
| How images are shown | **Not confirmed.** Adapter targets `[data-content="ai-message"]` and similar |
| Retrieving the original | **Not confirmed** |
| Format | **Not confirmed** |
| C2PA | Images created with Designer's features in Copilot carry Content Credentials based on C2PA — **vendor-documented** |
| Other provenance | **Not confirmed** |
| Detection | Implemented, **not confirmed** on the live site |
| Processing | Shared engine — **not confirmed** for Copilot files specifically |
| Local only | Yes, by construction |

**Note on surfaces:** Copilot image generation is reachable from more than one
place, and Bing Image Creator, Designer and Copilot share a generation
pipeline. The adapter claims the two Copilot/Designer domains. It does **not**
claim all of `bing.com` or `microsoft.com`, which would be a far broader
permission than this extension needs.

---

## Grok (xAI)

**This is the platform we are least sure about, and the product reflects that.**

| Item | Finding |
|---|---|
| Does Grok generate images | Yes, via Grok Imagine — **vendor-documented** |
| Domain | `grok.com`, and inside `x.com` — **vendor-documented** |
| Image host | **Not confirmed.** Expected `assets.grok.com` on grok.com and `pbs.twimg.com` within X |
| How images are shown | **Not confirmed** |
| Retrieving the original | **Not confirmed.** xAI documents that generated image URLs are temporary |
| Format | **Not confirmed** |
| **C2PA** | **CONFIRMED PRESENT.** Tested on the live site 5 October 2026: credentials were detected and removed successfully. This resolves the uncertainty recorded below, which is kept as a record of what research alone could establish. |
| Other provenance | A **visible corner logo**, which is part of the picture and not metadata — **vendor-documented** |
| Detection | Implemented, **not confirmed** |
| Processing | **Unknown.** The engine runs; whether it finds anything is unknown |

### Why Grok's C2PA status is recorded as unknown

We looked, and the evidence does not support a claim either way:

- **xAI publishes no documentation** stating that Grok attaches C2PA Content
  Credentials.
- **xAI is not on the C2PA steering committee**, unlike OpenAI.
- Reporting indicates xAI signed only the safety chapter of the EU's
  general-purpose AI code of practice and declined the transparency chapter.
- **The sources that state confidently that Grok uses C2PA are watermark
  removal services.** They sell a product whose value depends on that claim
  being true. That is a commercial interest, not evidence, and we did not rely
  on them.

### What the product does about it

Nothing invented. The Grok adapter finds the image and hands the bytes to the
same engine every other platform uses. Then:

- If a Grok image **does** carry supported credentials, they are detected and
  can be removed, exactly as elsewhere.
- If it **does not**, the panel says **"No supported credentials found"** and
  offers nothing to remove.

Both outcomes are correct. The second is not a bug, and it is the one our
reconstruction test deliberately exercises.

---

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | Three settings |
| `chatgpt.com`, `chat.openai.com` | ChatGPT pages |
| `gemini.google.com` | Gemini pages |
| `copilot.microsoft.com`, `designer.microsoft.com` | Copilot pages |
| `grok.com`, `x.com` | Grok pages |
| `*.oaiusercontent.com` | ChatGPT image files — **confirmed** |
| `*.googleusercontent.com` | Expected Gemini image files. Cannot be narrowed: Google spreads user content across `lh3`, `lh4` and similar |
| `th.bing.com`, `*.bing.net` | Expected Copilot image files |
| `assets.grok.com`, `pbs.twimg.com` | Expected Grok image files |
| `usercontent.google.com` | Alternative Google user-content host |

Deliberately **not** requested: `<all_urls>`, all of `google.com`,
`microsoft.com` or `bing.com`, the `downloads` permission, the `tabs`
permission, history, cookies.

These are generated from `src/platforms/`, and `npm run verify` fails if the
manifest and the adapters ever disagree.

## What would change these findings

One real file from each platform. If you generate an image on Gemini, Copilot
or Grok, download it and send it, we can inspect the actual bytes and turn
most of the "not confirmed" rows above into confirmed ones in a single pass.
