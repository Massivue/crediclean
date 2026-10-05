/**
 * CrediClean content script: the entry point that runs on ChatGPT.
 *
 * A Manifest V3 content script cannot use `import` statements directly, so this
 * file is a small classic script that dynamically imports the real modules from
 * the extension package. Those modules are listed in `web_accessible_resources`
 * in the manifest, which is what makes the dynamic import possible.
 *
 * Keeping the logic in modules means the exact same code that runs in the
 * browser is also what the test suite runs under Node, with no build step and
 * no second copy to keep in sync.
 */

(async function bootstrap() {
  // Guard against being injected twice (for example after an extension reload).
  if (window.__crediCleanLoaded) return;
  window.__crediCleanLoaded = true;

  const moduleUrl = (path) => chrome.runtime.getURL(`src/${path}`);

  let modules;
  try {
    modules = await Promise.all([
      import(moduleUrl('content/image-detector.js')),
      import(moduleUrl('content/overlay.js')),
      import(moduleUrl('content/button-manager.js')),
      import(moduleUrl('processing/image-loader.js')),
      import(moduleUrl('processing/metadata-inspector.js')),
      import(moduleUrl('processing/credential-processor.js')),
      import(moduleUrl('processing/download-manager.js')),
      import(moduleUrl('shared/settings.js')),
      import(moduleUrl('platforms/index.js')),
      import(moduleUrl('content/observed-sources.js')),
    ]);
  } catch (error) {
    // Without the modules there is nothing we can do, but we must not break the
    // page. Log for local debugging and stop.
    console.warn('[CrediClean] Could not load its own modules; the extension is inactive.', error);
    return;
  }

  const [
    detector,
    overlayModule,
    ui,
    imageLoader,
    inspectorModule,
    processorModule,
    downloadManager,
    settingsModule,
    platforms,
    observedSources,
  ] = modules;

  /*
   * Which site are we on? Everything site-specific lives in that platform's
   * adapter; the rest of the extension is shared. If no adapter claims this
   * host we do nothing at all rather than guess at the page structure.
   */
  const adapter = platforms.currentAdapter();
  if (!adapter) {
    console.warn('[CrediClean] No platform adapter for this site; staying inactive.');
    return;
  }
  detector.setAdapter(adapter);

  const { OUTCOME } = processorModule;

  let settings = await settingsModule.loadSettings();
  const overlay = new overlayModule.Overlay();
  let watcher = null;
  let buttons = null;

  /* --------------------------------------------------------------------- */
  /* The main action: read the image, inspect it, offer what we can do      */
  /* --------------------------------------------------------------------- */

  async function handleInspect(entry, badgeUi) {
    badgeUi.setBusy(true, 'Reading\u2026');

    // Some sites show a resized derivative of the real file. Ask the adapter
    // for better addresses first; the page's own address stays as a fallback.
    let candidates = imageLoader.sourceUrlCandidates(entry.img, adapter);

    /*
     * When the image is a blob the page built, the bytes behind it may have
     * been re-encoded and stripped of everything. Ask the page-world observer
     * what this page actually downloaded, and try those real addresses first.
     * The acceptance check below is what stops us picking the wrong one.
     */
    if (adapter.observeNetworkSources && String(candidates[0] || '').startsWith('blob:')) {
      const observed = await observedSources.observedImageUrls();
      if (observed.length > 0) {
        // Newest first: the image just asked about is the likeliest match.
        // Each observed address is also put through the adapter's rewrites, so
        // the original-size forms are tried as well as the address itself.
        const extra = [];
        for (const observedUrl of [...observed].reverse()) {
          const forms =
            typeof adapter.sourceUrlCandidates === 'function'
              ? adapter.sourceUrlCandidates(observedUrl)
              : [observedUrl];
          for (const form of forms) {
            if (!extra.includes(form) && !candidates.includes(form)) extra.push(form);
          }
        }
        candidates = [...extra, ...candidates];
      }

    // Fetching is cheap but not free, so cap how many addresses we will try.
    if (candidates.length > 12) {
      const blob = candidates[candidates.length - 1];
      candidates = [...candidates.slice(0, 11), blob];
    }
    }

    /*
     * Guard against processing the wrong picture.
     *
     * Some candidates come from addresses found in the page's markup, which
     * could belong to a different image. Accept one only if what comes back
     * has the same shape as the image on screen: the same aspect ratio, and at
     * least as many pixels. The address from the <img> itself is always
     * accepted, so this can only ever narrow a wrong choice, never fail open.
     */
    const displayed = { width: entry.img.naturalWidth || 0, height: entry.img.naturalHeight || 0 };
    const accept = (bytes) => {
      if (!displayed.width || !displayed.height) return true;
      try {
        const candidate = inspectorModule.inspectImage(bytes);
        if (!candidate.dimensions) return false;
        const shownRatio = displayed.width / displayed.height;
        const candidateRatio = candidate.dimensions.width / candidate.dimensions.height;
        const sameShape = Math.abs(shownRatio - candidateRatio) / shownRatio < 0.02;
        const bigEnough = candidate.dimensions.width >= displayed.width * 0.95;
        return sameShape && bigEnough;
      } catch {
        return false;
      }
    };

    /*
     * Among the addresses that plausibly show the same picture, strongly
     * prefer one that actually carries credentials. That is almost certainly
     * the real original, and it is a far better signal than ordering alone.
     */
    const prefer = (bytes) => {
      try {
        const candidate = inspectorModule.inspectImage(bytes);
        if (candidate.status !== inspectorModule.STATUS.CREDENTIALS_DETECTED) return false;
        if (!displayed.width || !displayed.height || !candidate.dimensions) return true;
        const shownRatio = displayed.width / displayed.height;
        const candidateRatio = candidate.dimensions.width / candidate.dimensions.height;
        // Wider tolerance here: an uncropped original may be a little
        // differently shaped than the version shown in the conversation.
        return Math.abs(shownRatio - candidateRatio) / shownRatio < 0.12;
      } catch {
        return false;
      }
    };

    const loaded = await imageLoader.loadFirstAvailable(candidates, { accept, prefer });
    const url = loaded.url || candidates[0];

    // The user may have scrolled the image away or switched conversation while
    // we were fetching. Do not draw a panel onto an image that has gone.
    if (!entry.img.isConnected) {
      badgeUi.setBusy(false);
      return;
    }

    if (!loaded.ok) {
      badgeUi.setBusy(false);
      badgeUi.showPanel((body) => ui.renderError(body, loaded.error || 'Please try again.'));
      return;
    }

    let report;
    try {
      report = inspectorModule.inspectImage(loaded.bytes);
    } catch (error) {
      console.warn('[CrediClean] Inspection failed.', error);
      badgeUi.setBusy(false);
      badgeUi.showPanel((body) => ui.renderError(body, 'Please try again.'));
      return;
    }

    badgeUi.setBusy(false);

    /*
     * When nothing is found, say why in the console.
     *
     * "No supported credentials found" has three very different causes that
     * look identical from outside: the file really has none, we fetched a
     * re-encoded copy that lost them, or our parser missed them. The
     * diagnosis separates those, and is the single thing worth pasting into a
     * bug report. It goes to the console only, never into the panel.
     */
    if (report.status === inspectorModule.STATUS.NO_CREDENTIALS_DETECTED) {
      try {
        const diagnosis = inspectorModule.diagnoseImage(loaded.bytes);
        console.groupCollapsed(
          `[CrediClean] No credentials found on ${adapter.name}. Click to see why.`,
        );
        console.log('Interpretation:', diagnosis.interpretation);
        console.log('Fetched from  :', url);
        console.log('Addresses tried:', candidates);
        if (String(url).startsWith('blob:')) {
          console.warn(
            'This came from a blob: address, which means the page built these bytes ' +
              'itself rather than serving a file. If the container above shows only ' +
              'JFIF, quantisation, frame and Huffman segments, the page re-encoded the ' +
              'picture and destroyed its metadata before CrediClean could see it. ' +
              'The original must be found elsewhere in the page. Run the snippet in ' +
              'docs/TROUBLESHOOTING.md and send the output.',
          );
        }
        console.log('Format / size :', diagnosis.format, diagnosis.byteLength, 'bytes',
          diagnosis.dimensions ? `${diagnosis.dimensions.width}x${diagnosis.dimensions.height}` : '');
        console.log('Container     :', diagnosis.containerBlocks.join('  '));
        console.log('C2PA byte markers:', diagnosis.rawMarkers);
        console.log('Full diagnosis:', diagnosis);
        console.groupEnd();
      } catch (error) {
        console.warn('[CrediClean] Diagnosis failed.', error);
      }
    }

    const altText = entry.img.getAttribute('alt') || '';
    const filename = downloadManager.sourceFilename({ url, format: report.format, altText });

    badgeUi.showPanel((body, controls) => {
      // One state object drives every phase, so the panel keeps the same shape
      // from first open through to the saved confirmation.
      const state = {
        report,
        filename,
        phase: 'ready',
        onClose: controls.close,
        onRemove: () => runRemoval({ body, state, report, bytes: loaded.bytes, url, altText }),
      };
      ui.renderPanel(body, state);
    });
  }

  /**
   * Process and save, straight from the one button press.
   *
   * There is deliberately no second confirmation. Pressing a button labelled
   * "Remove credentials & save" is the confirmation, and the original image is
   * never modified, so the action is not destructive.
   */
  function runRemoval({ body, state, report, bytes, url, altText }) {
    ui.renderPanel(body, { ...state, phase: 'working' });

    // Processing is synchronous byte work. Yield once so the "Removing..."
    // state actually paints before the main thread is busy.
    setTimeout(() => {
      let result;
      try {
        result = processorModule.removeCredentials(bytes, {
          removeXmpProvenanceReference: settings.removeXmpProvenanceReference,
        });
      } catch (error) {
        console.warn('[CrediClean] Processing failed.', error);
        ui.renderPanel(body, { ...state, phase: 'error', message: 'Please try again.' });
        return;
      }

      if (!result.ok) {
        // Technical detail goes to the console only; the user gets plain words.
        console.warn('[CrediClean] Not processed:', result.outcome, result.message);
        ui.renderPanel(body, {
          ...state,
          phase: 'error',
          message:
            result.outcome === OUTCOME.VERIFICATION_FAILED
              ? 'The result failed our checks, so nothing was saved. Your original is untouched.'
              : 'Please try again.',
        });
        return;
      }

      const filename = downloadManager.buildFilename({ url, format: report.format, altText });
      const saved = downloadManager.downloadBytes(result.output, filename, report.format);
      if (!saved.ok) {
        console.warn('[CrediClean] Download failed:', saved.error);
        ui.renderPanel(body, { ...state, phase: 'error', message: 'The file could not be saved.' });
        return;
      }

      // Only now, with the file written, report success.
      ui.renderPanel(body, { ...state, phase: 'saved' });
    }, 16);
  }

  /* --------------------------------------------------------------------- */
  /* Start, stop, and react to settings changes                             */
  /* --------------------------------------------------------------------- */

  function start() {
    if (watcher) return;
    overlay.mount();
    buttons = new ui.ButtonManager({ overlay, onInspect: handleInspect });
    watcher = new detector.ImageWatcher((entries) => {
      if (!settings.enabled || !settings.showImageButtons) return;
      buttons.attach(entries);
    });
    watcher.start();
  }

  function stop() {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    if (buttons) {
      buttons.detachAll();
      buttons = null;
    }
    overlay.unmount();
  }

  function applySettings(next) {
    settings = next;
    if (settings.enabled && settings.showImageButtons) start();
    else stop();
  }

  settingsModule.onSettingsChanged(applySettings);
  applySettings(settings);
})();
