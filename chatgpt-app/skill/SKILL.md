---
name: crediclean
description: Inspect and remove C2PA Content Credentials from an image in the conversation, and give the user a clean copy to download. Use when someone asks what provenance or Content Credentials an image carries, or asks to remove or strip them from an AI-generated image. Does not remove invisible watermarks such as SynthID and never makes an image untraceable.
---

# CrediClean

Reads the Content Credentials (C2PA provenance metadata) inside an image and
can remove them, producing a copy the user can download.

Everything happens in this sandbox, on a file already here. Nothing is
uploaded anywhere and no network access is used or needed.

## What this does and does not do

**Does:** removes the metadata block that carries Content Credentials, and
copies every other byte of the file across unchanged.

**Does not:** remove invisible watermarks. Some AI images carry a signal
hidden in the pixels themselves, Google's SynthID being the clearest example.
That survives this completely. CrediClean handles metadata only.

**Never say** that a processed image is untraceable, undetectable, human-made,
or that its origin cannot be determined. None of those is true, and claiming
any of them is the one thing this tool must never do. Say what was removed,
and say what was not.

## How to use it

The script takes a path to an image file and prints JSON.

### To report what an image carries

```bash
python3 scripts/crediclean.py inspect <path-to-image>
```

Returns the format, the dimensions, whether credentials were found, and where
they sit in the file. Changes nothing.

### To remove them and produce a clean copy

```bash
python3 scripts/crediclean.py remove <path-to-image> [output-path]
```

Writes the clean copy and prints what was removed. If no output path is given
it writes alongside the input with `-processed` added to the name.

Add `--keep-xmp` to keep an XMP packet that references the manifest. By
default that packet is removed too, because leaving a pointer to a manifest
that is no longer there is both misleading and an incomplete removal. The
trade-off, worth mentioning to the user if they care: any unrelated XMP fields
in the same packet (author, copyright, caption) go with it.

## Typical flow

1. The user generates or uploads an image. It lands in this sandbox, usually
   under `/mnt/data/`.
2. Run `inspect` on it and tell the user what it holds: format, size, and
   whether credentials are present.
3. If they ask to remove them, run `remove`.
4. Give them the resulting file to download, and state plainly that the
   picture is unchanged and that invisible watermarks are not affected.

## Reading the result

Every run prints JSON with `ok` set to true or false.

When `ok` is false, `reason` says why, and the reasons mean different things:

| reason | What to tell the user |
|---|---|
| `nothing-to-remove` | No supported credentials are in this image. Do not imply anything was done |
| `unsupported-format` | Only PNG, JPEG and WebP can be processed |
| `unreadable` | The file could not be parsed. The original is untouched |
| `verification-failed` | **The result failed its own checks and was thrown away.** Say nothing was saved and the original is untouched. Do not offer a file |

When `ok` is true, `verified` lists the checks that passed. There are four,
and all four must pass before any file is written:

1. the output is still a valid image of the same format
2. no credentials remain in it
3. the dimensions are unchanged
4. the compressed picture data is byte-for-byte identical to the original

That fourth check is what proves nothing was re-compressed and no quality was
lost. If it ever fails, nothing is saved.

## Honesty rules for how you report this

- Say "Content Credentials found" or "No supported credentials found". Do not
  dress either up.
- Report what was removed, by name, from the `removed` list.
- Always repeat the limit from the `note` field. It is in every successful
  result for exactly this reason.
- If nothing was found, say so plainly and offer nothing. Do not run `remove`
  to be helpful, and do not imply a removal happened.
- Do not describe the C2PA standard, manifests or JUMBF to the user unless
  they ask. They want to know what is in their image and what they can do
  about it.
