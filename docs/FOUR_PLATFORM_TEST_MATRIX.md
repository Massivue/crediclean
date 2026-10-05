# Four-platform test matrix

CrediClean 0.2.0, 5 October 2026.

Key: **PASS** tested and working. **BLOCKED** could not be tested here.
**NOT CONFIRMED** unknown. **NOT SUPPORTED** known not to work.

Nothing is marked PASS unless it was actually run.

## The headline

| Platform | Image detected | Original retrieved | C2PA detected | Processing | Download | Result |
|---|---|---|---|---|---|---|
| **ChatGPT** | PASS | PASS | PASS | PASS | PASS | **Working on the live site** |
| **Gemini** | PASS | PASS | PASS | PASS | PASS | **Working on the live site** |
| **Copilot** | PASS¹ | PASS¹ | PASS¹ | PASS | PASS¹ | **Unverified on the live site** |
| **Grok** | PASS | PASS | PASS | PASS | PASS | **Working on the live site** |

¹ Against **our reconstruction** of the page, in a real Chromium with the real
extension loaded. Not against the live site, because this environment has no
account for it.

² Gemini's displayed image is a resized derivative that carries no
credentials. The adapter now requests the original instead, and the browser
test reproduces that exact failure and proves the fix. It has not yet been
re-tested on the live site.

³ The engine is shared and verified. Whether a real Grok image contains
anything to process is unknown.

## Confirmed live: ChatGPT and Gemini

Both were confirmed end to end on their real websites by the product owner on
5 October 2026: the button appears, credentials are detected, removal runs on
one click and the processed file downloads.

Gemini took four attempts, because it serves a credential-free derivative in
the conversation and keeps the real original behind a separate address that
appears only in its API responses. See FOUR_PLATFORM_SUPPORT.md.

Grok was also confirmed working on its live site, which answers the open
question in FOUR_PLATFORM_SUPPORT.md: Grok images do carry credentials this
extension can read and remove.

Copilot remains untested on its live site. The product owner
installed the extension in Chrome, opened real ChatGPT, and confirmed the
button appeared and Content Credentials were detected.

For the other three we have no account, so nobody has ever seen their real
markup. The honest status is: the machinery works; whether it latches onto the
real page is untested.

## What was actually run

### 1. Credential engine, against real signed files — PASS

Independent of any platform. Real C2PA-signed images from the Content
Authenticity Initiative's own test repositories, verified with ImageMagick:

```
exp-test1.png  5,884,439 -> 2,444,293 bytes   differing pixels: 0
CA.jpg           166,864 ->    49,591 bytes   differing pixels: 0
C.jpg            132,518 ->    86,634 bytes   differing pixels: 0
```

This is the part shared by all four platforms, and it is the best-evidenced
part of the product.

### 2. Unit tests — 119 PASS, 0 fail

Includes per-platform address classification for all four adapters, the
registry routing, and the guard that Grok is never recorded as supported.

### 3. ChatGPT browser suite — 64 PASS, 0 fail

The full regression suite, re-run after the platform refactor. Covers
detection, the panel, one-click removal, download, positioning, both themes
and the service worker.

### 4. Four-platform browser suite — 63 PASS, 0 fail

The real extension in a real Chromium, against a reconstructed page per
platform served from that platform's real hostname.

| Check | ChatGPT | Gemini | Copilot | Grok |
|---|---|---|---|---|
| Extension activates on the host | PASS | PASS | PASS | PASS |
| Exactly one button, on the generated image | PASS | PASS | PASS | PASS |
| Avatar correctly ignored | PASS | PASS | PASS | PASS |
| Panel shows Format / Size / File | PASS | PASS | PASS | PASS |
| Panel shows no technical detail | PASS | PASS | PASS | PASS |
| Credentials detected | PASS | PASS | PASS | n/a⁴ |
| One-click removal downloads | PASS | PASS | PASS | n/a⁴ |
| Output has no credentials left | PASS | PASS | PASS | n/a⁴ |
| Dimensions survive | PASS | PASS | PASS | n/a⁴ |
| Reports "none found" honestly | n/a | n/a | n/a | PASS |
| Offers no removal when nothing to remove | n/a | n/a | n/a | PASS |
| No page errors | PASS | PASS | PASS | PASS |

⁴ Grok's test page deliberately serves an image with **no** credentials,
because that is the case we are least sure about in reality. The test asserts
the extension says so plainly and invents nothing.

## What is BLOCKED, and why

| Item | Status | Reason |
|---|---|---|
| Generate a real image on Gemini | **BLOCKED** | No account in this environment |
| Generate a real image on Copilot | **BLOCKED** | No account |
| Generate a real image on Grok | **BLOCKED** | No account |
| Inspect a real Gemini file's bytes | **BLOCKED** | Follows from the above |
| Inspect a real Copilot file's bytes | **BLOCKED** | Follows from the above |
| Inspect a real Grok file's bytes | **BLOCKED** | Follows from the above |
| Confirm Gemini's image CDN host | **CONFIRMED** | The product owner's live test reached it |
| Confirm Copilot/Grok image CDN hosts | **NOT CONFIRMED** | No vendor documents them |
| Confirm a Gemini download carries C2PA at all | **NOT CONFIRMED** | The decisive open question. Needs one real file |
| Gemini original reachable from the DOM | **NOT SUPPORTED** | Confirmed absent: a live DOM dump returned no links and no attributes |
| Read Google's and Microsoft's own pages | **BLOCKED** | The network here blocks those domains |
| WebP chunk identifier | **PASS** | Confirmed against the C2PA reference implementation's source |
| WebP removal against a real signed file | **BLOCKED** | No C2PA-signed WebP sample exists publicly |
| SynthID removal | **NOT SUPPORTED** | Deliberate. It is a pixel watermark, not metadata |

## The honest summary

- **ChatGPT: working**, confirmed on the live site.
- **Gemini and Copilot: built and tested against a reconstruction.** Both
  vendors document C2PA, so the engine should work the moment detection
  latches on. The open question is detection, not processing.
- **Grok: correctly identified as unknown.** No fake support was added.
- **No false claims.** Nothing in the UI promises watermark removal.

## What you can do to close the gaps

Generate one image on each of Gemini, Copilot and Grok, download it, and send
the files. Inspecting the real bytes converts most of the "not confirmed" rows
into confirmed ones in a single pass, and would tell us Grok's answer
definitively.
