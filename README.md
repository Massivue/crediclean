# CrediClean

A Chrome extension that lets you inspect, and remove, the Content Credentials
embedded in AI-generated images, without leaving the page.

Works on **ChatGPT, Google Gemini, Microsoft Copilot and Grok**.

Version 0.2.0. Free, open source, no account, no server.

---

## Platform support, honestly

| Platform | Status |
|---|---|
| **ChatGPT** | **Working**, confirmed on the live site |
| **Gemini** | **Working**, confirmed on the live site |
| **Copilot** | Built and tested against a reconstruction, **not yet confirmed live** |
| **Grok** | **Working**, confirmed on the live site |

The credential engine is shared by all four and is verified against real signed
files. The open question for the three unconfirmed platforms is whether the
extension spots their images, not whether it can process them. Full detail is
in [docs/FOUR_PLATFORM_SUPPORT.md](docs/FOUR_PLATFORM_SUPPORT.md).

## What it does

These tools embed **Content Credentials** in the images they generate. These are a
block of hidden data inside the image file recording that it was made by AI,
when, and with what. They follow a standard called C2PA.

Normally, removing that data means downloading the image, opening another
program, processing it, and downloading it again.

CrediClean puts a small button on the image inside ChatGPT. Click it and you
see what the image actually contains. If you want, save a copy with the
credentials removed. The copy is **pixel-for-pixel identical** to the original:
nothing is re-compressed and no quality is lost.

## What it does not do, and will not claim

This matters, so it is near the top rather than buried at the bottom.

- **It does not remove invisible watermarks.** Some AI images carry a signal
  hidden in the pixels themselves. Google's **SynthID** on Gemini images is the
  clearest example: it survives metadata removal, screenshots and cropping.
  CrediClean removes metadata only. It cannot see such signals and cannot
  remove them. A processed Gemini image still carries its SynthID watermark,
  and that is expected, not a failure.
- **It does not make an image undetectable as AI-generated.** It never will,
  and the product never says otherwise.
- **"No credentials found" is not proof an image was made by a person.** It
  means this version did not find any, in the places it knows to look.
- **It does not check whether a credential is genuine.** It tells you one is
  there and what it says. It does not verify the digital signature, so it never
  describes a credential as valid or trustworthy.

Removing Content Credentials removes information about where an image came
from. That is the point of the tool, and it is worth being deliberate about.

## Features

- Finds generated images in a ChatGPT conversation, including ones that stream
  in after the page has loaded.
- Adds a small, unobtrusive button to each one. Light and dark themes.
- Shows a compact panel with what you need: whether credentials were found,
  plus the image's format, dimensions and filename. Nothing technical.
- Positions itself sensibly: below the image when there is room, above it when
  there is not, and never behind ChatGPT's message box.
- Removes supported credentials **losslessly** and saves a copy, from a single
  button press. There is no second confirmation.
- Checks its own work before giving you the file, and discards it if a check fails.
- Leaves your original image completely untouched.
- Three settings, no account, no analytics.

## Supported formats

| Format | Credential support | Status |
|---|---|---|
| PNG | `caBX` chunk | Verified against real signed files |
| JPEG | `APP11` segments, including manifests split across several | Verified against real signed files |
| WebP | `C2PA` chunk | Chunk identifier **confirmed against the C2PA reference implementation**; still not tested on a real signed WebP |

GIF, AVIF, HEIC, TIFF and SVG are recognised and refused. They are never
reported as having no credentials, because they were not inspected.

Alongside the credential itself, CrediClean also removes an XMP metadata block
when that block points at the credential being removed, since leaving a
signpost to something that is gone is both misleading and an incomplete job.
This is itemised in the result, and can be switched off in settings.

## Installing it

CrediClean is not on the Chrome Web Store. Install it from these files:

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Switch on **Developer mode**, top right.
4. Click **Load unpacked**.
5. Select the `crediclean` folder, the one containing `manifest.json`.

The CrediClean icon appears in your toolbar. Pin it for easy access.

To check it works, open ChatGPT, find a conversation with a generated image and
look for the small **CC** button on the image.

## Using it

1. Open a ChatGPT conversation containing an image.
2. Hover over the image. A small **CC Inspect credentials** button appears at
   the bottom left.
3. Click it. Within a second or two a panel shows what the image contains.
4. If credentials were found, click **Remove credentials & save**. The image
   is processed straight away, with no second confirmation.
5. The processed file saves to your downloads folder as `name-processed.png`,
   and the panel confirms it.

Your original image in ChatGPT is never changed.

You can also choose **Save unchanged copy** to download the file exactly as it
is, credentials and all.

## Settings

Click the CrediClean icon in the toolbar. The popup shows which site you are
on, links to the supported ones, and three settings.

| Setting | Default | What it does |
|---|---|---|
| Enable on ChatGPT | On | The master switch. |
| Show buttons on images | On | Hide the on-image buttons but keep the extension loaded. |
| Also remove linked XMP data | On | Remove an XMP block that points at the credential. Other XMP fields in the same block, such as author or caption, go with it. |

## Privacy

Your images never leave your computer. There is no CrediClean server, no
account system and no analytics.

The only network request the extension makes is downloading the image you
clicked on, from OpenAI's servers, which your browser has already done anyway.

Full detail is in [PRIVACY.md](PRIVACY.md).

### Permissions, and why

| Permission | Why |
|---|---|
| `storage` | Remember the three settings above. |
| `chatgpt.com`, `chat.openai.com` | Show buttons and read your images. |
| `*.oaiusercontent.com` | ChatGPT serves image files from here. |

It does not request access to your browsing history, your other tabs, your
cookies or any other website. It does not request the `downloads` permission.

## How the lossless removal works

An image file is a container holding separate labelled blocks. One block holds
the compressed picture. Others hold notes about it. Content Credentials live in
their own block.

CrediClean removes that one block and copies every other byte across unchanged.
The picture data is never decoded, re-encoded or touched, which is why there is
no quality loss.

The obvious alternative, redrawing the image to strip metadata, would
re-compress it and lose a little quality every time. CrediClean does not do
that, and the tests prove it: the compressed picture data in the output is
byte-for-byte identical to the input.

Before handing you a file, the extension re-reads its own output and checks
four things: that it is still a valid image, that no credentials remain, that
the dimensions are unchanged, and that the picture data is byte-identical. If
any check fails the file is discarded and you are told. You can see these
checks in the panel after every removal.

## Known limitations

1. **Not tested on the live ChatGPT website.** The extension was built and
   verified against real signed image files and in a real browser, but the
   developer had no ChatGPT account. If the button does not appear, the
   detection rules need a small update: see
   [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
2. **WebP support is unverified.** Written from the specification; no real
   C2PA-signed WebP could be found to test against.
3. **No signature validation.** Presence and contents only.
4. **ChatGPT's page structure can change at any time** and break detection. All
   the fragile logic is isolated in `src/content/image-detector.js`.
5. **Images above 64 MB are refused**, and above 25 MB you get a warning.
6. **Metadata only.** Invisible watermarks are out of reach.

## Testing

```bash
npm test                 # 112 unit tests
npm run fetch-samples    # download real C2PA-signed images
npm test                 # now includes tests against those real files
npm run test:e2e         # 64 ChatGPT checks in a real Chromium
npm run test:platforms   # 59 checks across all four platforms
npm run verify           # check the manifest matches the code
```

Full results, honestly labelled, are in [docs/TESTING.md](docs/TESTING.md).

## Updating the extension

After changing any file:

1. Go to `chrome://extensions`.
2. Click the reload arrow on the CrediClean card.
3. **Refresh any open ChatGPT tabs.** Reloading an extension disconnects pages
   that are already open.

Run `npm test && npm run verify` before reloading. The verifier catches the
mistakes that are silent at load time, such as a file listed in the manifest
that does not exist.

## Packaging for the Chrome Web Store

```bash
npm run package
```

This verifies the manifest, runs the tests, and writes:

- `build/crediclean/` — the unpacked extension
- `build/crediclean-0.1.0.zip` — the file to upload

Only the files Chrome needs are included. Tests, scripts, sample images and
documentation are left out.

To submit, go to the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
pay the one-time registration fee if you have not already, create a new item
and upload the zip. You will need a description, at least one screenshot, and a
privacy policy. PRIVACY.md can serve as the basis for the last of these.

Be ready to justify each permission in the review. The reasons are in the table
above and in PRIVACY.md.

## Project layout

```
crediclean/
├── manifest.json              Extension configuration
├── src/
│   ├── background/            Service worker: fetches images, nothing else
│   ├── content/               Everything that runs on the ChatGPT page
│   │   └── image-detector.js  ← the fragile part; fix here if buttons vanish
│   ├── formats/               PNG, JPEG, WebP and JUMBF container handling
│   ├── processing/            Inspection, removal, verification, download
│   ├── popup/                 Toolbar popup
│   └── shared/                Constants, settings, messaging
├── tests/                     Unit tests, fixtures, and the browser test
├── scripts/                   Verification, packaging, sample fetching
└── docs/                      Feasibility, testing, troubleshooting, build log
```

There is no build step and no dependencies. The files you edit are the files
that run.

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or connected to OpenAI.
