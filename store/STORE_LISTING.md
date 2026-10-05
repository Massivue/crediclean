# Chrome Web Store listing

Everything needed to submit CrediClean. Copy the text straight into the
developer console. Screenshots are in `store/screenshots/`, already 1280x800.

---

## Item name

```
CrediClean
```

## Short description (132 characters maximum)

```
Inspect and remove Content Credentials from AI images in ChatGPT, Gemini and Grok. Lossless, private, one click.
```

(112 characters.)

## Category

Productivity

## Language

English

---

## Full description

```
CrediClean shows you what provenance data an AI-generated image is carrying,
and lets you save a copy without it, without ever leaving the page.

HOW IT WORKS

Generate an image in ChatGPT, Google Gemini or Grok. A small CC button appears
on it. Click it and CrediClean tells you the format, the size, the filename,
and whether the image carries Content Credentials. If it does, one click saves
a copy with them removed.

LOSSLESS

The image is never redrawn or re-compressed. These formats store the picture
and the metadata in separate blocks, so CrediClean removes one block and copies
every other byte across untouched. Your saved copy is pixel for pixel identical
to the original. Verified against real signed images with an independent tool:
zero differing pixels.

PRIVATE

Everything happens in your browser. Your images, prompts and conversations are
never uploaded. There is no account, no server and no analytics. The only
network request CrediClean makes is downloading the image you clicked on, from
the site you are already looking at.

WHAT IT DOES NOT DO

It removes metadata. It does not remove invisible watermarks carried in the
pixels of an image, and it cannot make an image undetectable as AI-generated.
An image with no credentials is not proof that a person made it.

Removing Content Credentials removes information about where an image came
from. CrediClean is deliberately clear about that rather than hiding it.

SUPPORTED

ChatGPT, Google Gemini and Grok.
PNG, JPEG and WebP images.

OPEN SOURCE

Source code, tests and full documentation:
https://github.com/Massivue/crediclean
```

---

## Privacy

**Single purpose**

```
CrediClean inspects the Content Credentials embedded in AI-generated images and
lets the user save a copy with those credentials removed. That is its only
function.
```

**Privacy policy URL**

```
https://github.com/Massivue/crediclean/blob/main/PRIVACY.md
```

**Data usage declarations**

Tick nothing. CrediClean collects no user data of any kind. Confirm all three
certifications: no selling data, no unrelated use, no use for creditworthiness.

---

## Permission justifications

Reviewers ask for each one separately. These are the answers.

### `storage`

```
Stores three user preferences: whether the extension is enabled, whether to
show buttons on images, and whether to remove XMP metadata that references the
credential. No user content or personal data is stored.
```

### Host permission: `chatgpt.com`, `chat.openai.com`

```
The extension runs only on supported AI image sites. It needs to read the page
to find generated images and attach its button, and to fetch the image file the
user clicks on so it can read the credentials inside it.
```

### Host permission: `gemini.google.com`

```
Same as above, for Google Gemini.
```

### Host permission: `grok.com`, `x.com`

```
Same as above, for Grok, which is reachable at both addresses.
```

### Host permission: `*.oaiusercontent.com`

```
ChatGPT serves generated image files from this domain. The extension must fetch
the file from here to read its credentials. Reading the image shown on screen
is not sufficient, because the browser discards metadata when it renders an
image.
```

### Host permission: `*.googleusercontent.com`, `usercontent.google.com`

```
Google serves Gemini image files from these domains. Gemini displays a resized
copy with the credentials already removed, so the extension must fetch the
original file from here to read them.
```

### Host permission: `assets.grok.com`, `pbs.twimg.com`

```
Grok serves generated image files from these domains. The extension must fetch
the file from here to read its credentials.
```

### Remote code

```
No. All code is included in the package. Nothing is fetched or evaluated at
runtime.
```

### Scripting in the page's own context

Only asked if the reviewer notices the `MAIN` world content script.

```
A small script runs in the page's own context on gemini.google.com only. Gemini
displays a resized copy of a generated image, and the address of the original
is never placed in the page. The script observes the addresses of image
downloads the page itself makes, so the extension can read the original rather
than the resized copy.

It only records addresses. It never blocks, delays, redirects or alters any
request, never reads a response body, and never transmits anything. Without it,
the extension cannot function on Gemini.
```

---

## Screenshots

In `store/screenshots/`, all 1280x800.

| File | Caption |
|---|---|
| `1-button.png` | One small button appears on generated images |
| `2-panel.png` | See the format, size and whether credentials are present |
| `3-saved.png` | One click removes them and saves a copy |
| `4-popup.png` | Three settings. Nothing else |

Upload at least `2-panel.png` and `3-saved.png`; those show the actual value.

---

## Before you submit

- [ ] `npm test`, `npm run test:e2e`, `npm run verify` all pass
- [ ] `npm run package` produces a fresh zip
- [ ] The version in `manifest.json` is higher than any previous submission
- [ ] `PRIVACY.md` is reachable at the URL above
- [ ] The description makes no claim about defeating AI detection

## An honest note on review

CrediClean removes provenance metadata from AI images. No Chrome Web Store
policy forbids that, and metadata tools are common on the store. But a reviewer
may still look twice, so two things matter:

1. **Lead with inspection.** That is genuinely what the extension does first,
   and the listing above is written that way.
2. **Never claim it defeats AI detection.** It would be untrue, and it is the
   claim most likely to cause a problem.

Approval is not guaranteed. If it is refused, GitHub Releases still reaches
anyone willing to install an unpacked extension.
