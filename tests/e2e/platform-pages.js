/**
 * Reconstructed pages for each supported platform.
 *
 * IMPORTANT, AND THE WHOLE REASON THIS FILE CARRIES A WARNING:
 *
 * This markup is OUR RECONSTRUCTION of each site, built from the selectors in
 * the adapters. Passing these tests proves the adapter architecture, the
 * credential engine and the UI work together for a page shaped like this. It
 * does NOT prove the selectors still match the real Gemini or Grok, because
 * we have no accounts for them in this environment and build the markup from
 * the adapters rather than from a live capture.
 *
 * All three platforms were confirmed working on their live sites by hand.
 */

/** Markup per platform, keyed by adapter id. */
export const PLATFORM_PAGES = {
  chatgpt: {
    host: 'chatgpt.com',
    /*
     * ChatGPT's GPT / plugin pages, reconstructed from the real defect.
     *
     * Each card shows a GPT's icon. The icon is served from the SAME
     * user-content host as a generated image, and its source file is 512px
     * square, so the address rule and the file-size rule both say "content".
     * It is drawn at 40px, which is the only thing that distinguishes it.
     *
     * This page is why the button used to appear where it had no business
     * being. Nothing here may get a button.
     */
    storeBody: `
      <header>
        <img id="avatar" src="/avatar/user.png" width="32" height="32" alt="Profile">
      </header>
      <main>
        <h1>GPTs</h1>
        <div class="store">
          <a class="card" href="/g/g-aaa">
            <img id="gpt-icon-1" src="/img?id=gpt-icon" width="40" height="40" alt="Image Helper">
            <span>Image Helper</span>
          </a>
          <a class="card" href="/g/g-bbb">
            <img id="gpt-icon-2" src="/img?id=gpt-icon" width="40" height="40" alt="Logo Maker">
            <span>Logo Maker</span>
          </a>
        </div>
      </main>`,
    body: `
      <header>
        <img id="avatar" src="/avatar/user.png" width="32" height="32" alt="Profile">
      </header>
      <main>
        <div data-message-author-role="user"><p>Draw me a picture.</p></div>
        <div data-message-author-role="assistant" data-testid="conversation-turn-2">
          <p>Here is your image.</p>
          <img id="generated" class="generated" src="/img?id=file-signed" alt="A generated picture">
        </div>
      </main>`,
  },

  gemini: {
    host: 'gemini.google.com',
    /*
     * This page reproduces the REAL Gemini behaviour, confirmed on a live
     * image on 5 October 2026.
     *
     * The conversation shows a rendered derivative: a different file, at a
     * different address, with no credentials in it. The genuine full-size
     * original is a separate resource with its own identifier, which cannot be
     * derived from the display address. It carries the credentials.
     *
     *   displayed : /rd-gg/DISPLAYID   1024x559, no credentials
     *   full size : /FULLSIZEID        1408x768, credentials present
     *
     * The page never links to the full-size file. Its address appears only
     * inside an API response, JSON-escaped, which is the one place the
     * extension can find it without the user downloading anything first.
     *
     * NOTHING here clicks a download button. That is the point: the extension
     * must work on its own.
     */
    imageHost: 'lh3.googleusercontent.com',
    body: `
      <header>
        <img id="avatar" src="https://lh3.googleusercontent.com/a/ACg8ocK-profile" width="32" height="32" alt="Account">
      </header>
      <main>
        <user-query><p>Draw me a picture.</p></user-query>
        <model-response>
          <message-content>
            <p>Here is your image.</p>
            <img id="generated" class="generated" alt="A generated picture">
          </message-content>
        </model-response>
      </main>
      <script>
        // The app loads the conversation. The response mentions the full-size
        // original, escaped as JSON does it. Nothing else ever reveals it.
        fetch('https://gemini.google.com/api/conversation')
          .then((response) => response.json())
          .then((data) => { window.__loaded = data; })
          .catch(() => {});

        // The conversation displays a rendered derivative, via a blob.
        fetch('https://lh3.googleusercontent.com/rd-gg/DISPLAYID')
          .then((response) => response.blob())
          .then((blob) => {
            document.getElementById('generated').src = URL.createObjectURL(blob);
          })
          .catch(() => {});
      </script>`,
  },

  grok: {
    host: 'grok.com',
    body: `
      <header>
        <img id="avatar" src="/profile_images/1/me.jpg" width="32" height="32" alt="Account">
      </header>
      <main>
        <div role="log">
          <p>Here is your image.</p>
          <!-- Grok is the platform where we do NOT know whether credentials
               exist, so its page serves an image with none. The panel must say
               so plainly and offer nothing to remove. -->
          <img id="generated" class="generated" src="/img?id=file-unsigned" alt="A generated picture">
        </div>
      </main>`,
  },
};

/**
 * Just the inside of the store page's <main>, for the in-app navigation test.
 *
 * Taken from the page above rather than written out again, so the markup the
 * app "navigates to" is always the same markup the server would serve.
 */
export function chatgptStoreMain() {
  const match = /<main>([\s\S]*)<\/main>/.exec(PLATFORM_PAGES.chatgpt.storeBody);
  if (!match) throw new Error('the ChatGPT store fixture no longer has a <main>');
  return match[1];
}

/**
 * Which body to serve for a given address.
 *
 * The platform pages are single-page apps, so one host answers for several
 * different sections. ChatGPT is the one that matters here: its store pages
 * must not be the conversation page wearing a different address, or the test
 * would prove nothing about telling them apart.
 */
export function bodyForPath(platform, pathname = '/') {
  const page = PLATFORM_PAGES[platform];
  if (platform === 'chatgpt' && /^\/(gpts|g\/[^/]+$)/.test(pathname)) return page.storeBody;
  return page.body;
}

export function pageHtml(platform, pathname = '/') {
  const page = PLATFORM_PAGES[platform];
  return `<!doctype html>
<html lang="en" class="dark">
<head><meta charset="utf-8"><title>Mock ${platform}</title>
<style>
  body { background:#212121; color:#ececf1; font-family:system-ui; margin:0; }
  header { display:flex; align-items:center; gap:8px; padding:12px; }
  main { max-width:760px; margin:0 auto; padding:24px 24px 160px; }
  img.generated { max-width:100%; border-radius:12px; display:block; }
  #composer { position:fixed; bottom:0; left:0; right:0; height:120px;
    background:#303030; border-top:1px solid #444; display:flex;
    align-items:center; justify-content:center; z-index:5; }
  #composer input { width:60%; padding:14px; border-radius:24px; border:0; }
  .store { display:flex; gap:16px; flex-wrap:wrap; }
  .card { display:flex; align-items:center; gap:10px; padding:12px;
    background:#303030; border-radius:12px; color:inherit; text-decoration:none; }
  .card img { width:40px; height:40px; border-radius:8px; display:block; }
</style></head>
<body>
  ${bodyForPath(platform, pathname)}
  <div id="composer"><input placeholder="Ask something"></div>
</body></html>`;
}
