# Troubleshooting

## The button does not appear on my images

This is the most likely problem, and usually the easiest to fix.

**First, rule out the simple causes:**

1. Is the extension switched on? Click the CrediClean icon and check.
2. Is "Show buttons on images" switched on?
3. Reload the ChatGPT page. The extension attaches when the page loads.
4. Is the image actually large? Images under 96 pixels on either side are
   ignored on purpose, so avatars and icons do not get buttons.
5. Did you just reload the extension at `chrome://extensions`? Reloading an
   extension disconnects any pages already open. Refresh the ChatGPT tab.

**If none of that helps, ChatGPT has probably changed its page.**

ChatGPT's internal structure is not a public interface. It changes without
notice, and when it does, the rules CrediClean uses to spot a generated image
can stop matching.

All of those rules live in **one file**: `src/content/image-detector.js`.

To find out what changed:

1. On the ChatGPT page, right-click a generated image and choose **Inspect**.
2. Look at the `<img>` element that is highlighted.
3. Check its `src`. Does it contain `oaiusercontent.com`, or
   `/backend-api/estuary/content`? If it is something new, add that fragment to
   `CONTENT_URL_FRAGMENTS` in the detector file.
4. Look at the elements it sits inside. Does any of them have
   `data-message-author-role` or a `data-testid` starting with
   `conversation-turn`? If not, add whatever stable attribute they do have to
   `CONVERSATION_CONTAINER_SELECTORS`.

Prefer attributes such as `data-testid` and `role` over class names. ChatGPT's
class names are generated and change constantly, which is why none are used.

## The button appears on things that are not generated images

Add a distinguishing fragment of the image address to `EXCLUDED_URL_FRAGMENTS`
in `src/content/image-detector.js`, or raise `MIN_CONTENT_EDGE_PX` if the
unwanted images are smaller than the real ones.

## "The image could not be read"

Usually one of:

- **The address expired.** ChatGPT image addresses are signed and short-lived.
  Refresh the page and try again.
- **You are signed out**, so ChatGPT refused the request. Sign in and refresh.
- **The network request failed.** Check your connection.

If it keeps happening on a fresh page load, open the browser console (F12) and
look for lines starting `[CrediClean]`.

## "This image format is not supported"

Version 0.1.0 handles PNG, JPEG and WebP. Anything else is refused rather than
guessed at.

This message is deliberate. It means "we did not look", which is different from
"we looked and found nothing". We will not report a format we cannot read as
being free of credentials.

## "This image could not be inspected"

The file was downloaded but its internal structure could not be read. Usually
the download was incomplete. Refresh and try again.

If it persists, the file may be damaged, or it may be a format that disguises
itself as one we support. Either way the extension refuses rather than
producing a file it cannot stand behind.

## "The processed image failed our own checks"

The extension checks its own output before offering it to you, and this message
means a check failed, so the file was discarded.

**Your original image is untouched.** Nothing was saved.

This should not happen. If it does, it is a bug worth reporting, along with the
format and rough size of the image.

## Nothing happens when I click "Remove credentials and save"

- Check whether a confirmation step appeared. By default you must confirm. The
  confirm button is at the bottom of the panel.
- Check Chrome's download settings. If Chrome is set to "Ask where to save each
  file", a save dialog may be waiting behind another window.
- Check whether downloads are blocked for the site in Chrome's address bar.

## The saved file still shows credentials somewhere

Two different things can cause this, and they are worth telling apart.

**If a checker reports an invisible watermark:** that is expected and is not a
failure. CrediClean removes metadata. It cannot see or alter watermarks carried
in the pixels of the image. This is stated in the product and in the README.

**If a checker reports an actual Content Credential:** that would be a real
bug. Please report it with the format and size of the image. The extension
re-scans its own output before saving and should never produce such a file.

## The panel looks wrong, or is hard to read

The panel chooses light or dark by measuring the page's background colour. If
ChatGPT changes its colours significantly the choice could go wrong.

The relevant function is `detectPageTheme` in `src/content/overlay.js`.

## The extension stopped working after I reloaded it

Reloading an extension in `chrome://extensions` disconnects every page that was
already open. Refresh your ChatGPT tabs.

## How to see technical errors

1. Open ChatGPT.
2. Press F12 to open developer tools, and choose the **Console** tab.
3. Look for lines starting `[CrediClean]`.

For problems with the background worker, go to `chrome://extensions`, find
CrediClean and click **service worker**.

These logs stay on your machine. Nothing is sent anywhere.

## Checking a file for yourself

Upload it to [contentcredentials.org/verify](https://contentcredentials.org/verify).
That service is run by the Content Authenticity Initiative, not by us, so it is
an independent check on whether credentials are present.

## "No supported credentials found" on an image that should have them

This message has three very different causes that look identical from the
outside. The extension can tell them apart for you.

### Read the diagnosis

1. On the page with the image, press **F12** and choose the **Console** tab.
2. Click **Inspect credentials** on the image.
3. Look for a collapsed line reading
   `[CrediClean] No credentials found on <platform>. Click to see why.`
4. Click it to expand.

The **Interpretation** line tells you which of the three cases you are in.

### Case 1: "the file we fetched contains no C2PA bytes at all"

The file we read genuinely has nothing in it. Two possibilities:

- **The original never had credentials.** Correct behaviour, nothing to fix.
- **We fetched a resized copy.** Image services often serve a smaller,
  re-encoded version of a picture, and re-encoding destroys the credentials.

To tell which, compare the **Format / size** line in the diagnosis against the
file you get by downloading the image from the site itself. If ours is smaller
or has different dimensions, we read a derivative, not the original, and the
adapter for that platform needs its address rewriting rule corrected.

This is exactly what was happening on Gemini, and why the Gemini adapter now
asks Google's CDN for the original with `=s0`.

### Case 2: "PARSER PROBLEM"

The file **does** contain C2PA byte markers but our engine did not parse a
manifest from them. That is a bug in CrediClean, not in the site.

Please report it with the full diagnosis object, which the console prints
underneath. It contains the container block list, which is what is needed to
find the fault.

### Case 3: unsupported or unreadable format

The diagnosis names the format. Version 0.2.0 reads PNG, JPEG and WebP.

### What to send if you want it fixed

The expanded diagnosis, and ideally the image file itself downloaded from the
site's own download button. Inspecting the real bytes settles the question
immediately.

## When the image comes from a `blob:` address

If the diagnosis shows `Fetched from : blob:...`, the page built those bytes in
memory rather than serving a file. Some apps re-encode a picture for display,
and re-encoding destroys all metadata, so the credentials are gone before
CrediClean sees anything.

You can tell from the **Container** line. A re-encoded JPEG shows only these:

```
FFE0 (JFIF)   FFDB (quantisation)   FFC0 (frame)   FFC4 (Huffman) x4
```

No `FFE1` and no `FFEB` means nothing survived. No change to the address can
recover it: there is no address, only manufactured bytes.

CrediClean handles this by looking for the original file elsewhere in the page,
usually behind a download link. If that fails, the markup has changed and we
need to see it.

### Send us the markup around the image

Open the console on the page with the image and paste this in:

```js
(() => {
  const img = [...document.querySelectorAll('img')]
    .filter((i) => i.naturalWidth > 200).pop();
  if (!img) return 'No large image found.';
  const out = { src: img.src.slice(0, 120), size: [img.naturalWidth, img.naturalHeight], links: [], attrs: [] };
  let node = img;
  for (let d = 0; node && d < 6; d++) {
    for (const a of node.querySelectorAll?.('a[href]') ?? []) {
      out.links.push({ href: a.getAttribute('href').slice(0, 160), download: a.hasAttribute('download') });
    }
    for (const el of node.querySelectorAll?.('*') ?? []) {
      for (const at of el.attributes ?? []) {
        if (/^https?:\/\//.test(at.value) && at.value.length < 300) {
          out.attrs.push(`${el.tagName}[${at.name}] = ${at.value.slice(0, 160)}`);
        }
      }
    }
    if (out.links.length || out.attrs.length) break;
    node = node.parentElement;
  }
  out.links = out.links.slice(0, 10);
  out.attrs = [...new Set(out.attrs)].slice(0, 10);
  return JSON.stringify(out, null, 2);
})()
```

It prints the image's address and every real web address near it. Send the
output. If the original file is reachable from the page at all, it will be in
that list, and pointing the adapter at it is a small change.

Nothing is uploaded anywhere. It only reads the page you are already looking at.
