# Publishing CrediClean to the ChatGPT plugin directory

Step by step, in order. Everything the archive can carry is already done; what
remains needs a person with an account and a card.

**Sources:** every claim about OpenAI's process here comes from their own
documentation read through a search engine, because their site is unreachable
from the machine this was written on. Confirm each screen as you reach it, and
if something differs, the fix is usually one line in
`scripts/package-plugin.js`.

---

## Where to go: two different places, and mixing them up wastes a day

**The place you tested is NOT the place you publish.** They look similar and
they are not the same thing.

| | Testing (what you did) | Publishing (what you want now) |
|---|---|---|
| Where | **ChatGPT itself** | **The OpenAI developer dashboard** |
| Path | Plugins → Add → Upload plugin archive | Plugins → Upload new or existing plugin |
| Who gets it | **Only you** | **Everyone**, after review |
| Needs verified identity | No | **Yes** |
| Review | None | Scans, then a human |

Uploading in ChatGPT installs the plugin for your own account. It does not
submit anything to anybody, and nobody else can see it. That is why it worked
instantly.

### The addresses

| What | Where |
|---|---|
| **Official submission instructions** | <https://developers.openai.com/plugins/deploy/submission> |
| The same page, other site | <https://learn.chatgpt.com/docs/submit-plugins> |
| **Identity verification** | <https://platform.openai.com/settings> → organization → **General** |
| Submission errors explained | <https://developers.openai.com/plugins/deploy/submission-errors> |
| Plugin rules you must meet | <https://developers.openai.com/plugins/plugin-guidelines> |

**Honesty about these links.** Every OpenAI domain is blocked from the machine
this was written on, so I could not open any of them. The two documentation
addresses are real pages that a search index returned; the verification path
is OpenAI's own wording ("complete individual or business verification in
organization settings", in the "OpenAI Platform Dashboard general settings"),
with the exact sub-page inferred rather than seen.

**There is no deep link to the upload screen that I can confirm.** Sign in to
the developer dashboard and look for **Plugins** in the navigation. The
submission instructions page above is the reliable starting point: open it,
and follow its own link to the portal.

---

## Before you start: the one thing that might stop this

Approval is **not** guaranteed, and the reason is not technical.

You are asking OpenAI to put in their own directory a tool that removes
OpenAI's own provenance data from OpenAI's own generated images, at a time
when they cite that provenance work to regulators. A reviewer does not have to
decide CrediClean is harmful. They only have to decide it is close enough to
"bypassing a safety mitigation" to be not worth the argument.

I cannot give you odds. I have no data on how OpenAI treats this category and
know of no comparable app that has been through it.

**What is on your side:** removing metadata is lawful and ordinary. It happens
by accident every time an image is resized, screenshotted or re-uploaded, and
OpenAI's own documentation says so. CrediClean does not touch SynthID, which
is the signal OpenAI now relies on, and it says that everywhere, including in
the listing text a reviewer will read.

**Decide now whether a rejection would be a problem for you.** If it would,
the Chrome extension already reaches users without anyone's approval.

---

## Step 1 — Get the archive

```bash
cd chatgpt-app
npm run check      # 33 unit, 52 end-to-end, 34 widget checks
npm run package    # builds build/crediclean-plugin-1.0.0.zip
```

`npm run package` refuses to build if the manifest breaks a rule the portal
enforces, so an archive that builds has already passed the checks that are
knowable in advance: name length, semantic version, the 30-character short
description, the exact category name, and the required author and interface
fields. It also refuses to build listing copy that claims an image becomes
untraceable.

## Step 2 — Verify your identity

Publishing under a name requires it.

> Organization settings → complete **individual or business verification**

Verify as **Massivue** if you want the listing to say Massivue. Organization
owners can submit; anyone else needs the **Apps Management Write** permission,
which an owner grants in organization roles.

Do this early. Verification is the step most likely to take days rather than
minutes, and nothing else can finish without it.

## Step 3 — Publish the privacy policy where it can be read

The submission requires a **public** privacy policy URL. The manifest points
at:

```
https://github.com/Massivue/crediclean/blob/main/chatgpt-app/PRIVACY.md
```

That file exists in the repository already. **Check the link opens in a
private browser window.** If the repository is private, that URL will 404 for
the reviewer and the submission will fail on a detail that takes two minutes
to fix.

The same applies to the support and website URLs in the manifest.

## Step 4 — Upload and create the draft

In the **developer dashboard**, not in ChatGPT.

1. Open **Plugins**.
2. Select **Upload new or existing plugin**.
3. Choose your **verified Developer identity**. Whatever name you pick here is
   the publisher name shown in the directory, so pick the Massivue one.
4. Select **Upload plugin** and choose `crediclean-plugin-1.0.0.zip`.
5. Choose **Skills only** when asked what kind of plugin this is.

Step 5 matters. CrediClean has no MCP server in this archive, and a
skills-only plugin skips requirements that would otherwise apply: **no MCP
review cases, and no demo recording**.

After validation the plugin's detail page opens with your draft. **If
validation fails it names the package errors**; fix them per step 6 and upload
again.

The portal converts your manifest and fills in interface defaults. **Read what
it generated** before going further, particularly the display name, the short
description and the category.

## Step 5 — Let the scans run

Every bundled skill is scanned automatically for security, privacy and policy
compliance.

**This can take up to two hours.** That is normal. Do not re-upload while it
runs.

The plugin's detail page shows progress and any findings.

## Step 6 — Clear the findings

Findings come in two kinds, and they are not equal:

| Kind | What to do |
|---|---|
| **Required setup and validation errors** | **Must** be fixed before you can submit |
| Other automated findings | Can be sent to the review team with an explanation |

To fix an error: correct it in `scripts/package-plugin.js`, run
`npm run package` again, then use **Upload plugin to fix issues** and upload
the new ZIP. Do not hand-edit the ZIP; the script is the source of truth and a
hand edit will be lost on the next build.

If a finding names a rule the build did not catch, **add that rule to the
`validate()` function** as well as fixing the value. That is the whole point
of having it.

## Step 7 — Complete the listing

Most of it comes from the manifest. What the portal asks for separately:

| Field | Where it comes from |
|---|---|
| Display name | `CrediClean` |
| Short description | `Clean Content Credentials` (25 characters) |
| Long description | In the manifest. States what it does not do |
| Category | `Productivity` |
| Developer name | `Massivue` |
| Privacy policy URL | The GitHub link above |
| Support URL | `https://github.com/Massivue/crediclean/issues` |
| Website | `https://github.com/Massivue/crediclean` |

**Do not soften the long description to make it sell better.** The sentence
saying CrediClean does not remove invisible watermarks and does not make an
image untraceable is the most important sentence in the listing. It is what
makes the honest case to a reviewer, and it is what stops a user believing
something untrue. The build will refuse to package a listing that claims
otherwise.

## Step 8 — Attest and submit

You will be asked to confirm the policy attestations. Answer them truthfully.
The ones that apply here:

- **Data collected: none.** True, and verifiable: the skill is one Python file
  that imports only `json` and `sys`. A test asserts this, so the claim cannot
  quietly become false.
- **No network access.** True, for the same reason.
- **No accounts or authentication.** True.

Then submit the draft.

## Step 9 — Wait, then publish

Track progress under **Review status** on the Plugins page. The review team's
feedback arrives **by email**.

**Approval is not the same as being live.** Once approved, you still choose
when to release it: open the approved package version and select **Publish
plugin**. Until you do that, nobody can install it.

## Step 10 — Responding to the review

I do not know the current review time and will not invent a figure.

If it comes back with questions, answer them directly and do not overclaim.
The strongest thing you have is that the product is precise about its own
limits, and the code backs every claim up.

---

## If it is rejected

Not the end of anything.

1. **Read exactly what they objected to.** "Policy" and "a field is wrong" are
   very different problems.
2. **A field problem** is a one-line fix and a re-upload.
3. **A policy objection** is worth one careful appeal that points at what the
   tool actually does: removes metadata, states its limits, does not touch
   SynthID, does not claim untraceability. If that does not land, accept it.
4. **The Chrome extension needs nobody's approval**, reaches users in the EU
   and UK where ChatGPT apps reportedly do not, and already works.

## Keeping it honest after launch

- **Any change to the credential logic goes in `src/processing/` first**, not
  in the skill's Python. `npm test` fails if the two produce different bytes.
- **Bump the version** in `chatgpt-app/package.json` for every resubmission.
  The portal requires a higher semantic version.
- **If you ever add a network call to the skill**, the privacy test fails on
  purpose. Update `PRIVACY.md` and the attestations before overriding it, not
  after.
