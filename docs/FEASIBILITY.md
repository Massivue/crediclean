# Feasibility report

Written 4 October 2026, before and during the build of version 0.1.0.

## The short answer

**It works, and better than expected.** Removing C2PA Content Credentials from
an image inside a Chrome extension is not only possible, it can be done
**losslessly**, with no loss of quality at all, using plain JavaScript and no
third-party library.

That last point surprised us. We expected to have to redraw the image onto a
canvas, which would have re-compressed it and degraded quality. That turned out
to be unnecessary, and we did not do it.

One important limit, stated here because everything else in this document
depends on it being understood:

> Removing this metadata removes a **label** saying where the image came from.
> It does not remove any **invisible watermark** that may be present in the
> pixels of the image itself. We cannot see those, and we cannot remove them.
> Nothing this extension does makes an image "undetectable as AI".

## How the removal works, in plain terms

Think of an image file as a filing cabinet with labelled drawers. One drawer
holds the actual picture. Other drawers hold notes about the picture: who made
it, when, with what tool.

Content Credentials live in their own drawer. To remove them, you take that one
drawer out and close the cabinet. You never open the drawer with the picture in
it, so the picture cannot be damaged.

This is why there is no quality loss. We are not editing a photo. We are
removing a labelled block of bytes from a file and copying everything else
across untouched.

The alternative approach, which we rejected, is like photocopying the whole
document to lose the notes: it works, but the copy is slightly worse than the
original every time.

## The twelve questions

### 1. How are generated images shown in ChatGPT?

As ordinary `<img>` elements in the conversation, pointing at a web address.
The addresses come in two shapes:

- `https://chatgpt.com/backend-api/estuary/content?id=file-…` (same site)
- `https://…oaiusercontent.com/…` (OpenAI's file servers)

These addresses are **signed and short-lived**. They are meant for use while
you are looking at the conversation, and they stop working after a while. That
is fine for us, because we read the image at the moment you click the button.

**Confidence:** reasonably high, from OpenAI's own documentation and multiple
secondary sources. **Not confirmed by us against a live logged-in ChatGPT**,
because this build environment has no ChatGPT account. See the gap at the end.

### 2. What can a content script actually reach?

The `src` and `srcset` attributes of the image, which give us the address. From
there we fetch the file itself.

We take the **largest** address offered in `srcset`, not whatever the browser
chose to display. Otherwise, on a small window, we could hand you a shrunken
copy of your own image.

### 3. Can we get the real file, not a screenshot?

**Yes, and this matters more than anything else in this report.**

There are two ways to get an image from a web page:

- **Read the pixels off the screen** (a canvas snapshot). This gives you a
  picture, but all metadata is already gone, and the result is re-compressed.
  You could never prove anything was removed, because it was never there.
- **Download the file from its address.** This gives you the real file, byte
  for byte, metadata and all.

We do the second. Every claim in this product depends on it.

**Verified.** Our tests download real files and compare them byte for byte.

### 4. What permissions are needed?

Fewer than expected:

| Permission | Why |
|---|---|
| `storage` | Remember three settings. |
| `chatgpt.com`, `chat.openai.com` | Show buttons, read images. |
| `*.oaiusercontent.com` | ChatGPT serves image files from here. |

Notably **not** needed:

- **`downloads`** — saving a file through an ordinary link click needs no
  special permission.
- **`tabs`** — the popup can tell whether you are on ChatGPT using only the
  site permissions above.

### 5. Can this work without sending images to a server?

**Yes. Verified.** All reading and processing is plain JavaScript running in
your browser. The extension's only network request is downloading the image you
clicked on, from OpenAI. There is no CrediClean server.

### 6. Which formats and credential types are supported?

| Format | How credentials are stored | Status |
|---|---|---|
| PNG | a `caBX` chunk | **Verified** against real signed files |
| JPEG | one or more `APP11` segments | **Verified** against real signed files |
| WebP | a `C2PA` chunk | **Implemented from the specification, not verified** |

We could not find a real C2PA-signed WebP anywhere to test against. The code
follows the written standard and passes our own constructed tests, but we have
not proved it against a file signed by somebody else. It is labelled that way
in the product and in `docs/TESTING.md`.

GIF, AVIF, HEIC, TIFF and SVG are detected and politely refused. They are
**never** reported as "no credentials found", because we did not look.

### 7. Which libraries can read C2PA?

The main one is `c2pa-js` from the Content Authenticity Initiative.

**We chose not to use it, and here is the honest reason.** `c2pa-js` reads and
*validates* credentials. It is built to answer "is this genuine?". It does not
offer a function to *remove* a manifest, because removal is the opposite of
what it exists for. It is also heavy: it ships a WebAssembly binary, which adds
complications under Chrome's extension security rules.

So it would have added size and complexity while not doing the one thing we
need. We wrote the container handling ourselves instead: about 600 lines, no
dependencies, and the part that matters is verified against real files.

**The cost of that choice, stated plainly:** we can see that a credential is
*present* and read its labels. We **cannot** check whether its digital
signature is valid. So CrediClean never tells you a credential is genuine or
trustworthy. It only tells you one is there.

### 8. Is reliable removal actually possible in a browser?

**Yes, and it is verified.** For each format we parse the container, drop the
blocks holding the credential, and copy everything else through unchanged.

Our strongest evidence is independent. We ran real signed images through the
extension's code and then compared the result against the original using
**ImageMagick**, a long-established image tool that is nothing to do with us:

```
exp-test1.png  5,884,439 -> 2,444,293 bytes   differing pixels: 0
CA.jpg           166,864 ->    49,591 bytes   differing pixels: 0
C.jpg            132,518 ->    86,634 bytes   differing pixels: 0
```

Zero differing pixels, with the credentials gone and the file much smaller.
That is what lossless means, measured by a third party.

### 9. Can the result be checked independently?

Yes, and the extension does it automatically on **every** removal, before
offering you the file. Four checks:

1. the output is still a valid file of the same type;
2. a fresh scan of the output finds no credentials;
3. the width and height are unchanged;
4. the compressed picture data is **byte-for-byte identical** to the original.

Check 4 is the important one. If a single byte of picture data had changed, the
image would have been re-encoded and quality could have suffered. If any check
fails, the file is thrown away and you are told, rather than handed a file we
cannot stand behind.

You can also verify any image yourself at
[contentcredentials.org/verify](https://contentcredentials.org/verify).

### 10. What if the image has no credentials?

You are told exactly that, and the removal button is not offered. There is
nothing to remove, so nothing is removed, and we do not pretend otherwise.

The wording is careful on purpose: **"no supported credentials found"**, not
"this image is clean". We only know what we looked for and did not find.

### 11. What about very large images?

Processing is byte copying, so it is fast even for large files. The practical
limit is memory, since the file is held a few times over.

We warn above 25 MB and refuse above 64 MB rather than risk freezing the tab.
The largest file we tested was 5.9 MB and processed instantly.

### 12. What should users be told?

Four things, and all four appear in the product itself:

1. Removing credentials removes information about where the image came from.
2. It does **not** remove invisible watermarks in the pixels.
3. "No credentials found" is not proof an image was made by a person.
4. We check a credential is present. We do not check that it is valid.

## What we verified, and what we did not

### Verified, with evidence

- C2PA detection and removal in PNG and JPEG, against real signed files.
- Removal is lossless: zero differing pixels, confirmed by ImageMagick.
- Manifests split across several JPEG segments are read and removed in full.
- The original file is never modified (checked by hash against a fresh download).
- The extension loads in Chromium with no manifest errors.
- Buttons appear on generated images and not on avatars or toolbar icons.
- The full click-to-download workflow produces a clean, valid, correctly sized file.

### Implemented but not verified

- **WebP credential removal.** No real signed WebP sample could be found.
- **The exact ChatGPT page structure.** See below.

### The real remaining gap

**We have not run this against the live ChatGPT website.** This build
environment has no ChatGPT account, so we could not log in.

Everything the extension does *after* it has an image is verified thoroughly.
What is not verified is the first step: whether our rules for spotting a
generated image match the real ChatGPT page today.

We reduced that risk as far as we could:

- The detection rules avoid CSS class names entirely, because ChatGPT's class
  names are machine-generated and change constantly.
- They use three independent signals (the address, the size, and where the
  image sits), so one change does not break everything.
- All of it lives in one file, `src/content/image-detector.js`, with a comment
  at the top saying so.
- A browser test runs the extension against a reconstruction of ChatGPT's page
  structure, so the machinery is proven even though the real markup is not.

**This is the one thing that needs a human to check.** The steps are in
`docs/TESTING.md` and should take about five minutes.
