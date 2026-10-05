# Build log

Version 0.1.0, built 4 October 2026.

## Milestone 1: Feasibility

**Goal:** find out whether this is possible at all before building anything.

Downloaded real C2PA-signed images from the Content Authenticity Initiative's
own test repositories and examined their bytes directly, rather than relying on
what articles said about the format.

That was the right call. A web search claimed PNG stores C2PA in an `iTXt`
chunk. The real file showed a **`caBX`** chunk, with `iTXt` holding something
else entirely (XMP). The specification confirmed `caBX`. Had we trusted the
search result, the PNG support would have been wrong from the start.

**Findings:**

- PNG keeps the manifest in a `caBX` chunk.
- JPEG keeps it in one or more `APP11` segments.
- Both are self-contained blocks that can simply be dropped.
- **This makes removal lossless.** No canvas redraw, no re-compression.
- `c2pa-js` can read and validate credentials but offers no way to remove them,
  so it was not used. Written up in `docs/FEASIBILITY.md` §7.

**Decision:** write the container handling by hand. No dependencies, no build
step, and the part that matters is testable against real files.

## Milestone 2: The processing engine

Built format detection, PNG/JPEG/WebP container parsing, a JUMBF box reader,
the inspector and the remover.

**Verified:** ran real signed images through it and confirmed with
**ImageMagick** that the output had zero differing pixels, unchanged
dimensions, and no credentials left. Confirmed by hash that the originals were
untouched.

**A real bug, caught here:** a manifest too large for one JPEG segment is split
across several, and the reader was only reading as far as the first. Found only
because the test used a real signed file rather than one we had built
ourselves. Fixed by reassembling the pieces before reading, after confirming
the exact splitting rule from the real file's bytes.

## Milestone 3: The extension

Built the service worker, image loader, DOM detector, overlay, panel, popup,
settings and packaging.

Two design decisions worth recording:

- **Nothing is inserted into ChatGPT's own elements.** ChatGPT is a React
  application and would tear our controls out when it re-renders. Controls live
  in a separate layer positioned over the images instead.
- **Everything is in a shadow root**, so ChatGPT's styling cannot affect our
  controls and ours cannot affect their interface.

## Milestone 4: Testing

Unit tests all passing, 13 of them against real signed images.

Then, unexpectedly, a **real browser test**: Chromium is available in this
environment, so the extension is loaded into it for real, with `chatgpt.com`
pointed at a local server serving a reconstruction of ChatGPT's markup. 37
checks, covering the whole workflow from button to downloaded file.

**Two more real bugs, both found here, both would have shipped:**

1. **The panel vanished when the page scrolled.** Controls hide when their
   image leaves the screen, which is right for small buttons and wrong for a
   panel someone is reading. Fixed: panels stay on screen and are clamped into
   view.

2. **The panel closed itself the instant a file downloaded.** Downloading works
   by clicking a hidden link; that click travelled up the page and the panel
   read it as "clicked away", closing before the success message appeared.
   Fixed by containing the click.

A usability problem was also found and fixed: on a long report the action
buttons sat below the fold, so the panel's action row is now pinned to the
bottom.

## Milestone 5: Live confirmation, simplification and a real bug fix

**5 October 2026.**

The product owner installed version 0.1.0 in Chrome and ran it against the real
ChatGPT. The button appeared on a generated image and Content Credentials were
correctly detected. That closed the one gap the build could not close itself.

Two problems came out of that first real use.

### The service worker was throwing on every install

`chrome://extensions` showed an error:

> Uncaught (in promise) TypeError: import() is disallowed on
> ServiceWorkerGlobalScope by the HTML specification.

The cause was a dynamic `await import('../shared/constants.js')` inside the
`onInstalled` handler. Dynamic import is forbidden in a service worker.

The fix was small because the architecture was already right: the worker is
declared `"type": "module"`, and two static imports at the top of the file were
working fine. The two names the handler needed were folded into one of them and
the dynamic import deleted. No manifest change, no new architecture, nothing
suppressed.

The handler had been failing silently in the sense that the extension still
worked, but the default settings were never seeded on install. The test for
this now checks exactly that: after a fresh install, the defaults must be in
storage, which can only happen if the handler ran to its end.

### The panel was a developer tool, not a consumer one

It showed the manifest contents, the assertion labels, the signer, the
verification checks and three paragraphs of caveats. It was 506px tall and
scrolled. It also asked for confirmation twice.

Rewritten to show one status line, three facts (format, size, filename) and one
button. 392px wide, 256px tall, no scrolling. The second confirmation is gone
entirely: the labelled button is the confirmation, and since the original image
is never modified, the action is not destructive.

One short line of caveat was kept, carrying the single fact most often got
wrong: that removing metadata does not touch watermarks inside the picture.
Everything else technical was removed.

The browser test grew from 37 checks to 58, and now asserts the absence of the
technical sections as explicitly as it asserts the presence of the three facts,
so the panel cannot quietly grow back into an inspector.

## Milestone 6: Final UI polish

**5 October 2026.**

The panel was still taller than it needed to be, and could open behind
ChatGPT's message composer when the image sat low on screen.

### Compacted

Trimmed padding, gaps and type sizes, and moved the one caveat line out of the
default view. The panel is now **378 x 208px** where it was 332 x 506px at the
start of the day. It matches the target layout exactly: a status line, three
facts, one button.

The caveat about watermarks moved into the success state, where someone is most
likely to assume their image is now untraceable. It costs nothing in the
default panel and still appears at the moment it matters.

### Positioned properly

The panel now measures the space available and chooses: below the image when it
fits, above when it does not, clamped into the viewport either way.

"Below" accounts for anything pinned to the bottom of the window. Rather than
look for ChatGPT's composer by selector, which would be one more brittle thing
to maintain, it asks the browser what is actually painted at the bottom of the
window and treats anything fixed and wide as an obstacle. That works on any
site and survives any redesign.

### A real bug, caught by testing the positioning

The first run put the panel 1px over the composer. The cause was worse than the
symptom: the panel was being positioned **before its content was built**, so
the decision about whether it fit below was made using the height of an empty
panel.

Fixed with a ResizeObserver on the panel, which also covers the height changing
between the ready, working and saved states. The explicit reposition after
build keeps the first paint from visibly jumping.

## Milestone 8: The Gemini retrieval fix

**5 October 2026.** A real Gemini image reported "No supported credentials
found". Detection was working: the button appeared and the panel opened. The
problem was upstream of the credential engine.

### Ruling things out first

Two hypotheses were worth testing before touching any code.

**Was the WebP path wrong?** Google serves a lot of WebP, and WebP was the one
format whose chunk identifier had never been checked against anything
authoritative. Resolved by reading the C2PA reference implementation's own
source: `riff_io.rs` defines the chunk as `[0x43,0x32,0x50,0x41]`, which is
ASCII `C2PA`, exactly what this extension uses. The same file confirmed PNG's
`caBX`. So the format handling was not at fault, and WebP's status improved
from "implemented from spec" to "identifier confirmed against the reference".

**Were we reading the original file?** This turned out to be it.

### Root cause

Google serves images through a resizing CDN. The address in the page carries an
options string such as `=w526-h296-rw`, and the CDN re-encodes the image to
match. A re-encoded copy carries none of the original's C2PA manifest, so
inspecting it reports nothing found however correct the engine is.

### Fix

The Gemini adapter rewrites the options to `=s0`, asking for the original, and
offers it as the first candidate address. The page's own address is always kept
as a fallback, so a wrong guess degrades to the previous behaviour instead of
breaking retrieval. Grok's existing full-size rewrite moved to the same
contract.

The browser test reproduces the failure rather than describing it: the mock
page shows a stripped derivative and serves the signed original only at `=s0`,
so the test cannot pass unless the adapter really asks for the original.

### A diagnosis, because this will happen again

"No supported credentials found" has three causes that look identical: the file
really has none, we read a re-encoded copy, or our parser missed them. The
first is correct behaviour, the second is an adapter bug, the third is an
engine bug.

The extension now prints a diagnosis to the console whenever it finds nothing,
scanning the raw bytes for the markers a C2PA manifest cannot exist without. If
those bytes are present but no manifest was parsed, it says so explicitly and
names itself as the culprit. This turns a future report of this symptom into a
single console paste.

### One thing fixed along the way

A content-script fetch to a cross-origin CDN is subject to the page's CORS
rules and essentially always fails, and it printed an alarming CORS error in
the user's console before the service worker fallback quietly succeeded. Those
addresses now go straight to the worker, which removes a wasted request and the
noise.

## Where things stand

**Working and verified:**

- Inspecting and removing credentials in PNG and JPEG, losslessly.
- Independent confirmation of losslessness (ImageMagick, zero differing pixels).
- The complete workflow in a real browser, through to a verified download.
- 119 unit tests, 64 ChatGPT browser checks and 61 four-platform checks, all passing.
- Minimum permissions, checked against the code automatically.

**Implemented but not verified:**

- **WebP removal.** No real C2PA-signed WebP could be found to test against.
  Written from the specification and passing our own tests only.

**Confirmed on the live site:**

- Detection and inspection were verified by the product owner against the real
  ChatGPT on 5 October 2026.

**Still only tested against a reconstruction:**

- The removal-and-download path on the live site, and behaviour across many
  different conversation layouts.

**Deliberately not built:**

- Signature validation. `c2pa-js` could do it but would roughly double the
  extension's size for a feature nobody asked for. The product therefore never
  claims a credential is valid, only that one is present.

## Milestone 9: Gemini, second and third attempts

**5 October 2026.** Two wrong answers before the right one, both ruled out by
evidence from the live site rather than by reasoning.

### Attempt 1: rewrite the address. Wrong.

The theory was that Google's resizing CDN served a re-encoded derivative, so
the adapter asked for `=s0`, the original. The diagnosis from a real image
showed `Addresses tried: Array(1)` and an address of
`blob:https://gemini.google.com/...`. There was no CDN address to rewrite. The
fix never ran.

### Attempt 2: find the original in the markup. Wrong.

If the `<img>` only has a blob, the original's address might be nearby, behind
a download link. A DOM dump on the live page returned `"links": []` and
`"attrs": []`. Gemini keeps no address for the original anywhere in the page.

### What the evidence actually said

The blob held a JPEG whose only segments were a JFIF header, one quantisation
segment, a frame header and four Huffman tables. No EXIF, no XMP, no APP11.
The single 130-byte quantisation segment is the giveaway: a canvas encode emits
one combined segment where a tool like ImageMagick emits two.

So the page downloads the picture, draws it to a canvas, and displays the
canvas output. The credentials are destroyed inside the page, before the
extension exists as far as that image is concerned.

### Attempt 3: watch what the page downloads

The page has to fetch the picture before it can re-encode it. A script in the
page's own JavaScript world now records the addresses of image responses, and
the extension asks for that list when inspecting a blob-backed image.

Patching a host page's `fetch` and `XMLHttpRequest` is the most intrusive thing
this extension does, so it is bounded hard: injected only on Gemini, never
blocks or rewrites anything, never reads a response body, records addresses
only, and every wrapper falls through to the original on any error. ChatGPT
does not get it at all.

Recovered addresses are checked against the image on screen before use, same
aspect ratio and at least as many pixels, because processing the wrong picture
would be worse than failing.

### The test reproduces it rather than describing it

The mock Gemini page downloads the signed file, draws it to a canvas and shows
the result from a blob, with no link or attribute anywhere holding the
original's address. The test asserts the displayed bytes really have no EXIF
or APP11 segment, so finding credentials cannot be coming from the blob. A
wrong-shaped decoy is downloaded too, and must be refused.

### Still unknown

Whether the file Gemini downloads carries C2PA at all. If Google hands the
browser an already-stripped image then nothing with credentials ever reaches
it, and "no supported credentials found" is the correct answer rather than a
bug. One file downloaded with Gemini's own button would settle it.
