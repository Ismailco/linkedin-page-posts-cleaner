const DEFAULT_CONFIG = {
  delayMinSeconds: 2,
  delayMaxSeconds: 6,
  maxActions: 50
};

const DEFAULT_STATE = {
  isRunning: false,
  stopRequested: false,
  status: "Idle",
  deletedCount: 0,
  skippedCount: 0,
  processedCount: 0,
  maxActions: DEFAULT_CONFIG.maxActions,
  currentTabId: null,
  sessionId: null,
  lastError: "",
  logs: [],
  config: { ...DEFAULT_CONFIG },
  updatedAt: Date.now()
};

let stateMutationQueue = Promise.resolve();

function isSupportedLinkedInActivityUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "www.linkedin.com" &&
      /^\/company\/[^/]+\/admin\/page-posts\/published\/?$/.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

function createLogEntry(message, level = "info") {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message,
    level,
    timestamp: new Date().toISOString()
  };
}

function sanitizeConfig(config = {}) {
  const min = Number.isFinite(Number(config.delayMinSeconds))
    ? Number(config.delayMinSeconds)
    : DEFAULT_CONFIG.delayMinSeconds;
  const max = Number.isFinite(Number(config.delayMaxSeconds))
    ? Number(config.delayMaxSeconds)
    : DEFAULT_CONFIG.delayMaxSeconds;
  const maxActions = Number.isFinite(Number(config.maxActions))
    ? Number(config.maxActions)
    : DEFAULT_CONFIG.maxActions;

  const clampedMin = Math.min(6, Math.max(2, Math.floor(min)));
  const clampedMax = Math.min(6, Math.max(clampedMin, Math.floor(max)));
  const clampedMaxActions = Math.min(50, Math.max(1, Math.floor(maxActions)));

  return {
    delayMinSeconds: clampedMin,
    delayMaxSeconds: clampedMax,
    maxActions: clampedMaxActions
  };
}

async function mutateState(mutator) {
  stateMutationQueue = stateMutationQueue
    .catch((error) => {
      console.error("State mutation queue reset after failure.", error);
    })
    .then(async () => {
      const stored = await chrome.storage.local.get("cleanerState");
      const currentState = {
        ...DEFAULT_STATE,
        ...(stored.cleanerState || {})
      };

      const nextState = (await mutator(currentState)) || currentState;
      await chrome.storage.local.set({
        cleanerState: {
          ...DEFAULT_STATE,
          ...nextState,
          updatedAt: Date.now()
        }
      });
    });

  return stateMutationQueue;
}

async function readState() {
  const stored = await chrome.storage.local.get("cleanerState");
  return {
    ...DEFAULT_STATE,
    ...(stored.cleanerState || {})
  };
}

async function appendLog(message, level = "info", sessionId = null) {
  await mutateState((state) => {
    if (sessionId && state.sessionId && state.sessionId !== sessionId) {
      return state;
    }

    const logs = [...state.logs, createLogEntry(message, level)].slice(-120);
    return {
      ...state,
      logs
    };
  });
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function sendMessageToTab(tabId, message) {
  if (!tabId) {
    return { ok: false, error: "Missing tab id." };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response || { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function startCleaner({ tabId, url, config }) {
  const cleanedConfig = sanitizeConfig(config);

  if (!tabId || !isSupportedLinkedInActivityUrl(url)) {
    const errorMessage =
      "Open the LinkedIn company admin published posts page before starting.";

    await mutateState((state) => ({
      ...state,
      isRunning: false,
      stopRequested: false,
      status: "Invalid page",
      lastError: errorMessage
    }));

    await appendLog(errorMessage, "error");

    return { ok: false, error: errorMessage };
  }

  const currentState = await readState();

  if (currentState.isRunning && currentState.currentTabId && currentState.currentTabId !== tabId) {
    await sendMessageToTab(currentState.currentTabId, { type: "cleaner:stop" });
  }

  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  await mutateState(() => ({
    ...DEFAULT_STATE,
    isRunning: true,
    stopRequested: false,
    status: "Starting",
    currentTabId: tabId,
    sessionId,
    config: cleanedConfig,
    maxActions: cleanedConfig.maxActions,
    logs: [createLogEntry("Session queued.", "info")]
  }));

  try {
    await ensureContentScript(tabId);
  } catch (error) {
    const errorMessage = `Unable to inject content script: ${error.message}`;

    await mutateState((state) => ({
      ...state,
      isRunning: false,
      status: "Error",
      lastError: errorMessage
    }));

    await appendLog(errorMessage, "error", sessionId);

    return { ok: false, error: errorMessage };
  }

  const response = await sendMessageToTab(tabId, {
    type: "cleaner:start",
    payload: {
      ...cleanedConfig,
      sessionId
    }
  });

  if (!response?.ok) {
    const errorMessage = response?.error || "Content script did not respond.";

    await mutateState((state) => ({
      ...state,
      isRunning: false,
      status: "Error",
      lastError: errorMessage
    }));

    await appendLog(errorMessage, "error", sessionId);

    return { ok: false, error: errorMessage };
  }

  await appendLog("Cleaner started.", "info", sessionId);

  return { ok: true };
}

async function stopCleaner(tabId) {
  const state = await readState();
  const targetTabId = tabId || state.currentTabId;

  await mutateState((currentState) => ({
    ...currentState,
    stopRequested: true,
    status: currentState.isRunning ? "Stopping" : "Stopped"
  }));

  await appendLog("Stop requested.", "warn", state.sessionId);

  const response = await sendMessageToTab(targetTabId, { type: "cleaner:stop" });

  return response?.ok
    ? { ok: true }
    : { ok: false, error: response?.error || "Unable to send stop command." };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    cleanerState: DEFAULT_STATE
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "popup:start": {
        const result = await startCleaner(message);
        sendResponse(result);
        return;
      }

      case "popup:stop": {
        const result = await stopCleaner(message.tabId);
        sendResponse(result);
        return;
      }

      case "cleaner:log": {
        const { entry, sessionId } = message.payload || {};
        if (entry?.message) {
          await appendLog(entry.message, entry.level || "info", sessionId);
        }
        sendResponse({ ok: true });
        return;
      }

      case "cleaner:state": {
        const { sessionId, state: partialState } = message.payload || {};

        if (!partialState) {
          sendResponse({ ok: false });
          return;
        }

        await mutateState((currentState) => {
          if (sessionId && currentState.sessionId && currentState.sessionId !== sessionId) {
            return currentState;
          }

          return {
            ...currentState,
            ...partialState,
            currentTabId: sender.tab?.id ?? currentState.currentTabId
          };
        });

        sendResponse({ ok: true });
        return;
      }

      case "popup:get-state": {
        const state = await readState();
        sendResponse({ ok: true, state });
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })().catch(async (error) => {
    await appendLog(error.message, "error");
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mutateState((state) => {
    if (state.currentTabId !== tabId) {
      return state;
    }

    return {
      ...state,
      isRunning: false,
      stopRequested: false,
      status: "Stopped",
      currentTabId: null,
      lastError: "Target tab was closed."
    };
  }).catch(() => {});
});
