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

export function pageHtml(platform) {
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
</style></head>
<body>
  ${page.body}
  <div id="composer"><input placeholder="Ask something"></div>
</body></html>`;
}
