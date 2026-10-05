# CrediClean as a ChatGPT app

An MCP server that lets ChatGPT inspect and remove C2PA Content Credentials
from an image in a conversation.

**This is a separate product from the Chrome extension.** It shares the
credential engine and nothing else. Nothing in this folder changes how the
extension behaves, and the extension does not import anything from here.

---

## Read this before you build on it

Two things are true at the same time, and both matter.

**What is built and tested here works.** 101 automated checks pass: the server
speaks MCP correctly, declares the metadata ChatGPT needs, downloads an image,
runs the real credential engine on it, and returns a file that is verifiably
clean and pixel-for-pixel identical to the original.

**What nobody has tested is whether ChatGPT cooperates.** Every test here uses
a stand-in for ChatGPT, because testing against the real thing needs a ChatGPT
account and a public HTTPS address, neither of which existed where this was
written. In particular, **nothing here proves ChatGPT will hand this app an
image it generated itself.** That single unknown decides whether the app works
at all, and the checklist below is how you settle it.

The full reasoning, with sources, is in
[`../docs/CHATGPT_NATIVE_PLUGIN_FEASIBILITY.md`](../docs/CHATGPT_NATIVE_PLUGIN_FEASIBILITY.md).

### Three things it cannot do, by design of the platform

1. **No CC button on the image.** Apps render in a sandboxed frame that
   ChatGPT draws for them. They cannot touch ChatGPT's own interface. The user
   reaches this app by typing `@CrediClean`, by picking it from the `+` menu,
   or by ChatGPT deciding to suggest it.
2. **The image leaves the device.** This is a server. It downloads the image,
   processes it in memory, and holds the result for a few minutes. The
   extension's "nothing is uploaded" promise cannot be made here, and the
   privacy wording must say so.
3. **Mobile is doubtful.** Developers report that MCP tools taking arguments do
   not run on ChatGPT mobile, and that file references arrive there unusable.
   Both of this app's tools take a file argument. Step 4 of the checklist is
   where you find out.

It still does not remove invisible watermarks such as SynthID, and never
claims an image is untraceable. That has not changed and must not.

---

## What it does

| Tool | What it does |
|---|---|
| `inspect_image_credentials` | Reports what provenance data an image carries, plus its format and size. Reads only |
| `remove_image_credentials` | Removes the supported credentials and returns a clean copy to download |

Both declare `_meta["openai/fileParams"]` for their `image` argument, which is
the mechanism that is supposed to turn ChatGPT's internal `/mnt/data/...` path
into a real download URL. Both render `widget/panel.html`, which is the same
card the extension shows: one status line, three facts, one action.

## How it fits together

```
ChatGPT
   │  calls a tool, passing { download_url, file_id, mime_type, file_name }
   ▼
src/mcp.js          declares the tools and the widget
   ▼
src/files.js        checks the address, downloads the bytes
   ▼
../src/processing/  THE EXTENSION'S OWN ENGINE, imported unchanged
   ▼
src/files.js        holds the result for a few minutes
   ▼
widget/panel.html   the card, with a download link
```

The engine is not copied or forked. `src/tools.js` imports
`../../src/processing/metadata-inspector.js` and
`../../src/processing/credential-processor.js` directly. Those files are pure
byte code with no browser APIs, which is why they run here as they are. Fix a
credential bug once and both products get it.

---

## Running it locally

```bash
cd chatgpt-app
npm install
npm start
```

Then `http://localhost:8787/health` should answer.

### Tests

```bash
npm test           # 15 unit checks: the file layer and the SSRF guard
npm run test:e2e   # 52 checks: a real MCP client against the real server
npm run test:widget # 34 checks: the panel in a real Chromium
npm run check      # all three
npm run package https://your-server.example.com   # build the plugin archive
```

`npm run test:widget` needs Playwright: `npm install --no-save playwright`.

---

## Configuration

Set these before exposing it to the internet. The defaults are for a laptop.

| Variable | Default | What it is for |
|---|---|---|
| `CREDICLEAN_PUBLIC_URL` | `http://localhost:8787` | **Must be set in production.** Download links are built from it, and ChatGPT cannot reach localhost |
| `PORT` | `8787` | Port to listen on |
| `CREDICLEAN_ALLOWED_HOSTS` | OpenAI file hosts | **Security control.** The only hosts the server will download an image from |
| `CREDICLEAN_MAX_BYTES` | `41943040` (40 MB) | Refuse anything bigger |
| `CREDICLEAN_FILE_TTL_MS` | `900000` (15 min) | How long a processed file stays downloadable |
| `CREDICLEAN_DOWNLOAD_TIMEOUT_MS` | `20000` | Give up on a slow download |

### About `CREDICLEAN_ALLOWED_HOSTS`

This is not a convenience setting. The server is a public endpoint that
downloads a URL somebody else supplies. Without a list like this, anyone could
point it at `http://169.254.169.254/` and have it fetch your cloud
credentials, or at an address inside your own network.

The defaults are the OpenAI hosts a file download URL is **expected** to use.
That is an inference, not something OpenAI documents. If a real ChatGPT file
URL is refused, the log says exactly which host was refused:

```
[CrediClean] Refused to download from "<host>". If that is a legitimate
ChatGPT file host, add it to CREDICLEAN_ALLOWED_HOSTS.
```

That one line is all you need to correct it. **Add the specific host. Never
widen this to everything.**

---

## Two ways to run this, and the easy one came later

There are two builds in this folder. They do the same job by different routes.

| | **The skill** (`skill/`) | **The MCP server** (`src/`) |
|---|---|---|
| Where the work happens | Inside ChatGPT's own sandbox | On a server you run |
| Anything to host? | **No** | Yes, with a public address or a tunnel |
| Does the image leave OpenAI? | **No** | Yes, to your server |
| How you install it | **Upload plugin archive** | Create custom MCP server |
| Depends on `openai/fileParams` resolving | **No** | **Yes.** This is the open question |
| Language | Python | JavaScript |

**Test with the skill.** It is self-contained, needs nothing hosted, and it
sidesteps the one unknown that could have killed the whole idea: the skill runs
*inside* the sandbox where `/mnt/data/...` is a real path, so there is no need
for ChatGPT to hand a file out to anything.

```bash
npm run package          # builds the skill-only archive
```

Then in ChatGPT: **Plugins → Add → Upload plugin archive**.

The MCP server is still here and still passes its tests. It is the right shape
if the work ever needs to happen on infrastructure you control.

### Is the Python a second implementation that can drift?

Yes, and that is handled rather than hoped about. `npm test` runs both
implementations over the same images and **fails if a single output byte
differs**. On the real C2PA-signed files from the Content Authenticity
Initiative, the Python produces output byte-identical to the JavaScript
engine, with ImageMagick confirming zero differing pixels:

```
C.jpg           132,518 ->    86,634   identical to JS, 0 differing pixels
CA.jpg          166,864 ->    49,591   identical to JS, 0 differing pixels
exp-test1.png 5,884,439 -> 2,444,293   identical to JS, 0 differing pixels
```

The parity test caught a real bug during the port: an unsupported format was
being reported as a damaged file. That is what it is for.

## Which of ChatGPT's three "Add" options you want

ChatGPT's Plugins page offers three things, and only one of them is for
testing this.

| Menu item | What it is | Use it? |
|---|---|---|
| **Create custom MCP server** | Connect a running server, by public URL **or by Secure MCP Tunnel** | **Yes. This is the one.** |
| **Upload plugin archive** | A ZIP. **With the skill inside, it is self-contained.** With an MCP server, it only points at one | **Yes, for the skill** |
| **Create plugin** | Build a plugin in ChatGPT's own UI | No |

**An archive containing a skill IS self-contained**, because ChatGPT copies
the bundle into its own execution environment and runs the script there.

**An archive containing an MCP server is not.** It is a label saying where
your tools live, and the server still has to be running and reachable. OpenAI
does not host it for you, and ChatGPT web cannot run a bundled local server at
all: it only reaches remote ones.

**Secure MCP Tunnel is the useful discovery here.** OpenAI documents it as a
way to connect a local or private MCP server "without exposing the server to
the public internet". That means you can test from your own machine with no
ngrok, no cloudflared and nothing publicly exposed. Its one limit: a tunnel
does not satisfy the requirements for public submission, which only matters
much later.

## Testing it against the real ChatGPT

This is the part the automated tests cannot do, and the only part that answers
whether the idea works. Do it in this order, and stop at the first failure.

### Step 1 — Connect it, on desktop web

1. Start the server: `npm start`. Leave the log where you can see it.
2. In ChatGPT: **Settings → Security and login → Developer mode**, turn it on.
3. Go to **Plugins → Add → Create custom MCP server**.
4. Give it a name, then under **Connection**:
   - **Secure MCP Tunnel** (recommended): choose **Tunnel** and pick or enter
     the tunnel id. Nothing of yours goes on the public internet.
   - **Public URL**: only if you have one. Enter it **including `/mcp`**, and
     set `CREDICLEAN_PUBLIC_URL` to the same address before starting, or the
     download links it builds will point at localhost and fail.
5. Confirm both tools appear in the list.

If the tools do not appear, the problem is the connection, not the app. Check
the server log, and check `/health` answers over your public address.

### Step 2 — The one that decides everything

1. Ask ChatGPT to **generate an image**.
2. Then say: `@CrediClean inspect this image`.
3. **Watch the server log.**

| What the log shows | What it means |
|---|---|
| A download URL, and a panel appears | **It works.** Go to step 3 |
| `ChatGPT passed a file path rather than a downloadable file` | `openai/fileParams` did not resolve for a generated image. **This is the blocker the research predicted.** The idea does not work; stop here |
| `Refused to download from "<host>"` | Add that host to `CREDICLEAN_ALLOWED_HOSTS` and retry. Not a blocker |

Try the same thing with an image you **upload** yourself as well. If uploads
work and generated images do not, that is a precise, reportable finding and
worth writing down.

### Step 3 — The whole flow, on desktop web

1. Ask: `@CrediClean remove the credentials from this image`.
2. Does the panel appear with Format, Size and File?
3. Does the download link work, and is the file clean?
4. Click **Remove credentials & save** inside the panel. Does the button work,
   or does the panel say "Not available here"?

Verify the downloaded file at
[contentcredentials.org/verify](https://contentcredentials.org/verify). It
should report no credentials, and the picture should look identical.

### Step 4 — Mobile, which is the reason this exists

Repeat step 2 and step 3 on **iOS**, then on **Android**.

Write down, for each:

- Does the app appear at all?
- Does the tool get called?
- Does a usable download URL arrive, or a bare path?
- Does the panel render?
- Does the download link work?

The research says this will fail, because tools that take arguments are
reported not to run on mobile. **If it fails, that is the answer**, and it is
worth knowing for certain rather than assuming either way.

### Step 5 — Only if steps 2 to 4 all pass

Only then is it worth thinking about submission, a real host, a privacy policy
that reflects a server, and OpenAI's review. The feasibility document's
section 7 covers what that involves and why approval is the larger risk.

---

## What is deliberately not here

- **No authentication.** Nothing to sign in to, and no user accounts, matching
  the extension. If this is ever published, review whether that is still right.
- **Nothing written to disk.** Processed images are held in memory and expire.
  A restart loses them, which is the right trade for somebody's picture.
- **No analytics, no telemetry, no tracking.** Same as the extension.
- **No submission to OpenAI.** Nothing here has been submitted or published.
