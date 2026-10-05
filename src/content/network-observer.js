/**
 * Records the image addresses a page fetches, so a blob-backed <img> can be
 * traced back to the file it came from.
 *
 * WHY THIS EXISTS
 *
 * Gemini shows generated images from `blob:` addresses. A blob is bytes the
 * page built in memory. Diagnosing a real one showed a JPEG with no EXIF, no
 * XMP and no APP11 segment: the page had re-encoded the picture, destroying
 * its Content Credentials before the extension could see anything.
 *
 * Searching the markup for the original turned up nothing. The page keeps no
 * address for it anywhere in the DOM.
 *
 * But the page must have downloaded the picture from somewhere. This records
 * those downloads as they happen, so when the user asks about a blob-backed
 * image we have a list of real addresses to try instead.
 *
 * ============================= IMPORTANT ==============================
 * This runs in the PAGE'S OWN JavaScript world, not the extension's, which
 * is the only way to see the page's network calls. That makes it the most
 * intrusive code in this extension, so it is written to be impossible to
 * break the host page with:
 *
 *   - every wrapper calls through to the original, always;
 *   - every wrapper is wrapped in try/catch, and a failure falls straight
 *     through to the original behaviour;
 *   - nothing is ever blocked, delayed, rewritten or retried;
 *   - no response body is ever read, so no stream is consumed;
 *   - only addresses and content types are recorded, never image data.
 *
 * It is injected ONLY on platforms whose adapter asks for it. ChatGPT does
 * not, deliberately: it already works, and nothing here should put that at
 * risk.
 * ======================================================================
 */

(function installNetworkObserver() {
  const FLAG = '__crediCleanNetworkObserver';
  if (window[FLAG]) return;
  window[FLAG] = true;

  /** The most recent image responses, newest last. Addresses only. */
  const seen = [];
  const MAX_RECORDED = 40;

  function record(url, contentType, contentLength) {
    try {
      if (typeof url !== 'string' || !/^https?:/i.test(url)) return;
      // Only images, and only ones big enough to be real content.
      if (contentType && !/^image\//i.test(contentType)) return;
      if (contentLength && Number(contentLength) < 8192) return;

      const existing = seen.findIndex((entry) => entry.url === url);
      if (existing !== -1) seen.splice(existing, 1);

      seen.push({ url, contentType: contentType || '', bytes: Number(contentLength) || 0, at: Date.now() });
      while (seen.length > MAX_RECORDED) seen.shift();
    } catch {
      /* recording must never affect the page */
    }
  }

  /* --- finding addresses inside API responses -------------------------- */

  /*
   * The display image and the full-size original are SEPARATE files with
   * different identifiers. Confirmed on a live Gemini image:
   *
   *   displayed : /rd-gg/AJWXcNen2jLL...   JPEG 1024x559, no credentials
   *   full size : AJWXcNcIkIpyV0n2...      PNG  1408x768, credentials present
   *
   * The identifiers diverge after a few characters, so the full-size address
   * cannot be derived from the display one by rewriting it. But Gemini's own
   * download button knows it, which means the app was told it, which means it
   * arrived in an API response.
   *
   * So text responses are scanned for Google image addresses. The response is
   * CLONED first: cloning does not consume the body, so the page's own read of
   * it is completely unaffected.
   */
  const IMAGE_URL_PATTERN = /https:(?:\\?\/){2}lh\d*\.googleusercontent\.com(?:\\?\/)[^"'\\\s<>)]+/g;
  const MAX_SCAN_CHARS = 2 * 1024 * 1024;
  const MAX_URLS_PER_RESPONSE = 20;

  function scanTextForImageUrls(text) {
    try {
      if (typeof text !== 'string' || text.length === 0) return;
      const sample = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
      const matches = sample.match(IMAGE_URL_PATTERN);
      if (!matches) return;

      let added = 0;
      for (const match of matches) {
        if (added >= MAX_URLS_PER_RESPONSE) break;
        // JSON escapes forward slashes, so undo that before use.
        const url = match.replace(/\\\//g, '/');
        if (/googleusercontent\.com\/a\//.test(url)) continue; // profile pictures
        record(url, 'image/', 0);
        added += 1;
      }
    } catch {
      /* scanning must never affect the page */
    }
  }

  function isTextResponse(contentType) {
    return /json|text|javascript|xml/i.test(contentType || '');
  }

  /* --- fetch ---------------------------------------------------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function crediCleanFetch(...args) {
      const result = originalFetch.apply(this, args);
      try {
        if (result && typeof result.then === 'function') {
          result.then(
            (response) => {
              try {
                // Headers only. The body is never touched, so the page's own
                // read of it is completely unaffected.
                const contentType = response.headers && response.headers.get('content-type');
                record(
                  response.url,
                  contentType,
                  response.headers && response.headers.get('content-length'),
                );

                // Look inside API responses for the full-size image address.
                if (isTextResponse(contentType) && typeof response.clone === 'function') {
                  // clone() leaves the original body untouched.
                  response
                    .clone()
                    .text()
                    .then(scanTextForImageUrls)
                    .catch(() => {});
                }
              } catch {
                /* ignore */
              }
              return response;
            },
            (error) => error,
          );
        }
      } catch {
        /* ignore */
      }
      return result;
    };
  }

  /* --- XMLHttpRequest ------------------------------------------------- */

  const OriginalXhr = window.XMLHttpRequest;
  if (OriginalXhr && OriginalXhr.prototype) {
    const originalOpen = OriginalXhr.prototype.open;
    const originalSend = OriginalXhr.prototype.send;

    OriginalXhr.prototype.open = function crediCleanOpen(method, url, ...rest) {
      try {
        this[FLAG] = url;
      } catch {
        /* ignore */
      }
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXhr.prototype.send = function crediCleanSend(...args) {
      try {
        this.addEventListener('load', () => {
          try {
            const contentType = this.getResponseHeader && this.getResponseHeader('content-type');
            record(
              this.responseURL || this[FLAG],
              contentType,
              this.getResponseHeader && this.getResponseHeader('content-length'),
            );

            // Reading responseText does not consume anything: it is already
            // buffered by the time the load event fires.
            if (isTextResponse(contentType) && (this.responseType === '' || this.responseType === 'text')) {
              scanTextForImageUrls(this.responseText);
            }
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
      return originalSend.apply(this, args);
    };
  }

  /* --- downloads triggered by a link ---------------------------------- */

  /*
   * A download button is often an <a download>, and clicking one does not go
   * through fetch or XMLHttpRequest, so nothing above would see it.
   *
   * This matters here specifically: reporting suggests Gemini attaches
   * Content Credentials only to the FULL-SIZE DOWNLOAD, not to the image it
   * displays in the conversation. If that is right, the address behind the
   * download button is the only one that leads to a credentialed file, and
   * catching the click is the only way to learn it.
   *
   * Capture phase, passive, and purely observational: the click is never
   * intercepted or prevented.
   */
  function recordAnchor(anchor) {
    try {
      if (!anchor || anchor.tagName !== 'A') return;
      const href = anchor.href;
      if (typeof href !== 'string' || !/^https?:/i.test(href)) return;
      // A download link is worth recording whatever its content type, since we
      // cannot see headers for a navigation.
      record(href, anchor.hasAttribute('download') ? 'image/' : '', 0);
    } catch {
      /* ignore */
    }
  }

  try {
    document.addEventListener(
      'click',
      (event) => {
        try {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
          for (const node of path) {
            if (node && node.tagName === 'A') {
              recordAnchor(node);
              break;
            }
          }
        } catch {
          /* ignore */
        }
      },
      { capture: true, passive: true },
    );
  } catch {
    /* ignore */
  }

  // Programmatic clicks, which is how many download buttons work.
  try {
    const anchorPrototype = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
    if (anchorPrototype && typeof anchorPrototype.click === 'function') {
      const originalClick = anchorPrototype.click;
      anchorPrototype.click = function crediCleanAnchorClick(...args) {
        recordAnchor(this);
        return originalClick.apply(this, args);
      };
    }
  } catch {
    /* ignore */
  }

  /* --- answering the extension ---------------------------------------- */

  /*
   * The extension's own code runs in a separate world and cannot read these
   * variables directly, so it asks by dispatching an event and we answer with
   * one. Only addresses cross the boundary.
   */
  document.addEventListener('crediclean:ask-for-sources', () => {
    try {
      document.dispatchEvent(
        new CustomEvent('crediclean:sources', {
          detail: { urls: seen.map((entry) => entry.url) },
        }),
      );
    } catch {
      /* ignore */
    }
  });
})();
