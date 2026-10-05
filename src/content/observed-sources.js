/**
 * Reads the addresses recorded by the page-world network observer.
 *
 * The observer runs in the page's own JavaScript world and cannot share
 * variables with the extension, so the two sides talk by dispatching events on
 * the shared document. This is the extension's side of that conversation.
 */

const ASK_EVENT = 'crediclean:ask-for-sources';
const ANSWER_EVENT = 'crediclean:sources';
const TIMEOUT_MS = 250;

/**
 * Ask the observer which image addresses this page has downloaded.
 *
 * @returns {Promise<string[]>} addresses, oldest first; empty if the observer
 *   is not installed or does not answer
 */
export function observedImageUrls() {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (urls) => {
      if (settled) return;
      settled = true;
      document.removeEventListener(ANSWER_EVENT, onAnswer);
      clearTimeout(timer);
      resolve(urls);
    };

    const onAnswer = (event) => {
      const urls = event && event.detail && Array.isArray(event.detail.urls) ? event.detail.urls : [];
      finish(urls.filter((url) => typeof url === 'string'));
    };

    // The observer is only injected on some platforms, and may not be there at
    // all. Never wait on it: give up quickly and carry on with what we have.
    const timer = setTimeout(() => finish([]), TIMEOUT_MS);

    try {
      document.addEventListener(ANSWER_EVENT, onAnswer);
      document.dispatchEvent(new CustomEvent(ASK_EVENT));
    } catch {
      finish([]);
    }
  });
}
