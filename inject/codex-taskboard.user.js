(() => {
  "use strict";

  const VERSION = "0.6.8";
  const SOURCE_HASH = window.__CODEX_TASKBOARD_SOURCE_HASH__;
  const SENTINEL_KEY = "__codexTaskboardInjection__";
  const DEFAULT_TASKBOARD_URL = "http://127.0.0.1:47823/?host=codex";
  const ENTRY_ID = "codex-taskboard-entry";
  const PAGE_ID = "codex-taskboard-page";
  const FRAME_ID = "codex-taskboard-frame";
  const DRAG_REGION_ID = "codex-taskboard-drag-region";
  const NO_DRAG_LEFT_ID = "codex-taskboard-no-drag-left";
  const NO_DRAG_RIGHT_ID = "codex-taskboard-no-drag-right";
  const STATUS_ID = "codex-taskboard-status";
  const STYLE_ID = "codex-taskboard-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-taskboard-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-taskboard-native-hidden";
  const HOST_ATTRIBUTE = "data-codex-taskboard-page-host";
  const NATIVE_SELECTED_ATTRIBUTE = "data-codex-taskboard-native-selected";
  const HOST_BINDING_NAME = "__codexTaskboardHostV1";
  const HOST_HEARTBEAT_NAME = "__codexTaskboardHostHeartbeatV1";
  const REATTACH_DELAY_MS = 160;
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const HOST_REQUEST_TIMEOUT_MS = 12_000;
  const HOST_HEARTBEAT_MAX_AGE_MS = 8_000;
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const FRAME_REFRESH_PARAM = "__codex_taskboard_refresh";
  const THREAD_LINK_RECEIPT_STORAGE_KEY = "codex-taskboard.pendingThreadLinkReceipt.v1";
  const THREAD_LINK_REQUEST_STORAGE_KEY = "codex-taskboard.pendingThreadLinkRequest.v2";
  const THREAD_LINK_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
  const THREAD_LINK_BLOCKING_TIMEOUT_MS = 5 * 60 * 1_000;
  const THREAD_LINK_RECEIPT_RETRY_MS = 1_000;
  const THREAD_LINK_RESOLVE_RETRY_MS = 500;
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_PAGE_LABELS = [
    "新建任务",
    "new task",
    "new chat",
    "拉取请求",
    "pull requests",
    "站点",
    "sites",
    "已安排",
    "scheduled",
    "插件",
    "plugins",
  ];
  const PROJECT_SECTION_LABELS = ["projects", "项目"];
  const TASK_SECTION_LABELS = ["tasks", "任务", "chats", "对话"];
  const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let page = null;
  let frame = null;
  let dragRegion = null;
  let noDragLeft = null;
  let noDragRight = null;
  let status = null;
  let frameOrigin = "";
  let frameReady = false;
  let frameReadyWaiters = new Set();
  let hostRequests = new Map();
  let hostRequestSequence = 0;
  let observer = null;
  let reattachTimer = null;
  let lastFocusedElement = null;
  let hostContextSnapshot = null;
  let mutedNativeSelections = new Map();
  let openGeneration = 0;
  let pendingThreadCreation = null;
  let pendingTaskThreadLink = null;
  let pendingThreadResolutionInFlight = false;
  let pendingThreadCheckTimer = null;
  let pendingThreadLinkReceipt = null;
  let pendingThreadLinkReceiptTimer = null;
  let lastNativeThreadId = "";
  let active = false;
  let destroyed = false;

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeThreadId(value) {
    let normalized = String(value || "").trim();
    if (!normalized) return "";
    try {
      normalized = decodeURIComponent(normalized);
    } catch (_) {
      return "";
    }
    normalized = normalized
      .replace(/^local:/i, "")
      .replace(/^urn:uuid:/i, "")
      .toLowerCase();
    return CODEX_THREAD_ID_PATTERN.test(normalized) ? normalized : "";
  }

  function readPendingThreadLinkReceipt() {
    try {
      const receipt = JSON.parse(window.localStorage.getItem(THREAD_LINK_RECEIPT_STORAGE_KEY) || "null");
      if (
        !receipt
        || typeof receipt !== "object"
        || typeof receipt.requestId !== "string"
        || typeof receipt.taskId !== "string"
        || (receipt.commentId !== undefined && typeof receipt.commentId !== "string")
        || (receipt.action !== undefined && receipt.action !== "create" && receipt.action !== "follow-up")
        || !normalizeThreadId(receipt.threadId)
        || typeof receipt.createdAt !== "number"
        || receipt.createdAt < Date.now() - THREAD_LINK_RECEIPT_TTL_MS
      ) {
        window.localStorage.removeItem(THREAD_LINK_RECEIPT_STORAGE_KEY);
        return null;
      }
      return { ...receipt, threadId: normalizeThreadId(receipt.threadId) };
    } catch (_) {
      window.localStorage.removeItem(THREAD_LINK_RECEIPT_STORAGE_KEY);
      return null;
    }
  }

  function persistPendingThreadLinkReceipt(receipt) {
    pendingThreadLinkReceipt = receipt;
    if (receipt) {
      window.localStorage.setItem(THREAD_LINK_RECEIPT_STORAGE_KEY, JSON.stringify(receipt));
    } else {
      window.localStorage.removeItem(THREAD_LINK_RECEIPT_STORAGE_KEY);
    }
  }

  function readPendingTaskThreadLink() {
    try {
      const request = JSON.parse(window.localStorage.getItem(THREAD_LINK_REQUEST_STORAGE_KEY) || "null");
      if (
        !request
        || typeof request !== "object"
        || typeof request.requestId !== "string"
        || typeof request.taskId !== "string"
        || (request.commentId !== undefined && typeof request.commentId !== "string")
        || (request.action !== undefined && request.action !== "create" && request.action !== "follow-up")
        || (request.threadId !== undefined && !normalizeThreadId(request.threadId))
        || typeof request.marker !== "string"
        || request.marker.length < 8
        || request.marker.length > 200
        || typeof request.startedAt !== "number"
        || request.startedAt < Date.now() - THREAD_LINK_RECEIPT_TTL_MS
      ) {
        window.localStorage.removeItem(THREAD_LINK_REQUEST_STORAGE_KEY);
        return null;
      }
      return {
        ...request,
        action: request.action === "follow-up" ? "follow-up" : "create",
        ...(request.threadId ? { threadId: normalizeThreadId(request.threadId) } : {}),
      };
    } catch (_) {
      window.localStorage.removeItem(THREAD_LINK_REQUEST_STORAGE_KEY);
      return null;
    }
  }

  function persistPendingTaskThreadLink(request) {
    pendingTaskThreadLink = request;
    if (request) {
      window.localStorage.setItem(THREAD_LINK_REQUEST_STORAGE_KEY, JSON.stringify(request));
    } else {
      window.localStorage.removeItem(THREAD_LINK_REQUEST_STORAGE_KEY);
    }
  }

  function releaseExpiredThreadTransaction() {
    const now = Date.now();
    if (
      pendingTaskThreadLink
      && pendingTaskThreadLink.startedAt < now - THREAD_LINK_BLOCKING_TIMEOUT_MS
    ) {
      persistPendingTaskThreadLink(null);
      if (pendingThreadCheckTimer !== null) window.clearTimeout(pendingThreadCheckTimer);
      pendingThreadCheckTimer = null;
    }
    if (
      pendingThreadLinkReceipt
      && pendingThreadLinkReceipt.createdAt < now - THREAD_LINK_BLOCKING_TIMEOUT_MS
    ) {
      persistPendingThreadLinkReceipt(null);
      if (pendingThreadLinkReceiptTimer !== null) window.clearTimeout(pendingThreadLinkReceiptTimer);
      pendingThreadLinkReceiptTimer = null;
    }
  }

  function schedulePendingThreadLinkReceipt() {
    if (!pendingThreadLinkReceipt || pendingThreadLinkReceiptTimer !== null) return;
    pendingThreadLinkReceiptTimer = window.setTimeout(() => {
      pendingThreadLinkReceiptTimer = null;
      deliverPendingThreadLinkReceipt();
    }, THREAD_LINK_RECEIPT_RETRY_MS);
  }

  function deliverPendingThreadLinkReceipt() {
    if (!pendingThreadLinkReceipt) pendingThreadLinkReceipt = readPendingThreadLinkReceipt();
    if (!pendingThreadLinkReceipt) return;
    postToFrame({
      type: pendingThreadLinkReceipt.action === "follow-up"
        ? "taskboard:thread-followed-up"
        : "taskboard:thread-created",
      payload: pendingThreadLinkReceipt,
    });
    schedulePendingThreadLinkReceipt();
  }

  function nativeCodexTaskInProgress() {
    return Array.from(document.querySelectorAll("button")).some((button) => {
      const label = (
        button.getAttribute("aria-label")
        || button.textContent
        || ""
      ).trim().toLowerCase();
      return !button.disabled && (label === "停止" || label === "stop");
    });
  }

  function assertNativeComposerCanStartTask() {
    if (nativeCodexTaskInProgress()) {
      throw new Error("Codex 当前仍在运行任务，请等待完成或点击停止后再新建会话。");
    }
  }

  pendingThreadLinkReceipt = readPendingThreadLinkReceipt();
  pendingTaskThreadLink = readPendingTaskThreadLink();
  releaseExpiredThreadTransaction();

  function resolveTaskboardUrl() {
    const configured = typeof window.__CODEX_TASKBOARD_URL__ === "string"
      ? window.__CODEX_TASKBOARD_URL__.trim()
      : "";
    try {
      const url = new URL(configured || DEFAULT_TASKBOARD_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported taskboard URL protocol");
      }
      if (!url.searchParams.has("host")) url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL);
    }
  }

  function isLocalTaskboardOrigin(origin) {
    try {
      const { protocol, hostname } = new URL(origin);
      return (protocol === "http:" || protocol === "https:")
        && (hostname === "127.0.0.1" || hostname === "localhost");
    } catch (_) {
      return false;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        z-index: 31 !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] {
        background-color: transparent !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] [class*="text-token-list-active-selection"] {
        color: var(--color-token-foreground, inherit) !important;
      }
      #${PAGE_ID} {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${FRAME_ID}[hidden] {
        display: none !important;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${NO_DRAG_LEFT_ID},
      #${NO_DRAG_RIGHT_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: no-drag;
      }
      #${DRAG_REGION_ID}[hidden],
      #${NO_DRAG_LEFT_ID}[hidden],
      #${NO_DRAG_RIGHT_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} button {
        margin-top: 10px;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 7px;
        padding: 5px 10px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const text = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(text);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin && plugin.parentElement) {
      const siblings = Array.from(plugin.parentElement.children).filter((child) => child.tagName === "BUTTON");
      if (siblings.length >= 3) return plugin;
    }

    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  function replaceEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `
      <rect x="3.5" y="4" width="17" height="16" rx="2.5"></rect>
      <path d="M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5"></path>
    `;
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute("aria-label", "打开任务面板");
    button.setAttribute("title", "任务面板");
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    const label = button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    if (label) label.textContent = "任务面板";
    else button.textContent = "任务面板";
    replaceEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTaskboard();
    });
    return button;
  }

  function syncEntryState() {
    if (!entry) return;
    if (active && entry.getAttribute("aria-current") !== "page") {
      entry.setAttribute("aria-current", "page");
    } else if (!active && entry.hasAttribute("aria-current")) {
      entry.removeAttribute("aria-current");
    }
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    syncEntryState();
  }

  function findPageHost() {
    const direct = document.querySelector(".app-shell-main-content-frame");
    if (direct?.closest?.("[data-app-shell-main-content-layout]")) return direct;

    const viewport = document.querySelector("[data-app-shell-main-content-layout]");
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const headerBottom = document.querySelector("main > header")?.getBoundingClientRect().bottom
      ?? viewportRect.top;
    return Array.from(viewport.children).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8
        && rect.height >= viewportRect.height * 0.7
        && rect.top >= headerBottom - 1;
    }) || null;
  }

  function findPageMount() {
    const frameHost = findPageHost();
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]");
    const surface = viewport?.parentElement;
    if (!frameHost || !viewport || !surface || !surface.closest("main")) return null;
    return { frameHost, surface };
  }

  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]')
      .forEach((node) => {
        if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
        if (!mutedNativeSelections.has(node)) {
          mutedNativeSelections.set(node, node.getAttribute("aria-current"));
        }
        node.removeAttribute("aria-current");
        node.setAttribute(NATIVE_SELECTED_ATTRIBUTE, "true");
      });
  }

  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      node.setAttribute("aria-current", ariaCurrent);
      node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE));
  }

  function hideNativeHeader() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')
      .forEach((surface) => {
        Array.from(surface.children).forEach((child) => {
          if (child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
            child.setAttribute(HIDDEN_ATTRIBUTE, "true");
          }
        });
      });
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return window.getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function threadIdFromLocation() {
    const source = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function activeThreadRow() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    return rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || null;
  }

  function readCodexProjects() {
    const seen = new Set();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .flatMap((row) => {
        const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
        const name = (
          row.getAttribute("data-app-action-sidebar-project-label")
          || row.getAttribute("aria-label")
          || ""
        ).trim();
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name }];
      });
  }

  function readCodexThreads() {
    const seen = new Set();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .flatMap((row) => {
        const id = normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id"));
        const title = (
          row.getAttribute("data-app-action-sidebar-thread-title")
          || row.getAttribute("aria-label")
          || row.textContent
          || ""
        ).replace(/\s+/g, " ").trim();
        const projectId = row.closest("[data-app-action-sidebar-project-list-id]")
          ?.getAttribute("data-app-action-sidebar-project-list-id")
          ?.trim();
        if (!id || !title || !projectId || seen.has(id)) return [];
        seen.add(id);
        return [{ id, title, projectId }];
      });
  }

  function findProjectsSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section-heading]"))
      .find((node) => PROJECT_SECTION_LABELS.includes(normalizedLabel(
        node.getAttribute("data-app-action-sidebar-section-heading") || node.textContent,
      )))
      ?.closest("[data-app-action-sidebar-section]") || null;
  }

  function findTasksSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section]"))
      .find((section) => {
        const heading = section.querySelector("[data-app-action-sidebar-section-heading]");
        const label = heading?.getAttribute("data-app-action-sidebar-section-heading")
          || heading?.textContent
          || section.textContent;
        return TASK_SECTION_LABELS.includes(normalizedLabel(label));
      }) || null;
  }

  async function captureHostContext() {
    let projects = readCodexProjects();
    let section = findProjectsSection();
    const sectionDeadline = Date.now() + 1_200;
    while (!section && Date.now() < sectionDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    const tasksSection = findTasksSection();
    const expandedSections = [section, tasksSection].filter((candidate) => (
      candidate?.getAttribute("data-app-action-sidebar-section-collapsed") === "true"
    ));
    expandedSections.forEach((candidate) => (
      candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click()
    ));
    if (expandedSections.length > 0) {
      const deadline = Date.now() + 1_200;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        projects = readCodexProjects();
      } while ((projects.length === 0 || !activeThreadRow()) && Date.now() < deadline);
    }
    const context = readHostContext(projects);
    expandedSections.forEach((candidate) => {
      if (candidate.isConnected && candidate.getAttribute("data-app-action-sidebar-section-collapsed") === "false") {
        candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
      }
    });
    return context;
  }

  function workspaceFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("workspace") || url.searchParams.get("cwd") || "";
    } catch (_) {
      return "";
    }
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const surfaceLeft = findPageMount()?.surface.getBoundingClientRect().left;
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(
      document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'),
    );
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (!trigger || !nativeSidebarCollapsed()) return;
    trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function userIdFromName(name) {
    const slug = name.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96);
    if (slug) return slug;
    let hash = 2166136261;
    for (const character of name) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `codex-user-${(hash >>> 0).toString(36)}`;
  }

  function readCodexUser() {
    const avatar = Array.from(document.querySelectorAll("img"))
      .find((image) => image.src.includes("cdn.auth0.com/avatars/"));
    const profileButton = avatar?.closest("button")
      || Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => (
        normalizedLabel(button.getAttribute("aria-label")).includes("profile")
        || normalizedLabel(button.getAttribute("aria-label")).includes("个人资料")
      ));
    const name = profileButton?.textContent?.replace(/\s+/g, " ").trim();
    if (!name) return null;
    const avatarUrl = avatar?.currentSrc || avatar?.src || null;
    return {
      type: "user",
      id: userIdFromName(name),
      name,
      avatarUrl,
    };
  }

  function readHostContext(projects = readCodexProjects()) {
    const row = activeThreadRow();
    const activeThreadId = normalizeThreadId(row?.getAttribute("data-app-action-sidebar-thread-id"));
    if (activeThreadId) lastNativeThreadId = activeThreadId;
    const threadId = activeThreadId || lastNativeThreadId || normalizeThreadId(threadIdFromLocation());
    const projectList = row?.closest?.("[data-app-action-sidebar-project-list-id]");
    const projectRow = row?.closest?.("[data-app-action-sidebar-project-id]")
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute("data-app-action-sidebar-project-list-id")
      || projectRow?.getAttribute("data-app-action-sidebar-project-id")
      || "";
    const workspacePath = workspaceFromLocation();
    const payload = {
      theme: currentTheme(),
      projects,
      threads: readCodexThreads(),
      user: readCodexUser() ?? undefined,
      titlebarLeftInset: titlebarLeftInset(),
      sidebarCollapsed: nativeSidebarCollapsed(),
    };
    if (workspacePath) payload.workspacePath = workspacePath;
    if (projectId) payload.projectId = projectId;
    if (threadId) payload.threadId = threadId;
    return payload;
  }

  function postToFrame(message) {
    if (!frame?.contentWindow || !frameOrigin) return;
    frame.contentWindow.postMessage(message, frameOrigin);
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function postHostContext() {
    if (!frame) return;
    const liveContext = readHostContext();
    const payload = hostContextSnapshot
      ? {
          ...hostContextSnapshot,
          ...liveContext,
          projects: liveContext.projects.length > 0
            ? liveContext.projects
            : hostContextSnapshot.projects,
          threads: liveContext.threads.length > 0
            ? liveContext.threads
            : hostContextSnapshot.threads,
        }
      : liveContext;
    postToFrame({ type: "taskboard:host-context", payload });
    postToFrame({ type: "taskboard:theme", theme: payload.theme });
    void resolvePendingTaskThreadLink();
  }

  function schedulePendingTaskThreadResolution(requestId) {
    if (pendingThreadCheckTimer !== null) return;
    pendingThreadCheckTimer = window.setTimeout(() => {
      pendingThreadCheckTimer = null;
      if (pendingTaskThreadLink?.requestId === requestId) void resolvePendingTaskThreadLink();
    }, THREAD_LINK_RESOLVE_RETRY_MS);
  }

  async function resolvePendingTaskThreadLink() {
    if (!pendingTaskThreadLink || pendingThreadResolutionInFlight) return;
    const request = pendingTaskThreadLink;
    pendingThreadResolutionInFlight = true;
    try {
      const result = await requestHost("resolve-task-thread", {
        marker: request.marker,
        startedAt: request.startedAt,
      });
      if (pendingTaskThreadLink?.requestId !== request.requestId) return;
      const threadId = normalizeThreadId(result?.threadId);
      if (result?.status === "resolved" && threadId) {
        if (request.action === "follow-up" && threadId !== normalizeThreadId(request.threadId)) {
          throw new Error("Codex 跟进消息写入了非预期会话");
        }
        persistPendingThreadLinkReceipt({
          requestId: request.requestId,
          taskId: request.taskId,
          commentId: request.commentId || undefined,
          action: request.action === "follow-up" ? "follow-up" : "create",
          threadId,
          createdAt: Date.now(),
        });
        persistPendingTaskThreadLink(null);
        if (pendingThreadCheckTimer !== null) window.clearTimeout(pendingThreadCheckTimer);
        pendingThreadCheckTimer = null;
        deliverPendingThreadLinkReceipt();
        return;
      }
    } catch (_) {
      // The resident injector can restart independently. Keep the durable request and retry.
    } finally {
      pendingThreadResolutionInFlight = false;
    }
    if (pendingTaskThreadLink?.requestId === request.requestId) {
      schedulePendingTaskThreadResolution(request.requestId);
    }
  }

  function findThreadRow(threadId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)) || null;
  }

  function routeForThread(threadId) {
    return `/local/${encodeURIComponent(threadId)}`;
  }

  function appUrlForThread(threadId) {
    return `codex://threads/${encodeURIComponent(threadId)}`;
  }

  function waitForNativePaint() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });
  }

  async function waitForActiveThread(threadId, timeoutMs = 1_200) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = findThreadRow(normalizedThreadId);
      const activeThreadId = normalizeThreadId(
        activeThreadRow()?.getAttribute("data-app-action-sidebar-thread-id"),
      ) || normalizeThreadId(threadIdFromLocation());
      if (
        activeThreadId === normalizedThreadId
        || row?.getAttribute("data-app-action-sidebar-thread-active") === "true"
        || ["page", "true"].includes(row?.getAttribute("aria-current"))
      ) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
    return false;
  }

  async function ensureThreadRowsVisible() {
    expandNativeSidebar();
    let section = findTasksSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findTasksSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexThreads().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  async function openThread(threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) return;
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) return;
    lastNativeThreadId = normalizedThreadId;
    closeTaskboard(false);
    await waitForNativePaint();
    await ensureThreadRowsVisible();

    const row = findThreadRow(normalizedThreadId);
    if (row?.isConnected) {
      row.scrollIntoView?.({ block: "nearest" });
      row.click?.();
      if (await waitForActiveThread(normalizedThreadId)) return;
    }

    try {
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: routeForThread(normalizedThreadId),
      });
    } catch (_) {}
    if (await waitForActiveThread(normalizedThreadId, 2_000)) return;

    window.location.assign(appUrlForThread(normalizedThreadId));
    await waitForActiveThread(normalizedThreadId, 3_000);
  }

  function projectRowById(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => row.getAttribute("data-app-action-sidebar-project-id") === projectId.trim()) || null;
  }

  function projectRowByLabel(label) {
    if (typeof label !== "string" || !label.trim()) return null;
    const expected = normalizedLabel(label);
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => normalizedLabel(row.getAttribute("data-app-action-sidebar-project-label")) === expected) || null;
  }

  async function ensureProjectRows() {
    let section = findProjectsSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexProjects().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  function workspaceLabelFromPath(workspacePath) {
    return String(workspacePath || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
  }

  function activeProjectRow() {
    return document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]')
      || document.querySelector(`[data-app-action-sidebar-project-row][${NATIVE_SELECTED_ATTRIBUTE}="true"]`)
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]');
  }

  function projectFromRow(row) {
    if (!row) return null;
    const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
    const name = (
      row.getAttribute("data-app-action-sidebar-project-label")
      || row.getAttribute("aria-label")
      || ""
    ).trim();
    return id && name ? { id, name } : null;
  }

  function activeNativeProjectId() {
    const selectedProjectId = projectFromRow(activeProjectRow())?.id;
    const threadProjectId = activeThreadRow()
      ?.closest?.("[data-app-action-sidebar-project-list-id]")
      ?.getAttribute?.("data-app-action-sidebar-project-list-id")
      ?.trim();
    return selectedProjectId || threadProjectId || "";
  }

  function requestedProjectRow(payload) {
    const requestedProjectId = typeof payload?.codexProjectId === "string"
      ? payload.codexProjectId.trim()
      : "";
    return projectRowByLabel(payload?.workspaceLabel)
      || projectRowById(requestedProjectId)
      || projectRowByLabel(payload?.projectName)
      || null;
  }

  async function waitForActiveNativeProject(projectId, timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (activeNativeProjectId() === projectId) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    }
    return false;
  }

  async function selectComposerProject(project) {
    const composerDeadline = Date.now() + 8_000;
    let picker = null;
    while (!picker && Date.now() < composerDeadline) {
      picker = Array.from(document.querySelectorAll("button")).find((button) => (
        button.getClientRects().length > 0
        && button.getAttribute("data-composer-navigation-target") === "workspace-project"
      )) || null;
      if (!picker) await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (!picker) throw new Error("Codex 新会话没有项目选择器");

    const currentLabel = normalizedLabel(picker.textContent || picker.getAttribute("aria-label"));
    if (currentLabel.includes(normalizedLabel(project.name))) return;
    picker.click();

    const optionDeadline = Date.now() + 8_000;
    let option = null;
    while (!option && Date.now() < optionDeadline) {
      option = Array.from(document.querySelectorAll('[role="option"]')).find((candidate) => (
        candidate.getClientRects().length > 0
        && (
          candidate.getAttribute("data-value") === project.id
          || normalizedLabel(candidate.textContent) === normalizedLabel(project.name)
        )
      )) || null;
      if (!option) await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (!option) throw new Error(`Codex 项目选择器中没有“${project.name}”`);
    option.click();

    const selectionDeadline = Date.now() + 5_000;
    while (Date.now() < selectionDeadline) {
      const selected = Array.from(document.querySelectorAll("button")).find((button) => (
        button.getClientRects().length > 0
        && button.getAttribute("data-composer-navigation-target") === "workspace-project"
      ));
      const label = normalizedLabel(selected?.textContent || selected?.getAttribute("aria-label"));
      if (label.includes(normalizedLabel(project.name))) return;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error(`Codex 没有确认新会话的项目“${project.name}”`);
  }

  async function activateProjectForThread(payload, workspacePath, bridge) {
    await ensureProjectRows();
    if (workspacePath) {
      await bridge.sendMessageFromView({
        type: "electron-set-active-workspace-root",
        root: workspacePath,
      });
    }

    const rowDeadline = Date.now() + 4_000;
    let row = requestedProjectRow(payload);
    while (!row && Date.now() < rowDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      row = requestedProjectRow(payload);
    }
    const project = projectFromRow(row);
    if (!row || !project) {
      const requestedProjectId = typeof payload?.codexProjectId === "string"
        ? payload.codexProjectId.trim()
        : "";
      const projectName = typeof payload?.projectName === "string"
        ? payload.projectName.trim()
        : "";
      if (!requestedProjectId || !projectName) {
        throw new Error("Codex 未找到任务所属项目，已停止创建会话");
      }
      return { id: requestedProjectId, name: projectName, selectInComposer: true };
    }

    if (row.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
      row.click?.();
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    const selectProject = row.querySelector("[data-app-action-sidebar-select-project]");
    if (!selectProject) throw new Error("Codex 无法选择任务所属项目，已停止创建会话");
    selectProject.click?.();

    if (await waitForActiveNativeProject(project.id)) return { ...project, selectInComposer: false };
    throw new Error(`Codex 未切换到项目“${project.name}”，已停止创建会话`);
  }

  async function activateProjectFromTaskboard(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
    const projectName = typeof payload?.projectName === "string" ? payload.projectName.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string" ? payload.workspacePath.trim() : "";
    if (!requestId) return;
    if (!isLocalTaskboardOrigin(frameOrigin)) {
      postToFrame({
        type: "taskboard:project-activated",
        payload: { requestId, ok: false, error: "仅本地任务面板可新增 Codex 项目" },
      });
      return;
    }
    try {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error("当前 Codex 版本没有提供本地项目注册能力");
      }
      await ensureProjectRows();
      const beforeIds = new Set(readCodexProjects().map((project) => project.id));
      const beforeActiveProjectId = projectFromRow(activeProjectRow())?.id || "";
      await bridge.sendMessageFromView({
        type: "electron-set-active-workspace-root",
        root: workspacePath,
      });

      const workspaceLabel = workspaceLabelFromPath(workspacePath);
      const deadline = Date.now() + 4_000;
      let project = null;
      while (!project && Date.now() < deadline) {
        const projects = readCodexProjects();
        const activeProject = projectFromRow(activeProjectRow());
        project = projects.find((candidate) => !beforeIds.has(candidate.id))
          || projects.find((candidate) => normalizedLabel(candidate.name) === normalizedLabel(workspaceLabel))
          || projects.find((candidate) => normalizedLabel(candidate.name) === normalizedLabel(projectName))
          || (activeProject?.id !== beforeActiveProjectId ? activeProject : null);
        if (!project) await new Promise((resolve) => window.setTimeout(resolve, 60));
      }
      if (!project) throw new Error("Codex 未能从该目录创建或识别项目，请确认目录存在");

      hostContextSnapshot = await captureHostContext();
      postHostContext();
      postToFrame({
        type: "taskboard:project-activated",
        payload: { requestId, ok: true, project },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:project-activated",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "无法新增 Codex 项目",
        },
      });
    }
  }

  async function createThreadForTask(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const commentId = typeof payload?.commentId === "string" ? payload.commentId.trim() : "";
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const skillName = typeof payload?.skillName === "string" ? payload.skillName.trim() : "";
    const skillDisplayName = typeof payload?.skillDisplayName === "string"
      ? payload.skillDisplayName.trim()
      : "";
    const skillPath = typeof payload?.skillPath === "string" ? payload.skillPath.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    if (
      !requestId
      || !taskId
      || !identifier
      || !instruction
      || !skillName
      || !skillDisplayName
      || !skillPath
    ) return;
    releaseExpiredThreadTransaction();
    if (pendingThreadCreation || pendingTaskThreadLink || pendingThreadLinkReceipt) {
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: {
          requestId,
          taskId,
          commentId: commentId || undefined,
          error: "上一条新会话仍在确认中，请完成后再试。",
        },
      });
      return;
    }
    pendingThreadCreation = requestId;
    const startedAt = Date.now();
    const marker = `[taskboard-request:${requestId}]`;
    const correlatedInstruction = `${instruction}\n\n${marker}`;
    const usesRepositoryKnowledgeSkill = skillName === "project-knowledge-builder";
    const manageTaskboardSkillPath = usesRepositoryKnowledgeSkill
      ? skillPath.replace(
        /skills\/project-knowledge-builder\/SKILL\.md$/,
        "skills/manage-taskboard/SKILL.md",
      )
      : "";
    const composerInstruction = usesRepositoryKnowledgeSkill
      ? [
        "这是普通任务提示词，不要打开或使用 Codex 的 Skill 选择菜单。",
        `先完整读取同一 Git 仓库自带的 Taskboard 操作规范：${manageTaskboardSkillPath}`,
        `再完整读取同一 Git 仓库自带的项目知识库构建规范：${skillPath}`,
        "前者负责 Issue、评论和状态操作，后者负责知识质量、项目分析和待确认提案。不要改用用户本机安装的其他 Skill。",
        "保持目标项目目录只读，只允许把分析结果回传为 Taskboard 待确认提案。",
        correlatedInstruction,
      ].join("\n\n")
      : correlatedInstruction;
    persistPendingTaskThreadLink({
      requestId,
      taskId,
      ...(commentId ? { commentId } : {}),
      action: "create",
      marker,
      startedAt,
    });
    try {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error("当前 Codex 版本没有提供原生对话导航能力");
      }
      const activatedProject = await activateProjectForThread(payload, workspacePath, bridge);
      assertNativeComposerCanStartTask();

      closeTaskboard(false);
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: "/",
        state: {
          focusComposerNonce: Date.now(),
        },
      });
      if (activatedProject.selectInComposer) {
        await selectComposerProject(activatedProject);
      } else if (!await waitForActiveNativeProject(activatedProject.id)) {
        throw new Error(`Codex 离开了项目“${activatedProject.name}”，已停止创建会话`);
      }
      if (usesRepositoryKnowledgeSkill) {
        await requestHost("prefill-plain-composer", {
          instruction: composerInstruction,
          submit: true,
        });
      } else {
        await requestHostTaskComposerPrefill({
          instruction: composerInstruction,
          skillDisplayName,
          skillName,
          skillPath,
          submit: true,
        });
      }
      void resolvePendingTaskThreadLink();
      postToFrame({ type: "taskboard:thread-prepared", payload: { requestId, taskId } });
    } catch (error) {
      if (pendingTaskThreadLink?.requestId === requestId) persistPendingTaskThreadLink(null);
      if (pendingThreadCheckTimer !== null) window.clearTimeout(pendingThreadCheckTimer);
      pendingThreadCheckTimer = null;
      if (page?.hidden !== false) openTaskboard();
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: {
          requestId,
          taskId,
          commentId: commentId || undefined,
          error: error instanceof Error ? error.message : "无法创建 Codex 对话",
        },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  async function createKnowledgeThread(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    if (!requestId || !instruction || !workspacePath) return;
    if (pendingThreadCreation) {
      postToFrame({
        type: "taskboard:knowledge-thread-error",
        payload: { requestId, error: "上一条 Codex 会话仍在创建中，请稍后重试。" },
      });
      return;
    }
    pendingThreadCreation = requestId;
    let stage = "切换项目目录";
    const setStage = (nextStage) => {
      stage = nextStage;
      window.__codexTaskboardKnowledgeStage = { requestId, stage, updatedAt: Date.now() };
    };
    setStage(stage);
    try {
      setStage("打开新会话");
      closeTaskboard(false);
      const newTaskButton = Array.from(document.querySelectorAll("button")).find((button) => (
        button.getClientRects().length > 0
        && ["新对话", "new task", "new chat"].includes(normalizedLabel(button.textContent))
      ));
      if (!newTaskButton) throw new Error("Codex 没有找到“新对话”入口");
      newTaskButton.click();
      const composerDeadline = Date.now() + 8_000;
      let composerReady = false;
      while (!composerReady && Date.now() < composerDeadline) {
        composerReady = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]',
        )).some((editor) => editor.getClientRects().length > 0);
        if (!composerReady) await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      if (!composerReady) throw new Error("Codex 新会话输入框没有就绪");
      setStage("选择星枢项目");
      const projectPicker = Array.from(document.querySelectorAll("button")).find((button) => (
        button.getClientRects().length > 0
        && button.getAttribute("data-composer-navigation-target") === "workspace-project"
      ));
      if (!projectPicker) throw new Error("Codex 新会话没有项目选择器");
      projectPicker.click();
      const requestedProjectId = typeof payload?.codexProjectId === "string"
        ? payload.codexProjectId.trim()
        : "";
      const expectedLabels = [payload?.projectName, payload?.workspaceLabel]
        .filter((label) => typeof label === "string" && label.trim())
        .map(normalizedLabel);
      const optionDeadline = Date.now() + 8_000;
      let projectOption = null;
      while (!projectOption && Date.now() < optionDeadline) {
        projectOption = Array.from(document.querySelectorAll('[role="option"]')).find((option) => (
          option.getClientRects().length > 0
          && (
            (requestedProjectId && option.getAttribute("data-value") === requestedProjectId)
            || expectedLabels.includes(normalizedLabel(option.textContent))
          )
        )) || null;
        if (!projectOption) await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      if (!projectOption) {
        throw new Error(`Codex 项目选择器中没有“${payload?.workspaceLabel || payload?.projectName}”`);
      }
      projectOption.click();
      const selectionDeadline = Date.now() + 4_000;
      let projectSelected = false;
      while (!projectSelected && Date.now() < selectionDeadline) {
        const currentPicker = Array.from(document.querySelectorAll("button")).find((button) => (
          button.getClientRects().length > 0
          && button.getAttribute("data-composer-navigation-target") === "workspace-project"
        ));
        const label = normalizedLabel(
          currentPicker?.textContent || currentPicker?.getAttribute("aria-label"),
        );
        projectSelected = expectedLabels.some((expected) => label.includes(expected));
        if (!projectSelected) await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      if (!projectSelected) throw new Error("Codex 没有确认新会话的项目选择");
      setStage("发送分析指令");
      await requestHost("prefill-plain-composer", { instruction, submit: true });
      postToFrame({
        type: "taskboard:knowledge-thread-prepared",
        payload: {
          requestId,
          projectId: requestedProjectId,
          projectName: payload?.projectName || payload?.workspaceLabel,
        },
      });
      setStage("已创建");
    } catch (error) {
      setStage(`${stage}失败`);
      postToFrame({
        type: "taskboard:knowledge-thread-error",
        payload: {
          requestId,
          error: `${stage}失败：${error instanceof Error ? error.message : "无法创建项目知识分析会话"}`,
        },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  async function followUpThreadForTask(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const threadId = normalizeThreadId(payload?.threadId);
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const skillName = typeof payload?.skillName === "string" ? payload.skillName.trim() : "";
    const skillDisplayName = typeof payload?.skillDisplayName === "string"
      ? payload.skillDisplayName.trim()
      : "";
    const skillPath = typeof payload?.skillPath === "string" ? payload.skillPath.trim() : "";
    if (
      !requestId
      || !taskId
      || !threadId
      || !identifier
      || !instruction
      || !skillName
      || !skillDisplayName
      || !skillPath
    ) return;
    releaseExpiredThreadTransaction();
    if (pendingThreadCreation || pendingTaskThreadLink || pendingThreadLinkReceipt) {
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: {
          requestId,
          taskId,
          error: "上一条会话请求仍在确认中，请完成后再试。",
        },
      });
      return;
    }
    pendingThreadCreation = requestId;
    const startedAt = Date.now();
    const marker = `[taskboard-request:${requestId}]`;
    const correlatedInstruction = `${instruction}\n\n${marker}`;
    persistPendingTaskThreadLink({
      requestId,
      taskId,
      action: "follow-up",
      threadId,
      marker,
      startedAt,
    });
    try {
      await openThread(threadId);
      if (!await waitForActiveThread(threadId, 8_000)) {
        throw new Error("Codex 没有打开所选会话");
      }
      await requestHostTaskComposerPrefill({
        instruction: correlatedInstruction,
        skillDisplayName,
        skillName,
        skillPath,
        submit: true,
      });
      postToFrame({ type: "taskboard:thread-prepared", payload: { requestId, taskId } });
      persistPendingThreadLinkReceipt({
        requestId,
        taskId,
        action: "follow-up",
        threadId,
        createdAt: Date.now(),
      });
      persistPendingTaskThreadLink(null);
      deliverPendingThreadLinkReceipt();
    } catch (error) {
      if (pendingTaskThreadLink?.requestId === requestId) persistPendingTaskThreadLink(null);
      if (pendingThreadCheckTimer !== null) window.clearTimeout(pendingThreadCheckTimer);
      pendingThreadCheckTimer = null;
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: {
          requestId,
          taskId,
          error: error instanceof Error ? error.message : "无法继续 Codex 会话",
        },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  function buildAutomationHostPayload(payload) {
    return {
      requestId: payload.requestId,
      operation: payload.operation,
      taskboardProjectId: payload.taskboardProjectId,
      codexProjectId: payload.codexProjectId,
      projectName: payload.projectName,
      workspacePath: payload.workspacePath,
      skillPath: payload.skillPath,
      ...(payload.automationId === undefined ? {} : { automationId: payload.automationId }),
      enabledByUser: payload.enabledByUser,
      quotaAware: payload.quotaAware,
      intervalMinutes: payload.intervalMinutes,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
    };
  }

  async function handleAutomationRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    if (!isLocalTaskboardOrigin(frameOrigin)) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: { requestId, ok: false, error: "仅本地任务面板可用" },
      });
      return;
    }
    try {
      const response = await requestHost(
        "automation",
        buildAutomationHostPayload(payload),
      );
      postToFrame({
        type: "taskboard:automation-response",
        payload: response.error
          ? { requestId, ok: false, error: response.error }
          : {
              requestId,
              ok: true,
              item: response.item,
              items: response.items,
              quota: response.quota,
              policy: response.policy,
            },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "Codex 自动任务操作失败",
        },
      });
    }
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "taskboard:ready") {
      frameReady = true;
      frameReadyWaiters.forEach(({ resolve, timer }) => {
        window.clearTimeout(timer);
        resolve();
      });
      frameReadyWaiters.clear();
      if (active) showFrame();
      postHostContext();
      deliverPendingThreadLinkReceipt();
      return;
    }
    if (message.type === "taskboard:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (message.type === "taskboard:open-thread") {
      void openThread(message.payload?.threadId);
      return;
    }
    if (message.type === "taskboard:expand-sidebar") {
      expandNativeSidebar();
      return;
    }
    if (message.type === "taskboard:automation-request") {
      void handleAutomationRequest(message.payload);
      return;
    }
    if (message.type === "taskboard:activate-project") {
      void activateProjectFromTaskboard(message.payload);
      return;
    }
    if (message.type === "taskboard:create-thread") {
      void createThreadForTask(message.payload);
      return;
    }
    if (message.type === "taskboard:create-knowledge-thread") {
      void createKnowledgeThread(message.payload);
      return;
    }
    if (message.type === "taskboard:thread-link-ack") {
      const requestId = typeof message.payload?.requestId === "string"
        ? message.payload.requestId
        : "";
      if (requestId && requestId === pendingThreadLinkReceipt?.requestId) {
        persistPendingThreadLinkReceipt(null);
        if (pendingThreadLinkReceiptTimer !== null) window.clearTimeout(pendingThreadLinkReceiptTimer);
        pendingThreadLinkReceiptTimer = null;
      }
      return;
    }
    if (message.type === "taskboard:follow-up-thread") void followUpThreadForTask(message.payload);
  }

  function updateDragRegion(payload) {
    if (!dragRegion || !noDragLeft || !noDragRight) return;
    const [x, y, width, height] = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      dragRegion.hidden = true;
      noDragLeft.hidden = true;
      noDragRight.hidden = true;
      return;
    }
    const left = Math.max(0, x);
    const right = left + width;
    dragRegion.style.left = `${left}px`;
    dragRegion.style.top = `${Math.max(0, y)}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${height}px`;
    noDragLeft.style.left = "0";
    noDragLeft.style.top = `${Math.max(0, y)}px`;
    noDragLeft.style.width = `${left}px`;
    noDragLeft.style.height = `${height}px`;
    noDragRight.style.left = `${right}px`;
    noDragRight.style.top = `${Math.max(0, y)}px`;
    noDragRight.style.right = "0";
    noDragRight.style.height = `${height}px`;
    dragRegion.hidden = false;
    noDragLeft.hidden = left <= 0;
    noDragRight.hidden = right >= page.clientWidth;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "任务面板");

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);

    noDragLeft = document.createElement("div");
    noDragLeft.id = NO_DRAG_LEFT_ID;
    noDragLeft.hidden = true;
    noDragLeft.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragLeft.setAttribute("aria-hidden", "true");
    section.appendChild(noDragLeft);

    noDragRight = document.createElement("div");
    noDragRight.id = NO_DRAG_RIGHT_ID;
    noDragRight.hidden = true;
    noDragRight.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragRight.setAttribute("aria-hidden", "true");
    section.appendChild(noDragRight);
    return section;
  }

  function showLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode("正在启动任务面板…"));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
  }

  function showLoadError(message) {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新启动";
    retry.addEventListener("click", openTaskboard, { once: true });
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function cancelFrameReadyWaiters(error) {
    frameReadyWaiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(error);
    });
    frameReadyWaiters.clear();
  }

  function waitForFrameReady() {
    if (frameReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          frameReadyWaiters.delete(waiter);
          reject(new Error("任务面板页面加载超时"));
        }, FRAME_READY_TIMEOUT_MS),
      };
      frameReadyWaiters.add(waiter);
    });
  }

  function loadTaskboardFrame(cacheBust = false) {
    cancelFrameReadyWaiters(new Error("任务面板正在重新加载"));
    frame?.remove();
    frame = null;
    frameReady = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;

    const taskboardUrl = resolveTaskboardUrl();
    if (cacheBust) {
      taskboardUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    frameOrigin = taskboardUrl.origin;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.src = taskboardUrl.href;
    nextFrame.title = "任务面板";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.addEventListener("load", postHostContext);
    frame = nextFrame;
    page.appendChild(nextFrame);
  }

  function reloadFrame() {
    if (!frame) return false;
    const generation = ++openGeneration;
    if (active) showLoading();
    loadTaskboardFrame(true);
    if (active) {
      void waitForFrameReady()
        .then(() => {
          if (!active || generation !== openGeneration) return;
          showFrame();
          postHostContext();
        })
        .catch((error) => {
          if (!active || generation !== openGeneration) return;
          showLoadError(error.message);
        });
    }
    return true;
  }

  function managedTaskboardOrigin() {
    const configured = typeof window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ === "string"
      ? window.__CODEX_TASKBOARD_MANAGED_ORIGIN__.trim()
      : "";
    try {
      return new URL(configured || DEFAULT_TASKBOARD_URL).origin;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL).origin;
    }
  }

  function hasLiveHostBinding() {
    const heartbeat = Number(window[HOST_HEARTBEAT_NAME]);
    return typeof window[HOST_BINDING_NAME] === "function"
      && Number.isFinite(heartbeat)
      && Date.now() - heartbeat <= HOST_HEARTBEAT_MAX_AGE_MS;
  }

  function requestHost(action, payload = {}) {
    const binding = window[HOST_BINDING_NAME];
    if (!hasLiveHostBinding()) {
      return Promise.reject(new Error("Taskboard 启动器未运行，无法操作 Codex 对话输入框"));
    }

    const id = `${Date.now().toString(36)}-${(++hostRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        hostRequests.delete(id);
        reject(new Error("任务面板启动器没有响应"));
      }, HOST_REQUEST_TIMEOUT_MS);
      hostRequests.set(id, { resolve, reject, timeout });
      try {
        binding(JSON.stringify({ ...payload, id, action }));
      } catch (error) {
        window.clearTimeout(timeout);
        hostRequests.delete(id);
        reject(error);
      }
    });
  }

  function requestHostEnsure(taskboardUrl) {
    if (taskboardUrl.origin !== managedTaskboardOrigin() || !hasLiveHostBinding()) {
      return Promise.resolve({ managed: false, restarted: false });
    }
    return requestHost("ensure");
  }

  function requestHostTaskComposerPrefill({
    instruction,
    skillDisplayName,
    skillName,
    skillPath,
    submit = false,
  }) {
    return requestHost("prefill-task-composer", {
      instruction,
      skillDisplayName,
      skillName,
      skillPath,
      submit,
    });
  }

  function frameMatchesTaskboardUrl(taskboardUrl) {
    if (!frame) return false;
    try {
      const loadedUrl = new URL(frame.getAttribute("src") || frame.src);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(taskboardUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function onHostResponse(response) {
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = hostRequests.get(response.id);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    hostRequests.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "任务面板服务启动失败"));
  }

  async function prepareTaskboard(generation) {
    const taskboardUrl = resolveTaskboardUrl();
    const canReuseFrame = Boolean(
      frameReady
      && frame?.isConnected
      && frameMatchesTaskboardUrl(taskboardUrl),
    );
    if (canReuseFrame) showFrame();
    else showLoading();

    try {
      const [result, context] = await Promise.all([
        requestHostEnsure(taskboardUrl),
        captureHostContext(),
      ]);
      if (!active || generation !== openGeneration) return;
      hostContextSnapshot = context;
      if (!frameReady || result.restarted || !frameMatchesTaskboardUrl(taskboardUrl)) {
        showLoading();
        loadTaskboardFrame();
        await waitForFrameReady();
      }
      if (!active || generation !== openGeneration) return;
      showFrame();
      postHostContext();
    } catch (error) {
      if (!active || generation !== openGeneration) return;
      const bindingAvailable = hasLiveHostBinding();
      showLoadError(bindingAvailable
        ? error.message
        : "任务面板服务未就绪。请保持 Taskboard 启动器运行后重试。");
    }
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function mountActivePage() {
    if (!active) return;
    if (!page) page = createPage();
    const mount = findPageMount();
    const existingSurface = page.parentElement?.closest?.("main")
      ? page.parentElement
      : null;
    const surface = mount?.surface || existingSurface;
    if (!surface) return;

    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
    }
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    hideNativeHeader();
    muteNativeSelection();
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-taskboard-open", "true");
  }

  function closeTaskboard(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    openGeneration += 1;
    active = false;
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeSelection();
    document.documentElement.removeAttribute("data-codex-taskboard-open");
    syncEntryState();
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    hostContextSnapshot = null;
  }

  function openTaskboard() {
    if (destroyed) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = null;
    }
    const generation = ++openGeneration;
    active = true;
    ensureEntry();
    mountActivePage();
    syncEntryState();
    void prepareTaskboard(generation);
  }

  function isNativePageNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest(`#${ENTRY_ID}`)) return false;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    if (buttonMatches(clickable, NATIVE_PAGE_LABELS)) return true;
    return Boolean(clickable.closest(
      "[data-app-action-sidebar-thread-id],"
      + "[data-app-action-sidebar-project-row],"
      + "[data-app-action-sidebar-project-id]",
    ));
  }

  function onDocumentClick(event) {
    const threadRow = event.target?.closest?.("[data-app-action-sidebar-thread-id]");
    const clickedThreadId = normalizeThreadId(threadRow?.getAttribute?.("data-app-action-sidebar-thread-id"));
    if (clickedThreadId) lastNativeThreadId = clickedThreadId;
    if (!active || !isNativePageNavigation(event.target)) return;
    closeTaskboard(false);
  }

  function scheduleRefresh() {
    if (destroyed || reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      ensureEntry();
      mountActivePage();
      postHostContext();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    ensureEntry();
    mountActivePage();
    postHostContext();
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "data-theme",
        "data-color-theme",
        "data-app-action-sidebar-thread-active",
        "data-app-action-sidebar-thread-id",
        "aria-label",
        "aria-current",
      ],
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (reattachTimer !== null) window.clearTimeout(reattachTimer);
    reattachTimer = null;
    observer?.disconnect();
    observer = null;
    cancelFrameReadyWaiters(new Error("任务面板已关闭"));
    hostRequests.forEach(({ reject, timeout }) => {
      window.clearTimeout(timeout);
      reject(new Error("任务面板已关闭"));
    });
    hostRequests.clear();
    pendingThreadCreation = null;
    pendingTaskThreadLink = null;
    if (pendingThreadCheckTimer !== null) window.clearTimeout(pendingThreadCheckTimer);
    pendingThreadCheckTimer = null;
    if (pendingThreadLinkReceiptTimer !== null) window.clearTimeout(pendingThreadLinkReceiptTimer);
    pendingThreadLinkReceiptTimer = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    closeTaskboard(false);
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    page = null;
    frame = null;
    dragRegion = null;
    noDragLeft = null;
    noDragRight = null;
    status = null;
    frameOrigin = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  function onNativeRouteChange() {
    if (active) closeTaskboard(false);
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    refresh,
    reloadFrame,
    open: openTaskboard,
    close: closeTaskboard,
    destroy,
    hostResponse: onHostResponse,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
