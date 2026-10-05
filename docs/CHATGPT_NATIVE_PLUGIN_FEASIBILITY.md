# CrediClean ChatGPT-Native Feasibility

Research only. Nothing was built, and nothing in the extension was changed.

Written 5 October 2026.

---

## How to read this document, and how much to trust it

**Every OpenAI domain is blocked from the machine this research ran on.** I
tried `developers.openai.com`, `platform.openai.com`, `openai.com` and
`modelcontextprotocol.io` directly and got no response from any of them. So I
could not read a single OpenAI page with my own eyes.

Everything below comes from a search engine's summaries **of** those
first-hand pages, plus summaries of threads on OpenAI's own developer forum.
That is one step removed from the source, and it is a real weakness in this
research. Claims are labelled:

- **Official (second-hand)** — from an OpenAI documentation or policy page, as
  summarised by a search engine. Strong, but I did not read the page.
- **Developer forum** — from OpenAI's community forum. These are developers
  reporting what happened to them. Useful, often the only evidence that
  exists, and frequently wrong or out of date.
- **Verified by us** — I checked it in our own code.

Anything about this platform can be stale within weeks. It has been renamed
twice in about fourteen months.

---

## Executive conclusion

**PARTIALLY FEASIBLE — with limitations, one of which defeats the main reason
for doing it.**

**Confidence: 70%**

Not higher, because every source is second-hand, several key facts come from
forum posts of uncertain date, and the platform is moving fast.

The short version:

- The **technical path on desktop web looks plausible.** There is a documented
  mechanism for a tool to receive a file from the conversation, and a
  documented mechanism to hand a file back for download.
- **Mobile, which is your stated reason for exploring this, is where it
  currently falls down.** Multiple developer reports say tools that take
  arguments do not run on mobile at all, and that file handling on mobile
  gives the server a reference it cannot use.
- **Two non-technical blockers are larger than any technical one:** you would
  be asking OpenAI to approve, and distribute in OpenAI's own store, an app
  whose purpose is removing OpenAI's own provenance data from OpenAI's own
  images. And it would require sending the user's image to your server, which
  destroys the "nothing is uploaded" promise that is CrediClean's main trust
  asset.

---

## 1. Current ChatGPT developer architecture

**The 2023 "ChatGPT Plugins" system you may be thinking of is gone.** Do not
plan against anything written about it.

What exists now, as best I can establish:

| Era | What it was called | Status |
|---|---|---|
| 2023–24 | ChatGPT Plugins (OpenAPI manifest) | Retired |
| 2023– | GPTs, with "Actions" | Still exists, separate thing |
| Oct 2025 | **Apps in ChatGPT / Apps SDK**, built on MCP | The current system |
| Dec 2025 | "Connectors" renamed to apps; interactive and connected apps unified | Official (second-hand) |
| 2026 | MCP Apps UI standard adopted | Official (second-hand) |

**The architecture is: your app is an MCP server.** MCP (Model Context
Protocol) is an open standard for exposing tools to an AI model. You run a
server, it declares tools, ChatGPT calls them. Optionally your app also ships
a web UI, which ChatGPT renders in a **sandboxed iframe** inside the
conversation, in one of three display modes: inline, picture-in-picture, or
fullscreen.

**A naming warning.** OpenAI's 2026 documentation appears to use "plugin"
again for these apps. I saw both `developers.openai.com/apps-sdk/...` and
`developers.openai.com/plugins/...` paths in search results, and the help
article for submitting to the app directory is titled "Upload and submit your
**plugin**". So "plugin", "app" and "connector" now seem to overlap. I could
not open the pages to settle which term is canonical today. Treat any
article's terminology as a clue to its date, not as a fact.

**This is not a Chrome extension in a different wrapper.** Nothing about
content scripts, DOM access or page modification carries over. Your app never
touches ChatGPT's page. It is a server that ChatGPT calls, plus an iframe
ChatGPT draws for you.

---

## 2. Can CrediClean access ChatGPT-generated images?

**PARTIAL — probably yes on web, through one specific mechanism, and this is
the fact I am least able to confirm and most want you to test.**

### The default answer is no

Many developers on OpenAI's forum report the same thing: when ChatGPT
generates an image, the app receives a bare internal path like
`/mnt/data/image.png` as **text**. No URL. No bytes. Nothing fetchable.

Threads reporting exactly this include "Need to get the generated image from
ChatGPT through an MCP without user uploading it", "How to send file generated
in chat to MCP Server?", and "Anyone have an example using ChatGPT to generate
an image and passing to MCP tool?". **Developer forum.**

If that were the whole story, the answer would be a flat NO and this document
would stop here.

### But there is a documented mechanism that changes the answer

A tool descriptor can declare `_meta["openai/fileParams"]`, listing which of
its input fields are files. When it does, ChatGPT is reported to **transform**
`/mnt/data/image.png` into an object:

```
{ download_url, file_id, mime_type, file_name }
```

`download_url` and `file_id` are required fields; the other two are optional.
**Official (second-hand), from the Apps SDK reference, corroborated on the
forum** in a thread titled, precisely, "How to pass generated images from
conversation into ChatGPT app?".

If that is accurate, then the many "I can't get the image" complaints are
developers who had not declared `fileParams`, and the capability does exist.

### Why I will not call this settled

1. **I could not read the reference page myself.** This is a summary of it.
2. **It is not clear the mechanism covers images from ChatGPT's own image
   generator**, as opposed to files a user uploaded or that code interpreter
   wrote. `/mnt/data/` is historically the code-interpreter sandbox path. Some
   forum threads treat ChatGPT returning `/mnt/data/...png` for a generated
   image as a **bug**, not a feature, which suggests generated images do not
   reliably live there.
3. **Evidence on both sides is recent and contradictory.** That usually means
   behaviour changed, or varies by model and surface.

### How to settle it cheaply

This is a half-day experiment and it needs no submission, no review and no
public release. Stand up a throwaway MCP server in ChatGPT's developer mode
with one tool that declares `openai/fileParams` and does nothing but log what
it received. Generate an image in ChatGPT. Ask the app to look at it. Read the
log.

If a `download_url` arrives and the bytes behind it carry a `caBX` chunk, the
whole technical question is answered. If a bare string arrives, the idea is
dead on web as well as mobile, and you have saved yourself the rest of the
project.

**Do this before anything else.**

---

## 3. Can CrediClean process the image?

**YES — and this is the easy part. It is also the part with a hidden cost.**

### Technically, yes, trivially

**Verified by us.** I checked our own source. The credential engine is
1,591 lines across `src/formats/` (835), `src/processing/metadata-inspector.js`
(416) and `src/processing/credential-processor.js` (340). Not one of those
files references `document`, `window`, `navigator` or `chrome.*`. It is pure
byte manipulation over `Uint8Array`.

It would run unchanged on a Node server. The server fetches `download_url`,
gets the bytes, and calls the same `removeCredentials()` and `verifyRemoval()`
that run in the browser today. No rewrite, no port, no second implementation
to keep in sync.

### The hidden cost, which is not technical

**The image would have to leave the user's device.**

Today CrediClean's entire processing happens inside the user's browser. The
extension has no server. It cannot have one: there is nowhere to send
anything. That is why `PRIVACY.md` can say nothing is uploaded, why the store
listing answers "collects no user data", and why a tool that handles people's
private images is credible at all.

A ChatGPT app is a server by definition. The architecture requires it. So:

| | Chrome extension today | ChatGPT app |
|---|---|---|
| Where the image is processed | The user's own browser | Your server |
| Does the image leave the device | No | **Yes, always** |
| Can you promise "nothing is uploaded" | Yes, truthfully | **No** |
| Infrastructure to run and secure | None | A server handling users' images |
| What a breach would expose | Nothing | Users' images |

This is not a problem to engineer around. It is inherent to the architecture.
You would be trading your strongest trust claim for mobile reach, and you
should decide that deliberately rather than discover it during implementation.

---

## 4. Can CrediClean return the processed image?

**PARTIAL — the mechanism exists, but the evidence of it working reliably for
images specifically is mixed.**

### What is documented

Two routes, both **official (second-hand)**:

1. **Tool file references.** The tool returns `{ download_url, file_id, ... }`
   and ChatGPT shows the user a file they can download.
2. **From your own widget.** `window.openai.getFileDownloadUrl({ fileId })`
   returns a temporary URL, and the widget triggers an ordinary browser
   download from it.

### Four specific reasons for caution

1. **A size limit that may or may not apply.** One OpenAI page states returned
   files are capped at 10 MB each, up to 10 per request, and **"cannot be an
   image or video"**. That quote is from the **GPT Actions** documentation,
   which is the *older, separate* system. I am flagging it because it is
   exactly the kind of constraint that could also exist in the Apps SDK, not
   because I have evidence that it does. **Do not assume either way.**
2. **Developers report images failing to render.** Forum threads: "MCP tool
   returns an image successfully, but ChatGPT shows only text — no image or
   widget", and "ChatGPT connector returns empty `{}` for MCP tool results
   with `type: image` while the same tool works in MCP Inspector."
3. **Base64 truncation.** One report says base64 image payloads were truncated
   around 2.5 MB. A 1536×1024 PNG from ChatGPT is routinely larger than that.
   The file-reference route avoids this, but it tells you payload size is a
   live constraint.
4. **A size threshold in practice.** One developer reports 3 KB PNGs rendering
   fine while 3 MB PNGs produce only a text response.

**All four are developer forum.** They may all be fixed by now. They may not.

---

## 5. Can we create an image-specific action or button?

**NO. This is the clearest negative finding in this document, and it is the
biggest single difference from the extension.**

### What you cannot do

You cannot put a button on ChatGPT's own rendering of a generated image. There
is no mechanism for it, and there is unlikely ever to be one: your app runs in
a sandboxed iframe that ChatGPT draws *for you*, in a slot ChatGPT chooses.
You have no access to ChatGPT's own interface, by design.

The Chrome extension can do this precisely because it is a browser extension
with permission to modify the page. A ChatGPT app has no equivalent power, and
asking for one misunderstands what the platform is.

### What you can do

Your app is invoked in one of two ways (**official, second-hand**):

1. **The model decides**, from what the user typed. The user says something
   like "clean this image" and ChatGPT picks your tool.
2. **From inside your own widget**, with `window.openai.callTool(name, args)`,
   for tools marked `"openai/widgetAccessible": true`.

So the realistic best case is:

```
User: "CrediClean, check this image"

ChatGPT: [renders your widget card in the conversation]

         ┌──────────────────────────────────┐
         │ CC  CrediClean                   │
         │                                  │
         │ ● Content Credentials found      │
         │   Format   PNG                   │
         │   Size     1536 × 1024           │
         │                                  │
         │ [ Remove credentials & save ]    │ ← your button, inside your card
         └──────────────────────────────────┘
```

That is genuinely close to your mock-up. The panel is yours and you control
its contents and its buttons.

**What is lost is discovery.** Today the CC button appears on the image and
the user sees it without being told. In ChatGPT, nothing appears until the
user already knows your app exists and types something that triggers it. The
difference between "there is a button" and "you must remember an app's name"
is large, and it is a product difference, not a technical one.

**One more concern:** a forum thread titled "Issues with unstable natural
language invocation and duplicate tool calls" suggests invocation does not
always fire when it should. If the user has to phrase it right, the experience
degrades further. **Developer forum.**

---

## 6. Can it work on ChatGPT mobile?

**PARTIAL at best, and most likely NO today. This is the finding that matters
most to you, because mobile is why you asked.**

| Surface | Assessment | Why |
|---|---|---|
| **Web** | Most likely yes | This is the surface everything is built and tested on |
| **iOS** | Doubtful | Write tools reported unsupported; file uploads reported broken |
| **Android** | Worse than iOS | The above, plus Android-specific failures |

### What developers report

All of the following are **developer forum**, from threads dated roughly late
2025 into 2026:

- **"Mobile ChatGPT Apps does not support write MCP tools (tools that take in
  arguments), though read-only tools will work."** One post states this is the
  official position: MCP write actions are not supported on either mobile
  platform at this stage, only on web.
- **File uploads on mobile are broken.** A thread titled "MCP File Uploads
  Broken on Mobile App" reports that on both iOS and Android the server
  receives "just a string reference with no download URL, no metadata, and
  nothing the server can use to fetch the file" — exactly the failure mode
  that makes this project impossible.
- **Android blocks destructive tools before they reach the server**, where web
  and iOS show a confirmation and proceed.
- **`setWidgetState` does not work on Android.**
- **`openai/fileParams` behaves inconsistently on Android** compared with web
  and iOS.

### What this means for CrediClean specifically

CrediClean's tool is by definition a write tool that takes a file argument. If
write tools genuinely do not run on mobile, and file references genuinely
arrive unusable on mobile, then **the exact thing you want does not work on
the exact platform you want it for.**

I want to be straight about the strength of this evidence. These are forum
posts, not a policy page. They may be out of date. OpenAI is actively
developing this and mobile support could land at any time. But several
independent reports agree, and none of my searches turned up anyone saying it
works.

**This is the single most important thing to verify before committing**, and
it is verifiable in an afternoon alongside the test in section 2.

---

## 7. Can we publish it publicly?

**PARTIAL. The pipeline exists and is open. Whether CrediClean would survive
it is a different question, and I think the odds are poor.**

### The pipeline exists

**Official (second-hand).** Developers can submit apps for review; approved
apps appear in an in-product directory users can browse and search.

Requirements I could establish:

| Requirement | Detail |
|---|---|
| Verification | Individual or business verification in organization settings |
| Who can submit | Organization owners, or members with Apps Management Write |
| Privacy policy URL | **Required** |
| Terms of service URL | **Required** |
| Product website (HTTPS) | Required |
| Customer support page | Required |
| App name | Max 30 characters |
| Short description | Max 30 characters |
| Long description | Max 4,000 characters |
| Test cases | Five positive cases, each run on a test account before submitting |
| Submission format | A ZIP, with automated findings to resolve first |
| Hosting | You declare your MCP server URL and run it yourself |
| Fees | "Minor charges" possible for verification and compliance; OpenAI reserves the right to charge for submission or publication in future with notice |

Most of this you already have or can produce quickly. You wrote a privacy
policy for the Chrome Web Store already.

### Why I think approval is unlikely

This is my judgement, not a documented rule, and I want it clearly labelled as
such. But the shape of the problem is hard to argue with.

**You would be asking OpenAI to approve and distribute, in OpenAI's own store,
an app whose single purpose is stripping OpenAI's own provenance data out of
OpenAI's own generated images.**

Consider what sits on the other side of that request:

- OpenAI publishes a **content provenance** guide and describes a layered
  approach: **C2PA Content Credentials, SynthID watermarking for images and
  audio, and public verification tooling.** **Official (second-hand).**
- OpenAI's **Terms of Use** prohibit "bypassing any protective measures or
  safety mitigations" and prohibit "representing that Output was
  human-generated when it was not". **Official (second-hand).**
- OpenAI's **app submission guidelines** prohibit apps that facilitate
  activities prohibited under the usage policies, and prohibit apps that are
  deceptive or misleading. **Official (second-hand).**
- OpenAI cites provenance work in its **EU AI Act** compliance materials.
  Provenance is now a regulatory commitment, not only a product feature.

A reviewer does not have to decide CrediClean is malicious. They only have to
decide it is adjacent to "bypassing a safety mitigation", on a feature OpenAI
has publicly committed to regulators. The cheapest decision for them is no.

**The Chrome Web Store is a materially easier bar**, and I said already that
even there approval is not guaranteed. Google does not have a provenance
commitment riding on the data CrediClean removes. **OpenAI does, and it is
their own data.**

**One note that cuts your way, honestly:** removing C2PA metadata is a
legitimate, lawful thing to do. Metadata is routinely lost when any image is
resized, re-uploaded or screenshotted, and OpenAI's own documentation
acknowledges this in plain terms. CrediClean does not claim to make anything
untraceable and does not touch SynthID, which is the signal OpenAI now leans
on. A reviewer who reads carefully could reasonably approve it. I just would
not plan on them reading carefully.

**I cannot give you odds.** I have no data on how OpenAI treats this category,
and I am not aware of any comparable app having been through the process.

---

## 8. What parts of our Chrome extension can be reused?

Line counts and dependency checks here are **verified by us** against the
current source, not estimated.

| Existing CrediClean component | Lines | Reusable? | Changes required |
|---|---|---|---|
| `src/formats/png.js`, `jpeg.js`, `webp.js`, `jumbf.js`, `detect.js` | 835 | **Yes, unchanged** | None. Pure byte code, no DOM, no `chrome.*` |
| `src/processing/metadata-inspector.js` | 416 | **Yes, unchanged** | None |
| `src/processing/credential-processor.js` | 340 | **Yes, unchanged** | None |
| `src/shared/constants.js` | 34 | Yes | None |
| `tests/` for all of the above | — | **Yes** | None. They already run under Node |
| `src/processing/download-manager.js` | 117 | Partially | The filename logic survives. The download itself uses `Blob`, `URL.createObjectURL` and a synthetic `<a>` click, all of which are replaced by returning a file reference |
| `src/processing/image-loader.js` | 302 | Partially | The candidate and acceptance logic is sound but solves a problem you would no longer have. ChatGPT hands you one file |
| `src/content/button-manager.js` | 375 | Rewrite | The panel's *design* carries over; the code does not. It becomes a React component in a sandboxed iframe |
| `src/content/overlay.js` | 382 | **No** | Exists to position controls over a page you no longer touch. Shadow DOM, positioning, theme detection: all moot |
| `src/content/image-detector.js` | 310 | **No** | Exists to find images in a page. ChatGPT tells you which image |
| `src/content/route-watcher.js` | 139 | **No** | Exists because the extension lives in a web page. It no longer does |
| `src/content/network-observer.js` | 280 | **No** | The Gemini fix. Irrelevant inside ChatGPT |
| `src/platforms/*` | 625 | **No** | Per-site detection rules. ChatGPT is the only platform, and it tells you |
| `src/popup/*` | 125 + markup | **No** | No popup exists |
| `src/background/service-worker.js` | 140 | **No** | Replaced by your MCP server |
| `manifest.json` | — | **No** | Replaced by an MCP tool descriptor |

**Roughly 1,625 of about 4,400 lines of source carry over untouched**, and
they are the hard, well-tested, independently verified part. Everything that
would be thrown away is the part that exists *because* it is a browser
extension.

That is the honest summary: **the engine ports perfectly, the product does
not.** You would be keeping the machinery and rebuilding the whole experience
around it.

---

## 9. Required new architecture

Described for assessment only. **Not built, as instructed.**

```
ChatGPT (web, or mobile if it ever works)
        │
        │  user types something that triggers the app
        ▼
ChatGPT calls your MCP tool
        │  passes { download_url, file_id, mime_type, file_name }
        │  (only if openai/fileParams works as documented — SECTION 2)
        ▼
YOUR SERVER  ← new, did not exist before
        │  1. fetch download_url
        │  2. run the existing engine, unchanged
        │  3. verifyRemoval(), unchanged
        │  4. return a file reference for the result
        ▼
ChatGPT renders your widget in a sandboxed iframe
        │  your panel, your button
        ▼
User downloads the processed file
```

New things you would have to own, none of which exist today:

- A **public HTTPS server**, with uptime, monitoring and incident handling.
- **Users' images passing through it.** Retention policy, deletion policy,
  encryption, breach plan.
- **An MCP server implementation** and tool descriptors.
- **A React widget** for the panel.
- **Authentication**, if you ever need to know who is calling.
- **A rewritten privacy policy** that can no longer say nothing is uploaded.
- **Abuse handling.** A public endpoint that strips provenance from any image
  sent to it is a more attractive target than a browser extension.
- **Per-use cost.** Bandwidth and compute scale with users. The extension
  costs you nothing per user, forever.

---

## 10. Biggest risks

Ordered by how likely they are to kill the project.

**1. Mobile does not work, so the whole reason evaporates.**
You want this for mobile. Multiple developer reports say write tools do not
run on mobile and file references arrive unusable there. If true, you would
build everything and still not have mobile. *Testable in an afternoon.*

**2. OpenAI rejects it on provenance grounds.**
You are asking OpenAI to distribute an app that removes OpenAI's own
provenance from OpenAI's own images, against their Terms' prohibition on
bypassing protective measures and their public commitments on content
provenance. *Not testable in advance. You would find out after building.*

**3. Generated images may be unreachable even on web.**
The `openai/fileParams` mechanism may not cover images from ChatGPT's image
generator. If it does not, nothing else matters. *Testable in an afternoon,
and it is the first thing to test.*

**4. The privacy promise dies.**
"Nothing is uploaded" is CrediClean's best argument for trusting it. A server
architecture cannot make that claim. This is not a risk you can mitigate; it
is a cost you either accept or do not.

**5. Returning the processed image may be unreliable, or barred.**
Several reports of images failing to render or arriving empty, a base64
truncation limit well below a typical generated PNG, and an image-and-video
exclusion in the *older* Actions documentation that may or may not carry over.
*Partly testable in the same afternoon.*

A sixth, worth naming even though it is not a blocker: **the discovery
experience is strictly worse.** No button on the image, so the user must
already know your app exists and must phrase the request well enough for the
model to pick it.

---

## 11. Recommended approach

### My recommendation: **Option A for now**, with one cheap experiment that could move you to Option B

**Not Option C under any circumstances.** Moving entirely to a ChatGPT-native
app would mean abandoning a working, verified, independently tested product
that runs on three platforms, in exchange for one that does not demonstrably
work on your target platform, has not been approved, and may not be
approvable. That is trading something real for something hypothetical.

**Option A — continue with the Chrome extension.** It works. It is verified on
three live platforms. It needs no server, costs nothing per user, and can
honestly promise that nothing is uploaded. It is ready to submit to the Chrome
Web Store today.

**The experiment that could change my advice**, in this order, and it is about
a day of work in total:

1. Stand up a throwaway MCP server in ChatGPT's **developer mode**. No
   submission, no review, no public release.
2. Declare one tool with `_meta["openai/fileParams"]` that logs what it
   receives and does nothing else.
3. Generate an image in ChatGPT on **desktop web**. Trigger the tool. Does a
   usable `download_url` arrive? Do the bytes behind it carry a `caBX` chunk?
4. Repeat the identical test on **iOS**, then on **Android**.

Four outcomes, and each has a clear answer:

| Result | What it means |
|---|---|
| Fails on web | Dead. Stop. You have lost a day |
| Works on web, fails on mobile | **The most likely outcome.** Option A stands: a ChatGPT app would add nothing the extension does not already do |
| Works on web and mobile | Option B becomes genuinely worth costing out, policy risk and all |
| Works but images are unusably large or unreliable | Note the limits and revisit in six months |

**If and only if step 4 succeeds on mobile**, Option B is worth a serious look:
keep the extension as the desktop product, where it is better anyway, and add
the ChatGPT app purely to reach mobile. Even then you would be accepting the
server, the privacy change and the approval risk, with eyes open.

### One thing to consider separately

If mobile is the real goal rather than ChatGPT specifically, a **mobile app or
a mobile web page** where the user shares an image into CrediClean would reach
mobile users, work on any AI platform's images rather than only ChatGPT's,
need no approval from OpenAI, and could still do the processing on the device.

That is outside what you asked me to research and I have done no work on it.
I mention it only because it addresses your actual stated goal without any of
the blockers above, and it would be a shame not to say so.

---

## 15. The final question

> **"Can we realistically build CrediClean as a publicly available
> ChatGPT-native plugin/app that users can install inside ChatGPT and use on
> ChatGPT-generated images, including from the ChatGPT mobile app, without
> requiring our Chrome extension?"**

# PARTIAL

And on the part you care about most, the honest answer is closer to no.

### In plain English

**On a desktop computer: probably yes, with effort and an approval risk.**
The pieces appear to exist. ChatGPT can hand your app a file. Your app can
process it and hand one back. Your panel can look much like it does now.

**On mobile: probably not, today.** And mobile is the whole reason you asked.
Several developers report that apps which take arguments simply do not run on
phones, and that file handling on phones gives the server something it cannot
use. That is exactly what CrediClean would need.

**Two things would still be true even if all of it worked.**

First, **no button on the image.** Today CrediClean's button appears and the
user sees it. In ChatGPT, nothing appears until the user already knows your app
exists and asks for it by name. That is a real loss, and no amount of
engineering fixes it, because you are not allowed to touch ChatGPT's own
interface.

Second, **the image would leave the user's device.** Today everything happens
inside their browser, which is why you can honestly say nothing is uploaded. A
ChatGPT app is a server. You would be giving up your best reason for someone
to trust the tool.

### The thing I would most want you to hear

The largest obstacle is not technical. It is that you would be asking OpenAI
to put in their own shop an app that removes their own provenance data from
their own images, at a time when they are citing that provenance work to
regulators.

I cannot tell you they would refuse. I have no data, and the case for approval
is real: removing metadata is lawful, routine, and happens by accident every
time an image is resized. But I would not build a product on the assumption
that they say yes.

### What to do with this

Spend one day on the experiment in section 11 before spending anything else.
It settles the two questions that decide everything, costs you almost nothing,
and needs no permission from anyone.

Until then, the Chrome extension is the product, and it is ready.

---

## Sources

All read as search-engine summaries, because the pages themselves were blocked
from this machine. Grouped by how much weight I put on them.

**OpenAI official documentation and policy**

- [Introducing apps in ChatGPT and the new Apps SDK](https://openai.com/index/introducing-apps-in-chatgpt/)
- [Apps SDK Reference](https://developers.openai.com/apps-sdk/reference)
- [Add UI to your MCP server](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt)
- [Build your ChatGPT UI](https://developers.openai.com/apps-sdk/build/custom-ux/)
- [App submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)
- [App developer guidelines](https://developers.openai.com/apps-sdk/app-developer-guidelines/)
- [Developers can now submit apps to ChatGPT](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/)
- [Submitting apps to the ChatGPT app directory](https://help.openai.com/en/articles/20001040-submitting-apps-to-the-chatgpt-app-directory)
- [App Developer Terms](https://openai.com/policies/developer-apps-terms/)
- [Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [Content provenance](https://developers.openai.com/api/docs/guides/content-provenance)
- [Advancing content provenance for a safer, more transparent AI ecosystem](https://openai.com/index/advancing-content-provenance/)
- [EU AI Act: OpenAI Resources and Customer Guidance](https://help.openai.com/en/articles/12141645-eu-ai-act-openai-resources-and-customer-guidance)
- [Build with the Apps SDK](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [Sending and returning files with GPT Actions](https://developers.openai.com/api/docs/actions/sending-files) — the **older** Actions system, cited only for the caution in section 4
- [15 lessons learned building ChatGPT Apps](https://developers.openai.com/blog/15-lessons-building-chatgpt-apps)

**OpenAI developer forum — individual developers' reports, not policy**

- [How to pass generated images from conversation into ChatGPT app?](https://community.openai.com/t/how-to-pass-generated-images-from-conversation-into-chatgpt-app/1369293)
- [File input parameters to tools](https://community.openai.com/t/file-input-parameters-to-tools/1371839)
- [Need to get the generated image from ChatGPT through an MCP without user uploading it](https://community.openai.com/t/need-to-get-the-generated-image-from-the-chatgpt-through-a-mcp-without-user-uploading-it/1382637)
- [How to send file generated in chat to MCP Server?](https://community.openai.com/t/how-to-send-file-generated-in-chat-to-mcp-server/1365335)
- [Apps-SDK on mobile devices](https://community.openai.com/t/apps-sdk-on-mobile-devices/1366422)
- [MCP File Uploads Broken on Mobile App](https://community.openai.com/t/mcp-file-uploads-broken-on-mobile-app/1372060)
- [Android ChatGPT blocks Apps SDK widget app destructive tool before MCP](https://community.openai.com/t/android-chatgpt-blocks-apps-sdk-widget-app-destructive-tool-before-mcp-while-web-ios-show-confirmation-modal-and-work/1380943)
- [setWidgetState does not work on Android](https://community.openai.com/t/setwidgetstate-does-not-work-on-android/1370107)
- [MCP tool returns an image successfully, but ChatGPT shows only text](https://community.openai.com/t/mcp-tool-returns-an-image-successfully-but-chatgpt-shows-only-text-no-image-or-widget/1399928)
- [ChatGPT connector returns empty {} for MCP tool results with type: "image"](https://community.openai.com/t/chatgpt-connector-returns-empty-for-mcp-tool-results-with-type-image-while-same-tool-works-in-mcp-inspector/1375446)
- [Issues with unstable natural language invocation and duplicate tool calls](https://community.openai.com/t/issues-with-unstable-natural-language-invocation-and-duplicate-tool-calls/1370573)
- [Status of writes capability in SDK?](https://community.openai.com/t/status-of-writes-capability-in-sdk/1373092)
