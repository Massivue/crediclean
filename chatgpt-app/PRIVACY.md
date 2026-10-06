# CrediClean for ChatGPT: privacy

Last updated: 6 October 2026. Applies to the CrediClean skill, version 1.0.0.

This covers the **ChatGPT skill**. The CrediClean **Chrome extension** is a
separate product with its own policy at
[PRIVACY.md](https://github.com/Massivue/crediclean/blob/main/PRIVACY.md).

---

## The short version

CrediClean collects nothing, stores nothing, and sends nothing anywhere.

It is a script that runs inside ChatGPT's own sandbox, on a file that is
already there. It has no server of its own, makes no network connections, and
has nowhere to send anything even if it wanted to.

## What it does with your image

1. It opens the image file where ChatGPT has already put it.
2. It reads the file's structure to find the Content Credentials.
3. It writes a new file with that block removed and every other byte copied
   across unchanged.
4. It finishes. Both files stay where ChatGPT keeps them, under ChatGPT's own
   rules, and are gone when your session ends.

Your original is never modified. The new file is a copy.

## What is collected

Nothing.

| | |
|---|---|
| Personal information | None collected |
| Your images | Never sent anywhere. Read and written in place |
| What you inspect or remove | Not recorded |
| Usage statistics or analytics | None |
| Accounts or sign-in | None. There is nothing to sign in to |
| Cookies or identifiers | None |
| Advertising or tracking | None. The data is not sold, shared or used for advertising |

## Network access

The skill makes **no network requests at all**. It needs none: the file is
already local to the sandbox it runs in.

You can confirm this yourself. The entire skill is one Python file,
`scripts/crediclean.py`, and it imports only `json` and `sys` from the
standard library. There is no HTTP client, no socket, and no URL anywhere in
it.

## What OpenAI sees

This matters, and is not ours to promise away.

Your conversation, and any image in it, is handled by **OpenAI** under
**OpenAI's own privacy policy**, exactly as it would be without this skill
installed. CrediClean does not change that and cannot.

What CrediClean adds is nothing: no extra collection, no extra sharing, and no
third party. But it also does not reduce or alter whatever OpenAI already
does with your conversation. For that, read OpenAI's policy.

## The honest limits of what this does to your image

This is a privacy matter, so it belongs here as well as in the listing.

CrediClean removes **metadata**. It does not remove **invisible watermarks**.

Some AI images carry a signal hidden in the pixels themselves. Google's
SynthID is the clearest example. That signal survives this process completely,
because it is part of the picture rather than part of the file's metadata.

**A processed image has had its Content Credentials removed. It has not been
made untraceable, undetectable, or human-made**, and CrediClean does not claim
otherwise anywhere.

## Changes to this policy

Any change will be published in this file, in the public repository, with the
date at the top updated. The history of every version is visible in the
repository's commit log.

## Contact

Questions or problems: <https://github.com/Massivue/crediclean/issues>

Source code: <https://github.com/Massivue/crediclean>
