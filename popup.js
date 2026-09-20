const DEFAULT_CONFIG = {
  delayMinSeconds: 2,
  delayMaxSeconds: 6,
  maxActions: 50
};

const DEFAULT_STATE = {
  isRunning: false,
  status: "Idle",
  deletedCount: 0,
  processedCount: 0,
  skippedCount: 0,
  lastError: "",
  logs: [],
  config: { ...DEFAULT_CONFIG }
};

const elements = {
  delayMin: document.getElementById("delayMin"),
  delayMax: document.getElementById("delayMax"),
  maxActions: document.getElementById("maxActions"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  deletedCount: document.getElementById("deletedCount"),
  processedCount: document.getElementById("processedCount"),
  skippedCount: document.getElementById("skippedCount"),
  pageStatus: document.getElementById("pageStatus"),
  pageStatusDot: document.getElementById("pageStatusDot"),
  statusPill: document.getElementById("statusPill"),
  progressBar: document.getElementById("progressBar"),
  progressLabel: document.getElementById("progressLabel"),
  progressPercent: document.getElementById("progressPercent"),
  progressTrack: document.querySelector('[role="progressbar"]'),
  logCount: document.getElementById("logCount"),
  lastError: document.getElementById("lastError"),
  logList: document.getElementById("logList")
};

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

function clampConfig(config) {
  const min = Math.min(6, Math.max(2, Number(config.delayMinSeconds) || DEFAULT_CONFIG.delayMinSeconds));
  const max = Math.min(6, Math.max(min, Number(config.delayMaxSeconds) || DEFAULT_CONFIG.delayMaxSeconds));
  const maxActions = Math.min(50, Math.max(1, Number(config.maxActions) || DEFAULT_CONFIG.maxActions));

  return {
    delayMinSeconds: Math.floor(min),
    delayMaxSeconds: Math.floor(max),
    maxActions: Math.floor(maxActions)
  };
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "--:--:--";
  }
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs[0] || null;
}

async function getState() {
  const response = await chrome.runtime.sendMessage({ type: "popup:get-state" });
  return {
    ...DEFAULT_STATE,
    ...(response?.state || {})
  };
}

function renderPageStatus(tab) {
  if (!tab?.url) {
    elements.pageStatus.textContent = "Open the LinkedIn company admin published posts page first.";
    elements.pageStatus.dataset.state = "invalid";
    elements.pageStatusDot.dataset.state = "";
    return;
  }

  const isReady = isSupportedLinkedInActivityUrl(tab.url);
  elements.pageStatus.textContent = isReady
    ? "Ready on the published posts page."
    : "Open a LinkedIn company admin published posts page to use this tool.";
  elements.pageStatus.dataset.state = isReady ? "ready" : "invalid";
  elements.pageStatusDot.dataset.state = isReady ? "ready" : "";
}

function syncInputs(config) {
  elements.delayMin.value = config.delayMinSeconds;
  elements.delayMax.value = config.delayMaxSeconds;
  elements.maxActions.value = config.maxActions;
}

function renderLogs(logs) {
  elements.logList.textContent = "";

  const visibleLogs = [...logs].slice(-12).reverse();
  elements.logCount.textContent = `${logs.length} ${logs.length === 1 ? "entry" : "entries"}`;

  if (visibleLogs.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "log-item";
    emptyItem.textContent = "No activity yet.";
    elements.logList.appendChild(emptyItem);
    return;
  }

  for (const entry of visibleLogs) {
    const item = document.createElement("li");
    item.className = "log-item";

    const time = document.createElement("small");
    time.textContent = formatTime(entry.timestamp);

    const message = document.createElement("div");
    message.textContent = entry.message;

    item.append(time, message);
    elements.logList.appendChild(item);
  }
}

function renderState(state) {
  const mergedState = {
    ...DEFAULT_STATE,
    ...state
  };

  elements.deletedCount.textContent = String(mergedState.deletedCount || 0);
  elements.processedCount.textContent = String(mergedState.processedCount || 0);
  elements.skippedCount.textContent = String(mergedState.skippedCount || 0);
  elements.lastError.textContent = mergedState.lastError || "";
  elements.lastError.hidden = !mergedState.lastError;
  elements.statusPill.textContent = mergedState.status || "Idle";

  const maxActions = Number(
    mergedState.config?.maxActions || mergedState.maxActions || DEFAULT_CONFIG.maxActions
  );
  const processedCount = Number(mergedState.processedCount || 0);
  const progress = Math.min(100, Math.round((processedCount / maxActions) * 100));
  elements.progressBar.style.width = `${progress}%`;
  elements.progressLabel.textContent = `${processedCount} of ${maxActions} processed`;
  elements.progressPercent.textContent = `${progress}%`;
  elements.progressTrack.setAttribute("aria-valuemax", String(maxActions));
  elements.progressTrack.setAttribute(
    "aria-valuenow",
    String(Math.min(processedCount, maxActions))
  );

  if (mergedState.isRunning) {
    elements.statusPill.dataset.state = "running";
  } else if (/error|invalid/i.test(mergedState.status || "")) {
    elements.statusPill.dataset.state = "error";
  } else if (/stopping|stopped/i.test(mergedState.status || "")) {
    elements.statusPill.dataset.state = "warn";
  } else {
    elements.statusPill.dataset.state = "";
  }

  elements.startButton.disabled = Boolean(mergedState.isRunning);
  elements.stopButton.disabled = !mergedState.isRunning && mergedState.status !== "Stopping";

  renderLogs(mergedState.logs || []);
}

function readConfigFromInputs() {
  const config = clampConfig({
    delayMinSeconds: elements.delayMin.value,
    delayMaxSeconds: elements.delayMax.value,
    maxActions: elements.maxActions.value
  });

  syncInputs(config);
  return config;
}

async function handleStart() {
  const tab = await getCurrentTab();
  renderPageStatus(tab);

  const result = await chrome.runtime.sendMessage({
    type: "popup:start",
    tabId: tab?.id,
    url: tab?.url,
    config: readConfigFromInputs()
  });

  if (!result?.ok) {
    const state = await getState();
    renderState(state);
  }
}

async function handleStop() {
  const tab = await getCurrentTab();
  await chrome.runtime.sendMessage({
    type: "popup:stop",
    tabId: tab?.id
  });
}

async function initialize() {
  const [state, tab] = await Promise.all([getState(), getCurrentTab()]);

  syncInputs(clampConfig(state.config || DEFAULT_CONFIG));
  renderState(state);
  renderPageStatus(tab);

  elements.startButton.addEventListener("click", handleStart);
  elements.stopButton.addEventListener("click", handleStop);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.cleanerState?.newValue) {
      return;
    }

    renderState(changes.cleanerState.newValue);
  });
}

initialize().catch((error) => {
  elements.pageStatus.textContent = error.message;
});
