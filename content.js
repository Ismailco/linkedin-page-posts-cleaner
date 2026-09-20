(() => {
  if (window.__linkedinActivityCleanerInjected) {
    return;
  }

  window.__linkedinActivityCleanerInjected = true;

  const MENU_TRIGGER_SELECTOR = [
    'button[aria-label*="More actions" i]',
    'button[aria-label*="control menu" i]',
    'button[aria-label*="options" i]',
    'button[aria-label*="actions" i]',
    'button[title*="More" i]',
    'button[title*="Options" i]',
    'button[aria-haspopup="menu"]',
    '[role="button"][aria-label*="More actions" i]',
    '[role="button"][aria-label*="control menu" i]',
    '[role="button"][aria-label*="options" i]',
    '[role="button"][aria-label*="actions" i]',
    '[role="button"][title*="More" i]',
    '[role="button"][title*="Options" i]',
    '[role="button"][aria-haspopup="menu"]'
  ].join(", ");

  const CLICKABLE_SELECTOR = [
    "button",
    "[role='button']",
    "[role='menuitem']",
    "li[role='menuitem']",
    "a"
  ].join(", ");

  const DELETE_PATTERNS = [
    /^delete$/i,
    /^delete post$/i,
    /^delete this post$/i,
    /^remove post$/i,
    /^remove this post$/i
  ];

  const MENU_HINT_PATTERNS = [
    /more actions/i,
    /more options/i,
    /open control menu/i,
    /control menu/i,
    /\boptions\b/i,
    /\bactions\b/i,
    /\bmenu\b/i,
    /\boverflow\b/i,
    /\bellipsis\b/i
  ];

  const POST_HINT_PATTERNS = [
    /\bview post\b/i,
    /\bboost\b/i,
    /\bpublished\b/i,
    /\bpost\b/i,
    /\bimpressions\b/i,
    /\bcomments\b/i,
    /\breactions\b/i,
    /\bshares\b/i,
    /\bclicks\b/i,
    /\bago\b/i
  ];

  const state = {
    running: false,
    stopRequested: false,
    sessionId: null,
    delayMinMs: 2000,
    delayMaxMs: 6000,
    maxActions: 50,
    deletedCount: 0,
    skippedCount: 0,
    processedCount: 0,
    processedKeys: new Set(),
    debugLogged: false,
    observer: null,
    mutationResolvers: new Set(),
    loopPromise: null
  };

  class StopRequestedError extends Error {
    constructor() {
      super("Stop requested.");
      this.name = "StopRequestedError";
    }
  }

  function normalizeText(value = "") {
    return value.replace(/\s+/g, " ").trim();
  }

  function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function randomBetween(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function isSupportedPage() {
    return /^\/company\/[^/]+\/admin\/page-posts\/published\/?$/.test(window.location.pathname);
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const styles = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      styles.display !== "none" &&
      styles.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function getVisibleElements(selector, root = document) {
    return Array.from(root.querySelectorAll(selector)).filter(isVisible);
  }

  function getClickableTarget(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    return element.closest(CLICKABLE_SELECTOR);
  }

  function getElementMetadataText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    return normalizeText(
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-control-name"),
        element.getAttribute("data-test-id"),
        element.getAttribute("aria-describedby"),
        element.textContent
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  function hasMenuIconHint(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const iconNodes = element.querySelectorAll("li-icon, svg, use, icon, span");

    for (const node of iconNodes) {
      const hint = normalizeText(
        [
          node.getAttribute("type"),
          node.getAttribute("href"),
          node.getAttribute("xlink:href"),
          node.getAttribute("data-test-icon"),
          node.getAttribute("aria-label"),
          node.getAttribute("class")
        ]
          .filter(Boolean)
          .join(" ")
      );

      if (/ellipsis|overflow|more|menu/i.test(hint)) {
        return true;
      }
    }

    return false;
  }

  function isLikelyMenuTrigger(element) {
    const clickable = getClickableTarget(element);

    if (!clickable || !isVisible(clickable)) {
      return false;
    }

    const rect = clickable.getBoundingClientRect();
    const metadataText = getElementMetadataText(clickable);

    if (clickable.getAttribute("aria-haspopup") === "menu") {
      return rect.width <= 120 && rect.height <= 80;
    }

    if (MENU_HINT_PATTERNS.some((pattern) => pattern.test(metadataText))) {
      return rect.width <= 180 && rect.height <= 100;
    }

    return rect.width <= 80 && rect.height <= 80 && hasMenuIconHint(clickable);
  }

  function getMenuTriggers(root = document) {
    const triggers = new Set();

    for (const matchedElement of getVisibleElements(MENU_TRIGGER_SELECTOR, root)) {
      const clickable = getClickableTarget(matchedElement);
      if (clickable) {
        triggers.add(clickable);
      }
    }

    for (const clickable of getVisibleElements(CLICKABLE_SELECTOR, root)) {
      if (isLikelyMenuTrigger(clickable)) {
        triggers.add(clickable);
      }
    }

    return Array.from(triggers);
  }

  function releaseMutationWaiters() {
    for (const resolve of state.mutationResolvers) {
      resolve();
    }
    state.mutationResolvers.clear();
  }

  async function sendMessage(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch {
      return null;
    }
  }

  async function pushState(partialState) {
    await sendMessage({
      type: "cleaner:state",
      payload: {
        sessionId: state.sessionId,
        state: partialState
      }
    });
  }

  async function log(message, level = "info") {
    await sendMessage({
      type: "cleaner:log",
      payload: {
        sessionId: state.sessionId,
        entry: {
          message,
          level
        }
      }
    });
  }

  function ensureMutationObserver() {
    if (state.observer) {
      return;
    }

    const target = document.querySelector("main") || document.body;

    state.observer = new MutationObserver((mutations) => {
      if (
        mutations.some((mutation) => mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
      ) {
        releaseMutationWaiters();
      }
    });

    state.observer.observe(target, {
      childList: true,
      subtree: true
    });
  }

  function throwIfStopped() {
    if (state.stopRequested) {
      throw new StopRequestedError();
    }
  }

  async function interruptibleSleep(durationMs) {
    let remaining = durationMs;

    while (remaining > 0) {
      throwIfStopped();
      const nextDelay = Math.min(remaining, 150);
      await new Promise((resolve) => window.setTimeout(resolve, nextDelay));
      remaining -= nextDelay;
    }
  }

  async function waitForCondition(predicate, timeoutMs, intervalMs = 200) {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      throwIfStopped();
      const result = predicate();
      if (result) {
        return result;
      }
      await interruptibleSleep(intervalMs);
    }

    return null;
  }

  async function waitForMutations(timeoutMs = 4000) {
    throwIfStopped();

    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        state.mutationResolvers.delete(onMutation);
        resolve(false);
      }, timeoutMs);

      const onMutation = () => {
        window.clearTimeout(timeoutId);
        state.mutationResolvers.delete(onMutation);
        resolve(true);
      };

      state.mutationResolvers.add(onMutation);
    });
  }

  function getPostKey(container) {
    const semanticId =
      container.getAttribute("data-urn") ||
      container.getAttribute("data-id") ||
      container.id;

    if (semanticId) {
      return semanticId;
    }

    const permalink = container.querySelector(
      'a[href*="/feed/update/"], a[href*="/posts/"], a[href*="/activity/"]'
    );

    if (permalink?.href) {
      return permalink.href;
    }

    return `hash:${hashString(normalizeText(container.innerText).slice(0, 220))}`;
  }

  function looksLikePostContainer(container) {
    if (!(container instanceof HTMLElement) || !isVisible(container)) {
      return false;
    }

    const rect = container.getBoundingClientRect();
    const text = normalizeText(container.innerText || container.textContent || "");

    if (rect.width < 260 || rect.height < 110 || text.length < 20) {
      return false;
    }

    if (
      container.querySelector(
        'a[href*="/feed/update/"], a[href*="/posts/"], a[href*="/activity/"], [data-urn], [data-id], [data-test-id*="post" i], [data-test-id*="update" i]'
      )
    ) {
      return true;
    }

    return POST_HINT_PATTERNS.some((pattern) => pattern.test(text));
  }

  function findLikelyPostContainer(menuTrigger) {
    const semanticContainer = menuTrigger.closest(
      '[role="listitem"], [role="article"], article, li, div[data-urn], div[data-id], .artdeco-card, [data-test-id*="post" i], [data-test-id*="update" i]'
    );

    if (semanticContainer && looksLikePostContainer(semanticContainer)) {
      return semanticContainer;
    }

    const main = document.querySelector("main");
    let node = menuTrigger.parentElement;
    let fallback = null;

    while (node && node !== main && node !== document.body) {
      if (looksLikePostContainer(node)) {
        fallback = node;
      }

      node = node.parentElement;
    }

    return fallback;
  }

  function findMenuTrigger(container) {
    const triggers = getMenuTriggers(container);

    return triggers.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();

      if (leftRect.top !== rightRect.top) {
        return leftRect.top - rightRect.top;
      }

      return rightRect.left - leftRect.left;
    })[0] || null;
  }

  function collectPostCandidates() {
    const root = document.querySelector("main") || document.body;
    const seenKeys = new Set();
    const candidates = [];

    for (const trigger of getMenuTriggers(root)) {
      const container = findLikelyPostContainer(trigger);

      if (!container) {
        continue;
      }

      const rect = container.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();

      if (rect.bottom < 60 || rect.height < 110) {
        continue;
      }

      if (triggerRect.right < rect.left + rect.width * 0.45) {
        continue;
      }

      const key = getPostKey(container);

      if (seenKeys.has(key) || state.processedKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      candidates.push({ key, container, trigger });
    }

    return candidates.sort(
      (left, right) =>
        left.container.getBoundingClientRect().top - right.container.getBoundingClientRect().top
    );
  }

  function findActionByText(root, patterns, restrictToDialog = false) {
    const candidates = root.matches?.(CLICKABLE_SELECTOR)
      ? [root, ...Array.from(root.querySelectorAll(CLICKABLE_SELECTOR))]
      : Array.from(root.querySelectorAll(CLICKABLE_SELECTOR));

    for (const candidate of candidates) {
      const clickable = getClickableTarget(candidate);
      if (!clickable || !isVisible(clickable)) {
        continue;
      }

      if (restrictToDialog && !clickable.closest('[role="dialog"], .artdeco-modal')) {
        continue;
      }

      const text = normalizeText(clickable.innerText || clickable.textContent || "");

      if (patterns.some((pattern) => pattern.test(text))) {
        return clickable;
      }
    }

    return null;
  }

  function findDeleteMenuAction() {
    const menuRoots = [
      ...getVisibleElements('[role="menu"]'),
      ...getVisibleElements(".artdeco-dropdown__content"),
      ...getVisibleElements(".artdeco-popover__content")
    ];

    for (const root of menuRoots) {
      const action = findActionByText(root, DELETE_PATTERNS);
      if (action) {
        return action;
      }
    }

    return findActionByText(document.body, DELETE_PATTERNS, false);
  }

  function findDeleteConfirmationButton() {
    const dialogRoots = getVisibleElements('[role="dialog"], .artdeco-modal, .artdeco-modal__content');

    for (const root of dialogRoots) {
      const action = findActionByText(root, DELETE_PATTERNS, true);
      if (action) {
        return action;
      }
    }

    return null;
  }

  async function humanClick(element) {
    if (!element) {
      throw new Error("Missing element to click.");
    }

    element.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center"
    });

    await interruptibleSleep(randomBetween(300, 700));

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    const clientY = rect.top + rect.height * (0.3 + Math.random() * 0.4);

    element.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        view: window
      })
    );

    await interruptibleSleep(randomBetween(80, 180));

    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        view: window
      })
    );

    await interruptibleSleep(randomBetween(60, 160));

    element.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        view: window
      })
    );

    element.click();
  }

  async function withRetries(action, attempts, actionName) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        throwIfStopped();
        return await action(attempt);
      } catch (error) {
        if (error instanceof StopRequestedError) {
          throw error;
        }

        lastError = error;
        await log(`${actionName} failed on attempt ${attempt}: ${error.message}`, "warn");
        await interruptibleSleep(randomBetween(350, 700));
      }
    }

    throw lastError || new Error(`${actionName} failed.`);
  }

  async function dismissOverlays() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      })
    );

    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Escape",
        bubbles: true
      })
    );

    await interruptibleSleep(randomBetween(120, 240));
  }

  async function waitForRemoval(container, key) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 9000) {
      throwIfStopped();

      if (!document.contains(container) || !isVisible(container)) {
        return true;
      }

      const currentKeys = new Set(collectPostCandidates().map((candidate) => candidate.key));
      if (!currentKeys.has(key)) {
        return true;
      }

      const toastMessages = getVisibleElements('[role="alert"], [aria-live="polite"], [aria-live="assertive"]');
      if (
        toastMessages.some((element) =>
          /deleted|removed/i.test(normalizeText(element.innerText || element.textContent || ""))
        )
      ) {
        return true;
      }

      await interruptibleSleep(250);
    }

    return false;
  }

  async function autoScrollForMore() {
    const offset = randomBetween(900, 1500);
    const beforeHeight = document.body.scrollHeight;

    window.scrollBy({
      top: offset,
      behavior: "smooth"
    });

    await interruptibleSleep(randomBetween(1200, 2200));

    const changed = await waitForMutations(randomBetween(2500, 4500));

    return changed || document.body.scrollHeight > beforeHeight;
  }

  async function processPost(candidate) {
    const { key, container } = candidate;
    state.processedKeys.add(key);
    state.processedCount += 1;

    await pushState({
      processedCount: state.processedCount,
      deletedCount: state.deletedCount,
      skippedCount: state.skippedCount,
      status: "Processing",
      isRunning: true
    });

    await withRetries(async () => {
      const menuTrigger = findMenuTrigger(container);

      if (!menuTrigger) {
        throw new Error("Post menu trigger not found.");
      }

      await humanClick(menuTrigger);

      const deleteAction = await waitForCondition(findDeleteMenuAction, 4000, 180);
      if (!deleteAction) {
        throw new Error("Delete action not found.");
      }

      await interruptibleSleep(randomBetween(180, 420));
      await humanClick(deleteAction);

      const confirmButton = await waitForCondition(findDeleteConfirmationButton, 5000, 180);
      if (!confirmButton) {
        throw new Error("Delete confirmation button not found.");
      }

      await interruptibleSleep(randomBetween(220, 500));
      await humanClick(confirmButton);
    }, 3, "Delete flow");

    const removed = await waitForRemoval(container, key);

    if (removed) {
      state.deletedCount += 1;
      await pushState({
        deletedCount: state.deletedCount,
        skippedCount: state.skippedCount,
        processedCount: state.processedCount,
        status: "Running",
        isRunning: true
      });
      await log(`Deleted post ${state.deletedCount}/${state.maxActions}.`);
      return true;
    }

    throw new Error("Deletion could not be confirmed.");
  }

  async function runCleaner() {
    ensureMutationObserver();
    await pushState({
      isRunning: true,
      stopRequested: false,
      status: "Running",
      deletedCount: state.deletedCount,
      skippedCount: state.skippedCount,
      processedCount: state.processedCount,
      maxActions: state.maxActions
    });

    await log("Cleaner loop started.");
    if (!state.debugLogged) {
      state.debugLogged = true;
      const root = document.querySelector("main") || document.body;
      await log(
        `Detection scan: ${getMenuTriggers(root).length} menu triggers, ${collectPostCandidates().length} post candidates.`
      );
    }

    let stalledScrolls = 0;

    while (!state.stopRequested && state.deletedCount < state.maxActions) {
      const candidates = collectPostCandidates();
      const nextCandidate = candidates.find(
        (candidate) => candidate.container.getBoundingClientRect().bottom > 60
      );

      if (!nextCandidate) {
        const loadedMore = await autoScrollForMore();
        stalledScrolls = loadedMore ? 0 : stalledScrolls + 1;

        if (stalledScrolls >= 3) {
          await log("No more matching posts were detected. Stopping.");
          break;
        }

        continue;
      }

      try {
        await processPost(nextCandidate);
      } catch (error) {
        if (error instanceof StopRequestedError) {
          throw error;
        }

        state.skippedCount += 1;
        await pushState({
          deletedCount: state.deletedCount,
          skippedCount: state.skippedCount,
          processedCount: state.processedCount,
          status: "Running",
          isRunning: true,
          lastError: error.message
        });

        await log(`Skipped a post: ${error.message}`, "warn");
        await dismissOverlays();
      }

      if (state.deletedCount >= state.maxActions) {
        await log(`Reached the safety limit of ${state.maxActions} posts.`);
        break;
      }

      await interruptibleSleep(
        randomBetween(state.delayMinMs, state.delayMaxMs) + randomBetween(150, 700)
      );
    }

    state.running = false;

    await pushState({
      isRunning: false,
      stopRequested: false,
      status: state.stopRequested ? "Stopped" : "Completed",
      deletedCount: state.deletedCount,
      skippedCount: state.skippedCount,
      processedCount: state.processedCount
    });

    await log(
      state.stopRequested
        ? "Cleaner stopped by user."
        : `Cleaner finished. Deleted ${state.deletedCount} posts.`,
      state.stopRequested ? "warn" : "info"
    );
  }

  async function startSession(payload) {
    if (!isSupportedPage()) {
      const error = "Open the LinkedIn company admin published posts page before starting.";
      await pushState({
        isRunning: false,
        status: "Invalid page",
        lastError: error
      });
      await log(error, "error");
      return { ok: false, error };
    }

    if (state.running) {
      return { ok: true };
    }

    state.sessionId = payload.sessionId;
    state.delayMinMs = payload.delayMinSeconds * 1000;
    state.delayMaxMs = payload.delayMaxSeconds * 1000;
    state.maxActions = payload.maxActions;
    state.deletedCount = 0;
    state.skippedCount = 0;
    state.processedCount = 0;
    state.processedKeys.clear();
    state.debugLogged = false;
    state.stopRequested = false;
    state.running = true;

    state.loopPromise = runCleaner().catch(async (error) => {
      state.running = false;

      if (error instanceof StopRequestedError) {
        await pushState({
          isRunning: false,
          stopRequested: false,
          status: "Stopped",
          deletedCount: state.deletedCount,
          skippedCount: state.skippedCount,
          processedCount: state.processedCount
        });
        await log("Cleaner stopped.", "warn");
        return;
      }

      await pushState({
        isRunning: false,
        stopRequested: false,
        status: "Error",
        lastError: error.message,
        deletedCount: state.deletedCount,
        skippedCount: state.skippedCount,
        processedCount: state.processedCount
      });
      await log(`Cleaner failed: ${error.message}`, "error");
    });

    return { ok: true };
  }

  function stopSession() {
    state.stopRequested = true;
    releaseMutationWaiters();

    pushState({
      isRunning: true,
      stopRequested: true,
      status: "Stopping",
      deletedCount: state.deletedCount,
      skippedCount: state.skippedCount,
      processedCount: state.processedCount
    }).catch(() => {});

    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case "cleaner:start":
          sendResponse(await startSession(message.payload || {}));
          return;
        case "cleaner:stop":
          sendResponse(stopSession());
          return;
        case "cleaner:ping":
          sendResponse({
            ok: true,
            supported: isSupportedPage(),
            running: state.running
          });
          return;
        default:
          sendResponse({ ok: false, error: "Unknown content message." });
      }
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

    return true;
  });
})();
