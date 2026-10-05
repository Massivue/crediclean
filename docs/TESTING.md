# Testing

Version 0.1.0. Last run 4 October 2026.

Every result below is labelled **Passed**, **Not tested** or **Blocked**.
Nothing is marked Passed unless it was actually run and actually passed.

## How to run the tests yourself

```bash
cd crediclean

npm test                   # 103 unit tests, no network, no browser
npm run fetch-samples      # download real C2PA-signed images (optional)
npm test                   # now 116, including 13 against those real files
npm run test:e2e           # 70 checks in a real Chromium with the extension loaded
npm run verify             # check the manifest against the code
```

`npm test` needs only Node 20 or newer. `npm run test:e2e` additionally needs
Playwright and the ability to listen on port 443.

## Summary

| Suite | Checks | Result |
|---|---|---|
| Unit tests (synthetic fixtures) | 103 | **Passed** |
| Unit tests (real signed images) | 13 | **Passed** |
| Browser tests, ChatGPT (real Chromium, extension loaded) | 70 | **Passed** |
| Browser tests, all three platforms | 48 | **Passed** |
| Independent check with ImageMagick | 3 images | **Passed** |
| Live websites (ChatGPT, Gemini, Grok) | — | **Passed**, by the product owner, not from this environment |

## 1. Installation

| Check | Result |
|---|---|
| Loads unpacked in Chromium with no manifest errors | **Passed** (browser test) |
| Background service worker starts | **Passed** (browser test) |
| Popup page opens and shows a status | **Passed** (browser test) |
| Popup shows the privacy statement | **Passed** (browser test) |
| Can be switched off and on | **Passed** for the setting itself; the live on/off behaviour on chatgpt.com is **Not tested** |

## 2. ChatGPT integration

Tested against a **reconstruction** of ChatGPT's page structure, not the real
site. See the limitation at the end.

| Check | Result |
|---|---|
| Buttons appear on generated images | **Passed** |
| No button on a small avatar image | **Passed** |
| No button on a large icon inside a toolbar button | **Passed** |
| Exactly one button per image, no duplicates | **Passed** |
| An image added after page load gets a button | **Passed** |
| Repeated scans do not create duplicates | **Passed** |
| Buttons hide when their image scrolls off screen, and come back | **Passed** |
| The page raises no JavaScript errors | **Passed** |
| Works on the real chatgpt.com | **Blocked** |

## 3. Reading the image

| Check | Result |
|---|---|
| The real file is fetched, not a screen capture | **Passed** |
| The clicked image is the one processed | **Passed** (two images on the page, each reported its own contents) |
| The largest address in `srcset` is preferred | **Passed** (unit test) |
| A failed fetch produces a readable message | **Passed** (unit test); **Not tested** in the browser |
| Cross-origin fetch via the service worker | **Not tested**: the mock server is same-origin, so only the direct path ran |

## 4. Inspecting metadata

| Check | Result |
|---|---|
| A real signed JPEG is detected correctly | **Passed** (`CA.jpg`, `C.jpg`) |
| A real signed PNG is detected correctly | **Passed** (`exp-test1.png`) |
| A real file with no credentials is reported correctly | **Passed** (`libpng-test.png`, `sample1.webp`) |
| A manifest split across JPEG segments is read in full | **Passed** |
| The signer is read out of the file, not guessed | **Passed**: read `Adobe_Photoshop/23.5.0 (build 20220720.m.1828 0ac45e5; mac)` and `make_test_images/0.33.1 c2pa-rs/0.33.1` from the real samples |
| An unreadable file is **not** reported as clean | **Passed** |
| An unsupported format is **not** reported as clean | **Passed** |
| A non-C2PA JUMBF box is not claimed as a credential | **Passed** |
| Signature validity is checked | **Not implemented by design**, and never claimed. See FEASIBILITY.md §7 |

## 5. Processing

| Check | Result |
|---|---|
| Removal verified independently | **Passed**: ImageMagick reported **0 differing pixels** on all three real signed images |
| The original file is never modified | **Passed**: SHA-256 of the original still matched a fresh download afterwards |
| The output opens as a valid image | **Passed** (ImageMagick `identify`) |
| Dimensions unchanged | **Passed**: 2048x1365, 1024x683 and 2048x1365 all preserved |
| Picture data byte-for-byte identical | **Passed**: 2,441,486 / 48,982 / 86,025 bytes matched exactly |
| Running removal twice is a no-op the second time | **Passed** |
| A corrupt file is refused, not half-processed | **Passed** |
| Verification failure discards the file | **Passed** (forced-failure test) |
| WebP removal against a real signed file | **Blocked**: no real signed WebP could be found |

### The ImageMagick result in full

```
exp-test1.png -> processed   5,884,439 -> 2,444,293 bytes   AE (differing pixels) = 0
CA.jpg        -> processed     166,864 ->    49,591 bytes   AE (differing pixels) = 0
C.jpg         -> processed     132,518 ->    86,634 bytes   AE (differing pixels) = 0
```

ImageMagick is not our code, so this is genuinely independent.

## 6. Downloading

| Check | Result |
|---|---|
| A real download happens on click | **Passed** (browser test captured the file) |
| The filename ends in `-processed.png` | **Passed** |
| The extension matches the real format, not the URL | **Passed** (unit test) |
| The downloaded bytes contain no credentials | **Passed** |
| Success is reported only after the file exists | **Passed** |
| Nothing downloads without a click | **Passed** by design; no automatic download path exists |
| An unchanged copy is clearly labelled as still containing credentials | **Passed** (unit-level copy; **Not tested** in the browser) |

## 7. Privacy

| Check | Result |
|---|---|
| No image is sent anywhere | **Passed**: the only `fetch` calls in the codebase target the image address |
| No analytics or third-party requests | **Passed**: no such code exists |
| Permissions match what the code uses | **Passed** (`npm run verify`) |
| No remote code is loaded | **Passed**: every file is in the package |
| The service worker cannot fetch outside the permitted hosts | **Passed** (allowlist checked against the manifest by `npm run verify`) |

## 8. Usability and accessibility

| Check | Result |
|---|---|
| Dark theme detected and applied | **Passed** (screenshot reviewed) |
| Light theme | **Passed** (screenshot reviewed, and asserted in the browser test) |
| Panel is compact: 378x208px, no scrolling | **Passed** |
| Panel opens below the image when there is room | **Passed** |
| Panel flips above the image when there is not | **Passed** |
| Panel never sits behind the page's message box | **Passed** |
| Panel stays fully inside the viewport | **Passed** |
| Action buttons reachable without scrolling | **Passed**: this failed on the first run and the action row was made sticky to fix it |
| An open panel survives scrolling | **Passed**: this failed on the first run and was fixed |
| Keyboard focus rings | **Not tested** |
| Screen reader behaviour | **Not tested** |
| Narrow windows | **Not tested**: a CSS rule hides the button text below 640px, but it was not exercised |

## Bugs this testing found and fixed

Both were found by the browser test and would have shipped otherwise.

1. **The result panel disappeared when the page scrolled.** Controls were
   hidden once their image left the screen, which was right for the small
   buttons but wrong for an open panel. A small scroll while reading the report
   made it vanish. Panels are now kept on screen.

2. **The panel closed itself the moment a file downloaded.** Saving a file
   works by clicking an invisible link. That click travelled up the page and
   the panel treated it as "the user clicked away", so it closed before showing
   the success message and the verification results. The click is now contained.

A third issue, found during development, was in the credential reading itself:
a manifest split across two JPEG segments was only being read as far as the
first segment. It was caught by testing against a real signed file rather than
one we had built ourselves, which is the reason those tests exist.

## Confirmed on the live site

**Version 0.1.0 was installed in Chrome and run against the real ChatGPT**, by
the product owner. The button appeared on a generated image, the panel opened,
and Content Credentials were correctly detected. That closes the gap this
section previously described.

What is still only tested against our reconstruction of ChatGPT's markup is the
full removal-and-download path on the live site, and behaviour across many
different conversation layouts.

## The limitation that matters most

The detection rules are matched against a page we do not control and which can
change without notice.

Please run these five manual checks:

1. Load the extension (see the README).
2. Open ChatGPT and find or create a conversation with a generated image.
3. **Does a small "CC Inspect credentials" button appear on the image?**
   If not, the detection rules need updating: everything else is working.
4. Click it. It should report what the image contains within a second or two.
5. If credentials were found, remove them and save. Then upload the saved file
   to [contentcredentials.org/verify](https://contentcredentials.org/verify)
   and confirm it reports no credentials, and that the picture still looks right.

Also worth checking: that the button does not appear on your profile picture,
and that ChatGPT itself still behaves normally.

If step 3 fails, that is the expected failure and it is fixable. The file to
change is `src/content/image-detector.js`, and `docs/TROUBLESHOOTING.md`
explains what to look at.
