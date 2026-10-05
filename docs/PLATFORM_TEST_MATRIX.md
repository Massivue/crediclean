# Platform test matrix

CrediClean 0.5.0, 5 October 2026.

Key: **PASS** tested and working. **BLOCKED** could not be tested here.
**NOT CONFIRMED** unknown. **NOT SUPPORTED** known not to work.

Nothing is marked PASS unless it was actually run.

## The headline

| Platform | Image detected | Original retrieved | C2PA detected | Processing | Download | Result |
|---|---|---|---|---|---|---|
| **ChatGPT** | PASS | PASS | PASS | PASS | PASS | **Working on the live site** |
| **Gemini** | PASS | PASS | PASS | PASS | PASS | **Working on the live site** |
| **Grok** | PASS | PASS | PASS | PASS | PASS | **Working on the live site** |

All three were confirmed end to end on their real websites by the product
owner on 5 October 2026: the button appears, credentials are detected, removal
runs on one click, and the processed file downloads.

Gemini took four attempts, because it serves a credential-free derivative in
the conversation and keeps the real original behind a separate address that
appears only in its API responses. See PLATFORM_SUPPORT.md.

Grok's live test also answered the question desk research could not: Grok
images do carry credentials this extension can read and remove. Until that
test, the product reported Grok's status as unknown rather than guessing.

## What was actually run

Every number below was produced by re-running the suite on the shipping
0.5.0 tree, not copied from an earlier run.

### 1. Credential engine, against real signed files — PASS

Independent of any platform. Real C2PA-signed images from the Content
Authenticity Initiative's own test repositories, verified with ImageMagick:

```
exp-test1.png  5,884,439 -> 2,444,293 bytes   differing pixels: 0
CA.jpg           166,864 ->    49,591 bytes   differing pixels: 0
C.jpg            132,518 ->    86,634 bytes   differing pixels: 0
```

This is the part shared by all three platforms, and it is the best-evidenced
part of the product.

### 2. Unit tests — 127 PASS, 0 fail

`npm test`. Includes per-platform address classification for all three
adapters, registry routing, the container parsers, the removal and
verification logic, and the rules deciding which pages of a site the extension
runs on and which images are large enough on screen to be content.

### 3. ChatGPT browser suite — 70 PASS, 0 fail

`npm run test:e2e`. The full regression suite in a real Chromium with the real
extension loaded. Covers detection, the panel, one-click removal, download,
positioning, both themes, the popup and the service worker.

### 4. Platform browser suite — 66 PASS, 0 fail

`npm run test:platforms`. The real extension in a real Chromium, against a
reconstructed page per platform served from that platform's real hostname.

| Check | ChatGPT | Gemini | Grok |
|---|---|---|---|
| Extension activates on the host | PASS | PASS | PASS |
| Exactly one button, on the generated image | PASS | PASS | PASS |
| Avatar correctly ignored | PASS | PASS | PASS |
| Panel shows Format / Size / File | PASS | PASS | PASS |
| Panel shows the real dimensions | PASS | PASS | PASS |
| Panel shows no technical detail | PASS | PASS | PASS |
| Finds the original behind a blob, nothing clicked | n/a | PASS | n/a |
| Credentials detected | PASS | PASS | n/a¹ |
| One-click removal downloads | PASS | PASS | n/a¹ |
| Output is a valid image | PASS | PASS | n/a¹ |
| Output has no credentials left | PASS | PASS | n/a¹ |
| Dimensions survive | PASS | PASS | n/a¹ |
| Reports "none found" honestly | n/a | n/a | PASS |
| Offers no removal when nothing to remove | n/a | n/a | PASS |
| Implies nothing was removed when nothing was | n/a | n/a | PASS |
| No page errors | PASS | PASS | PASS |

¹ Grok's test page deliberately serves an image with **no** credentials. That
is the case the product must not fake, so the test asserts the extension says
so plainly and offers nothing. Grok's real images do carry credentials, which
the live test confirmed separately.

### 4b. Page scope and in-app navigation, ChatGPT — 11 PASS, 0 fail

Part of the same suite. These cover the reported defect where the button
appeared on ChatGPT's GPT and plugin pages and then survived the trip back to
a conversation.

| Check | Result |
|---|---|
| A conversation gets exactly one button | PASS |
| The GPT/plugins page gets none, loaded directly | PASS |
| No store icon is even marked as handled | PASS |
| `pushState` away from a conversation removes the buttons | PASS |
| Nothing else we drew is left behind | PASS |
| `pushState` back brings the button back | PASS |
| The browser Back button is handled too | PASS |
| Opening settings over a conversation removes them | PASS |
| Closing settings brings them back | PASS |
| The panel still works after all that navigating | PASS |
| No page errors | PASS |

The store page in this suite is built to be the hard case: each GPT icon is a
512px file served from the same user-content host as a generated image, and is
drawn at 40px. Every rule except the drawn-size rule says "content".

**What this settles, and it is worth stating because the obvious approach is
wrong:** a content script cannot catch the page's own `history.pushState` by
patching it, because it runs in a separate JavaScript context and would only
be patching its own copy. These tests drive real `pushState` calls from the
page and show the extension reacting, which proves the mechanism that replaced
it actually works.

### 4c. The CC button — 7 PASS, 0 fail

| Check | Result |
|---|---|
| Small enough to sit on a picture (≤40px) | PASS |
| Still a comfortable click target (≥24px) | PASS |
| Square, so it reads as an icon | PASS |
| Shows the CC mark and no caption | PASS |
| Still tells a screen reader what it does | PASS |
| The tooltip is hidden until hovered | PASS |
| Hovering reveals "Inspect credentials" | PASS |

### 5. Manifest verification — PASS

`npm run verify` regenerates the host list from `src/platforms/` and fails if
the manifest and the adapters disagree. Current result: 10 host permissions,
3 platforms, 0 warnings.

## What is BLOCKED, and why

| Item | Status | Reason |
|---|---|---|
| Generate a real image on Gemini or Grok from here | **BLOCKED** | No accounts in this build environment |
| Inspect a real Gemini or Grok file's bytes | **BLOCKED** | Follows from the above |
| Confirm Gemini's image CDN host | **CONFIRMED** | The product owner's live test reached it |
| Confirm Grok's image CDN host | **NOT CONFIRMED** | No vendor documents it. The live test worked, but we did not capture which host served the bytes |
| Gemini original reachable from the DOM | **NOT SUPPORTED** | Confirmed absent: a live DOM dump returned no links and no attributes. The fix reads API responses instead |
| Read Google's own announcement pages | **BLOCKED** | The network here blocks those domains |
| WebP chunk identifier | **PASS** | Confirmed against the C2PA reference implementation's source |
| WebP removal against a real signed file | **BLOCKED** | No C2PA-signed WebP sample exists publicly |
| SynthID removal | **NOT SUPPORTED** | Deliberate. It is a pixel watermark, not metadata |
| ChatGPT's real route names | **NOT CONFIRMED FROM HERE** | The conversation and store addresses come from knowledge of the live site, not from a capture made in this environment. If OpenAI renames a section, the buttons stop appearing there until the list in `src/platforms/chatgpt.js` is updated |

## The honest summary

- **All three platforms work**, confirmed on their live sites.
- **Some individual facts are still inferences.** Which exact CDN host serves
  a Grok image, and whether WebP removal holds against a real signed WebP, are
  not confirmed. Neither blocks normal use.
- **No fake support was added.** Grok shipped as "unknown" until a real test
  proved otherwise.
- **No false claims.** Nothing in the UI promises watermark removal, and
  nothing claims an output is untraceable.

## What you can do to close the remaining gaps

Download one image from Gemini and one from Grok and send the files.
Inspecting the real bytes would convert the remaining "not confirmed" rows
into confirmed ones in a single pass.
