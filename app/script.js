(function () {
  const viewport = document.getElementById("viewport");
  const paper = document.getElementById("paper");
  const findBar = document.getElementById("find-bar");
  const findInput = document.getElementById("find-input");
  const findCount = document.getElementById("find-count");
  const findPrev = document.getElementById("find-prev");
  const findNext = document.getElementById("find-next");
  const findClose = document.getElementById("find-close");
  const titleBar = document.getElementById("title-bar");
  const titleInput = document.getElementById("title-input");
  const titleClose = document.getElementById("title-close");
  const selectionBox = document.getElementById("selection-box");
  const defaultDocumentTitle = document.title;
  const appStoragePrefix = "infinite-paper:v10";
  const boardsStorageKey = `${appStoragePrefix}:boards`;
  const legacyV811BoardStorageKey = "infinite-paper:v8.1.1:board";
  const legacyBoardStorageKey = "infinite-paper:v8.1:board";
  const redlineSettingsKey = `${appStoragePrefix}:redlines-enabled`;
  const tabOverlayPositionKey = `${appStoragePrefix}:tab-overlay-position`;
  const boardOverlayStateKey = `${appStoragePrefix}:board-overlay-open`;
  const syncChannelName = `${appStoragePrefix}:sync`;
  const imageDbName = "infinite-paper:v8.1.1:images";
  const imageStoreName = "images";
  const clipboardBridgeImageUrl = "http://127.0.0.1:8124/clipboard-image";
  const panThreshold = 5;
  const snapDistance = 8;
  const pastedImageMaxWidth = 760;
  const pastedImageMaxHeight = 540;
  const clientId = makeId();
  const syncChannel = "BroadcastChannel" in window ? new BroadcastChannel(syncChannelName) : null;
  const spellService = window.createInfinitePaperSpellService(
    `${appStoragePrefix}:personal-dictionary`
  );

  let boards = [];
  let currentBoardId = "";
  let notes = [];
  let imageDbPromise = null;
  let activeDrag = null;
  let spaceDown = false;
  let noteSaveTimer = 0;
  let viewSaveTimer = 0;
  let boardRevision = 0;
  let migratedFromLegacy = false;
  let dirtyNoteIds = new Set();
  let selectedNoteIds = new Set();
  let undoStack = [];
  let redoStack = [];
  let undoInProgress = false;
  let boardClipboard = null;
  let boardCopyPromise = null;
  let textAddUndoIds = new Set();
  let lastPasteTargetPoint = null;
  let keyboardImagePasteProbe = 0;
  let lastImagePasteSignature = "";
  let lastImagePasteAt = 0;
  let pasteStatusTimer = 0;
  let spellHighlightTimer = 0;
  let spellingBubble = null;
  let activeSpelling = null;
  let tabOverlay = null;
  let boardOverlay = null;
  let lastBoardOverlayToggle = null; // { at, wasHidden } — see "Shift+Tab N"
  let renamingBoardId = "";
  let boardClickTimer = 0;
  let activeTabOverlayDrag = null;
  let suppressNextTabOverlayClick = false;
  let redlinesEnabled = loadRedlinesEnabled();
  let tabTitle = defaultDocumentTitle;
  let view = {
    x: Math.round(window.innerWidth / 2),
    y: Math.round(window.innerHeight / 2),
    scale: 1,
  };
  let findState = {
    query: "",
    matches: [],
    activeIndex: -1,
    hasJumped: false,
  };

  function getBoardStorageKey(boardId = currentBoardId) {
    return `${appStoragePrefix}:board:${boardId}`;
  }

  function getViewStorageKey(boardId = currentBoardId) {
    return `${appStoragePrefix}:view:${boardId}`;
  }

  function getTabTitleStorageKey(boardId = currentBoardId) {
    return `${appStoragePrefix}:tab-title:${boardId}`;
  }

  function createBoardRecord(title = "Untitled board") {
    const now = Date.now();
    return {
      id: makeId(),
      title,
      pinned: false,
      order: 0,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    };
  }

  function normalizeBoardRecord(board, fallbackIndex = 0) {
    if (!board || typeof board.id !== "string") {
      return null;
    }

    const now = Date.now();
    return {
      id: board.id,
      title: normalizeTabTitle(board.title || `Board ${fallbackIndex + 1}`) || `Board ${fallbackIndex + 1}`,
      pinned: Boolean(board.pinned),
      order: Number.isFinite(Number(board.order)) ? Number(board.order) : fallbackIndex,
      createdAt: Number(board.createdAt) || now,
      updatedAt: Number(board.updatedAt) || now,
      lastOpenedAt: Number(board.lastOpenedAt) || Number(board.updatedAt) || now,
    };
  }

  function getCurrentBoard() {
    return boards.find((board) => board.id === currentBoardId) || null;
  }

  function isTextEntryElement(element) {
    return Boolean(
      element?.matches?.("input, textarea, select") ||
        element?.isContentEditable ||
        element?.closest?.('[contenteditable="true"]')
    );
  }

  // --- server-backed storage (v11-md) ---------------------------------
  //
  // Boards are .md files on disk, behind the local server's API (see
  // server.js and FORMAT.md). The in-memory model (boards / notes /
  // view) is unchanged; only loading and persistence move to the server.

  const apiBase = "";
  let storageReady = false;
  let pendingNoteSave = false;

  async function apiJson(pathName, options) {
    const response = await fetch(apiBase + pathName, options);
    if (!response.ok) {
      throw new Error(
        `${options?.method || "GET"} ${pathName} -> ${response.status}`
      );
    }
    return response.json();
  }

  function putBoard(payload) {
    return fetch(`${apiBase}/api/boards/${encodeURIComponent(payload.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: payload }),
      keepalive: true,
    });
  }

  // Per-board write queue: merges rapid saves and never overlaps two PUTs
  // for the same board. Partial payloads merge here and again on the
  // server, so a notes save and a metadata save never clobber each other.
  const boardWriteQueue = new Map();
  const boardWriteActive = new Set();

  function queueBoardWrite(payload) {
    if (!payload || !payload.id) {
      return;
    }
    const merged = { ...(boardWriteQueue.get(payload.id) || {}), ...payload };
    boardWriteQueue.set(payload.id, merged);
    flushBoardWrites(payload.id);
  }

  async function flushBoardWrites(boardId) {
    if (boardWriteActive.has(boardId)) {
      return;
    }
    boardWriteActive.add(boardId);
    try {
      while (boardWriteQueue.has(boardId)) {
        const payload = boardWriteQueue.get(boardId);
        boardWriteQueue.delete(boardId);
        try {
          await putBoard(payload);
        } catch (error) {
          console.error("Infinite Paper: board save failed", error);
        }
      }
    } finally {
      boardWriteActive.delete(boardId);
    }
  }

  function boardMetaPayload(board) {
    return {
      id: board.id,
      title: board.title,
      pinned: Boolean(board.pinned),
      order: Number(board.order) || 0,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      lastOpenedAt: board.lastOpenedAt,
    };
  }

  function saveBoardsIndex() {
    // Persist every board's metadata. The server skips files that are
    // byte-identical, so unchanged boards cost nothing.
    for (const board of boards) {
      queueBoardWrite(boardMetaPayload(board));
    }
  }

  function showServerError(error) {
    console.error("Infinite Paper: server unavailable", error);
    paper.innerHTML = "";
    const message = document.createElement("div");
    message.className = "server-error";
    message.textContent =
      "Can't reach the Infinite Paper server. Start it with start.bat, then reload this page.";
    paper.appendChild(message);
  }

  function centeredView() {
    return {
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2),
      scale: 1,
    };
  }

  function loadCurrentBoardView(fallbackView) {
    try {
      const savedView = JSON.parse(
        sessionStorage.getItem(getViewStorageKey()) || "{}"
      );
      if (
        savedView &&
        Number.isFinite(savedView.x) &&
        Number.isFinite(savedView.y)
      ) {
        view = {
          x: savedView.x,
          y: savedView.y,
          scale: clamp(Number(savedView.scale) || 1, 0.45, 2.4),
        };
        return;
      }
    } catch {
      // Fall through to the board file's view or the centered default.
    }

    if (
      fallbackView &&
      Number.isFinite(Number(fallbackView.x)) &&
      Number.isFinite(Number(fallbackView.y))
    ) {
      view = {
        x: Number(fallbackView.x),
        y: Number(fallbackView.y),
        scale: clamp(Number(fallbackView.scale) || 1, 0.45, 2.4),
      };
      return;
    }

    view = centeredView();
  }

  async function migrateLegacyBoardsFromLocalStorage() {
    // One-time rescue of same-origin v10 localStorage boards. Returns the
    // migrated board records, or [] when there is nothing to migrate.
    let index = null;
    try {
      index = JSON.parse(localStorage.getItem(boardsStorageKey) || "null");
    } catch {
      index = null;
    }
    const records = Array.isArray(index?.boards)
      ? index.boards.map(normalizeBoardRecord).filter(Boolean)
      : [];
    if (!records.length) {
      return [];
    }

    for (const record of records) {
      let state = null;
      try {
        state = JSON.parse(
          localStorage.getItem(getBoardStorageKey(record.id)) || "null"
        );
      } catch {
        state = null;
      }
      try {
        await putBoard({
          ...boardMetaPayload(record),
          revision: Number(state?.revision) || 0,
          notes: cleanNotes(normalizeNotes(state?.notes)),
        });
      } catch (error) {
        console.error("Infinite Paper: board migration failed", error);
      }
    }
    return records;
  }

  function legacyV811Notes() {
    try {
      const source =
        JSON.parse(localStorage.getItem(legacyV811BoardStorageKey) || "null") ||
        JSON.parse(localStorage.getItem(legacyBoardStorageKey) || "null");
      return cleanNotes(normalizeNotes(source?.notes));
    } catch {
      return [];
    }
  }

  async function seedFirstBoard() {
    const board = createBoardRecord("Main board");
    const importedNotes = legacyV811Notes();
    if (importedNotes.length) {
      board.title = "Imported v8.1.1";
    }
    boards = [board];
    currentBoardId = board.id;
    notes = importedNotes;
    boardRevision = importedNotes.length ? Date.now() : 0;
    migratedFromLegacy = importedNotes.length > 0;
    try {
      await putBoard({
        ...boardMetaPayload(board),
        revision: boardRevision,
        view: centeredView(),
        notes: importedNotes,
      });
    } catch (error) {
      console.error("Infinite Paper: failed to create first board", error);
    }
  }

  function getRequestedBoardId() {
    try {
      return new URLSearchParams(window.location.search).get("board") || "";
    } catch (error) {
      return "";
    }
  }

  function pickCurrentBoardId() {
    // A ?board=<id> in the URL wins — this is how a deep-linked tab
    // (middle-clicked from the board overlay) lands on the right board.
    const requested = getRequestedBoardId();
    if (requested && boards.some((board) => board.id === requested)) {
      return requested;
    }
    let best = boards[0];
    for (const board of boards) {
      if ((board.lastOpenedAt || 0) > (best.lastOpenedAt || 0)) {
        best = board;
      }
    }
    return best ? best.id : "";
  }

  // Keep the address bar in step with the board on screen, so a refresh
  // (or a copied/opened URL) reopens exactly this board.
  function syncBoardUrl() {
    if (!currentBoardId) {
      return;
    }
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("board") === currentBoardId) {
        return;
      }
      url.searchParams.set("board", currentBoardId);
      window.history.replaceState(null, "", url);
    } catch (error) {
      // A malformed URL is not worth crashing the app over.
    }
  }

  async function loadBoardsIndex() {
    const data = await apiJson("/api/boards");
    boards = Array.isArray(data?.boards)
      ? data.boards.map(normalizeBoardRecord).filter(Boolean)
      : [];

    if (boards.length) {
      currentBoardId = pickCurrentBoardId();
      return true;
    }

    const migrated = await migrateLegacyBoardsFromLocalStorage();
    if (migrated.length) {
      boards = migrated;
      currentBoardId = pickCurrentBoardId();
      return true;
    }

    await seedFirstBoard(); // populates boards / notes / currentBoardId
    return false;
  }

  async function loadCurrentBoardNotes() {
    let saved = null;
    try {
      const data = await apiJson(
        `/api/boards/${encodeURIComponent(currentBoardId)}`
      );
      saved = data?.board || null;
    } catch (error) {
      console.error("Infinite Paper: failed to load board", error);
    }
    notes = normalizeNotes(saved?.notes);
    boardRevision = Number(saved?.revision) || 0;
    migratedFromLegacy = Boolean(saved?.migratedFrom);
    loadCurrentBoardView(saved?.view);
  }

  async function loadState() {
    let fetchCurrent = true;
    try {
      fetchCurrent = await loadBoardsIndex();
      storageReady = true;
    } catch (error) {
      showServerError(error);
      return false;
    }

    if (!boards.some((board) => board.id === currentBoardId)) {
      currentBoardId = boards[0]?.id || "";
    }

    if (fetchCurrent) {
      await loadCurrentBoardNotes();
    } else {
      // seedFirstBoard already populated notes in memory.
      loadCurrentBoardView();
    }
    syncBoardUrl();
    return true;
  }

  function saveNotesSoon() {
    pendingNoteSave = true;
    window.clearTimeout(noteSaveTimer);
    noteSaveTimer = window.setTimeout(saveNotesNow, 80);
  }

  function saveViewSoon() {
    window.clearTimeout(viewSaveTimer);
    viewSaveTimer = window.setTimeout(saveViewNow, 120);
  }

  function saveNotesNow() {
    if (!storageReady) {
      return;
    }
    pendingNoteSave = false;
    syncNotesFromDom();
    const revision = nextRevision();
    const cleaned = cleanNotes(notes);
    const state = {
      version: 1,
      boardId: currentBoardId,
      revision,
      origin: clientId,
      migratedFrom: migratedFromLegacy ? "v8.1" : undefined,
      notes: cleaned,
    };
    const payload = {
      id: currentBoardId,
      revision,
      view: { ...view },
      notes: cleaned,
    };
    const board = getCurrentBoard();
    if (board) {
      board.updatedAt = Date.now();
      Object.assign(payload, boardMetaPayload(board));
      renderBoardOverlayIfVisible();
    }
    queueBoardWrite(payload);
    syncChannel?.postMessage({ type: "board-updated", state });
    dirtyNoteIds.clear();
  }

  function saveViewNow() {
    sessionStorage.setItem(getViewStorageKey(), JSON.stringify(view));
  }

  // --- live reload: pick up external (VS Code / AI) board edits --------

  // True while the cursor is inside a note — a live-reload refresh or a
  // cross-tab sync must never overwrite a note that is being typed into.
  function isEditingANote() {
    const active = document.activeElement;
    return Boolean(
      active &&
        (active.classList.contains("note") ||
          active.classList.contains("md-body"))
    );
  }

  function hasUnsyncedChanges() {
    return (
      pendingNoteSave ||
      isEditingANote() ||
      boardWriteQueue.size > 0 ||
      boardWriteActive.size > 0
    );
  }

  function notesSignature(list) {
    return JSON.stringify(cleanNotes(normalizeNotes(list)));
  }

  function boardsSignature(list) {
    return JSON.stringify(
      [...list]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((board) => ({
          id: board.id,
          pinned: board.pinned,
          order: board.order,
          title: board.title,
        }))
    );
  }

  async function refreshFromServer() {
    let indexData = null;
    let boardData = null;
    try {
      indexData = await apiJson("/api/boards");
      boardData = await apiJson(
        `/api/boards/${encodeURIComponent(currentBoardId)}`
      );
    } catch {
      return; // server hiccup; the next event will retry
    }

    // If the user changed anything while we were fetching, their in-memory
    // copy is the fresher one — don't let a stale echo overwrite it.
    if (hasUnsyncedChanges()) {
      return;
    }

    if (Array.isArray(indexData?.boards)) {
      const incomingBoards = indexData.boards
        .map(normalizeBoardRecord)
        .filter(Boolean);
      // Only re-render when the board list actually differs, so our own
      // saves echoing back don't cause a redundant flicker.
      if (boardsSignature(incomingBoards) !== boardsSignature(boards)) {
        boards = incomingBoards;
        renderBoardOverlayIfVisible();
      }
    }

    const incoming = boardData?.board;
    if (!incoming) {
      return;
    }
    const incomingNotes = normalizeNotes(incoming.notes);
    if (notesSignature(incomingNotes) === notesSignature(notes)) {
      return; // no real change (typically our own save echoing back)
    }
    notes = incomingNotes;
    boardRevision = Number(incoming.revision) || boardRevision;
    pruneSelectedNotes();
    renderSyncedNotes();
    if (!findBar.hidden) {
      refreshFindMatches();
    }
  }

  function setupLiveReload() {
    if (!window.EventSource) {
      return;
    }
    const events = new EventSource(`${apiBase}/api/events`);
    events.addEventListener("boards-changed", () => {
      if (!storageReady || hasUnsyncedChanges()) {
        return; // mid-edit: our in-memory copy is the fresher one
      }
      refreshFromServer();
    });
  }

  function renderBoardOverlayIfVisible() {
    // Skip background re-renders while a rename is in progress — rebuilding
    // the list would blur (and so cancel) the rename input.
    if (boardOverlay && !boardOverlay.hidden && !renamingBoardId) {
      renderBoardOverlay();
    }
  }

  function normalizeTabTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function applyTabTitle(value, options = {}) {
    const cleanTitle = normalizeTabTitle(value);
    tabTitle = cleanTitle || defaultDocumentTitle;
    document.title = tabTitle;

    if (options.updateBoard !== false) {
      const board = getCurrentBoard();
      if (board && board.title !== tabTitle) {
        board.title = tabTitle;
        board.updatedAt = Date.now();
        saveBoardsIndex();
        renderBoardOverlayIfVisible();
      }
    }

    if (options.persist === false) {
      return;
    }

    if (cleanTitle && cleanTitle !== defaultDocumentTitle) {
      sessionStorage.setItem(getTabTitleStorageKey(), cleanTitle);
    } else {
      sessionStorage.removeItem(getTabTitleStorageKey());
    }
  }

  function loadTabTitle() {
    const board = getCurrentBoard();
    applyTabTitle(sessionStorage.getItem(getTabTitleStorageKey()) || board?.title, {
      persist: false,
      updateBoard: false,
    });
  }

  function openTitleRename() {
    hideSpellingBubble();
    titleBar.hidden = false;
    titleInput.value = tabTitle;
    window.requestAnimationFrame(() => {
      titleInput.focus({ preventScroll: true });
      titleInput.select();
    });
  }

  function closeTitleRename() {
    titleBar.hidden = true;
    titleInput.value = "";
  }

  function saveTitleRename() {
    applyTabTitle(titleInput.value);
    closeTitleRename();
    showPasteStatus(tabTitle === defaultDocumentTitle ? "Tab title reset" : `Tab renamed: ${tabTitle}`);
  }

  function loadRedlinesEnabled() {
    try {
      return localStorage.getItem(redlineSettingsKey) !== "false";
    } catch {
      return true;
    }
  }

  function saveRedlinesEnabled() {
    try {
      localStorage.setItem(redlineSettingsKey, redlinesEnabled ? "true" : "false");
    } catch {
      // Settings are optional; keep working if storage is unavailable.
    }
  }

  function syncTabOverlayState() {
    if (!tabOverlay) {
      return;
    }
    const toggle = tabOverlay.querySelector("[data-action='toggle-redlines']");
    if (!toggle) {
      return;
    }
    toggle.textContent = redlinesEnabled ? "Redlines On" : "Redlines Off";
    toggle.setAttribute("aria-pressed", redlinesEnabled ? "true" : "false");
  }

  function applyRedlineSetting() {
    saveRedlinesEnabled();
    syncTabOverlayState();
    if (!redlinesEnabled) {
      window.clearTimeout(spellHighlightTimer);
      hideSpellingBubble();
      CSS.highlights?.delete("app-spell-error");
      return;
    }
    hideSpellingBubble();
    window.clearTimeout(spellHighlightTimer);
    refreshSpellHighlights();
  }

  function loadTabOverlayPosition() {
    try {
      const position = JSON.parse(localStorage.getItem(tabOverlayPositionKey) || "null");
      if (
        Number.isFinite(Number(position?.x)) &&
        Number.isFinite(Number(position?.y))
      ) {
        return {
          x: Number(position.x),
          y: Number(position.y),
        };
      }
    } catch {
      // Keep the default top-left position if storage is unavailable or malformed.
    }
    return null;
  }

  function saveTabOverlayPosition(x, y) {
    try {
      localStorage.setItem(
        tabOverlayPositionKey,
        JSON.stringify({
          x: Math.round(x),
          y: Math.round(y),
        })
      );
    } catch {
      // Position persistence is optional.
    }
  }

  function getTabOverlayPosition() {
    if (!tabOverlay) {
      return { x: 12, y: 12 };
    }

    const rect = tabOverlay.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
    };
  }

  function setTabOverlayPosition(x, y, options = {}) {
    if (!tabOverlay) {
      return;
    }

    const width = tabOverlay.offsetWidth || 128;
    const height = tabOverlay.offsetHeight || 44;
    const margin = 6;
    const nextX = clamp(x, margin, Math.max(margin, window.innerWidth - width - margin));
    const nextY = clamp(y, margin, Math.max(margin, window.innerHeight - height - margin));
    tabOverlay.style.left = `${nextX}px`;
    tabOverlay.style.top = `${nextY}px`;

    if (options.persist) {
      saveTabOverlayPosition(nextX, nextY);
    }
  }

  function restoreTabOverlayPosition() {
    const position = loadTabOverlayPosition();
    if (position) {
      tabOverlay.style.left = `${position.x}px`;
      tabOverlay.style.top = `${position.y}px`;
    }
  }

  function keepTabOverlayOnscreen() {
    if (!tabOverlay || tabOverlay.hidden) {
      return;
    }

    const position = getTabOverlayPosition();
    setTabOverlayPosition(position.x, position.y, { persist: true });
  }

  function startTabOverlayDrag(event) {
    if (event.button !== 0 || !tabOverlay) {
      return;
    }

    const position = getTabOverlayPosition();
    activeTabOverlayDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      overlayX: position.x,
      overlayY: position.y,
      moved: false,
      captured: false,
    };
    window.addEventListener("pointermove", moveTabOverlayDrag, true);
    window.addEventListener("pointerup", endTabOverlayDrag, true);
    window.addEventListener("pointercancel", endTabOverlayDrag, true);
  }

  function moveTabOverlayDrag(event) {
    if (!activeTabOverlayDrag || event.pointerId !== activeTabOverlayDrag.pointerId) {
      return;
    }

    const dx = event.clientX - activeTabOverlayDrag.startX;
    const dy = event.clientY - activeTabOverlayDrag.startY;
    if (!activeTabOverlayDrag.moved && Math.hypot(dx, dy) <= panThreshold) {
      return;
    }

    activeTabOverlayDrag.moved = true;
    if (!activeTabOverlayDrag.captured) {
      try {
        tabOverlay.setPointerCapture(event.pointerId);
      } catch {
        // Window-level drag listeners still keep the overlay moving.
      }
      activeTabOverlayDrag.captured = true;
    }
    tabOverlay.classList.add("is-dragging");
    setTabOverlayPosition(activeTabOverlayDrag.overlayX + dx, activeTabOverlayDrag.overlayY + dy);
  }

  function removeTabOverlayDragListeners() {
    window.removeEventListener("pointermove", moveTabOverlayDrag, true);
    window.removeEventListener("pointerup", endTabOverlayDrag, true);
    window.removeEventListener("pointercancel", endTabOverlayDrag, true);
  }

  function endTabOverlayDrag(event) {
    if (!activeTabOverlayDrag || event.pointerId !== activeTabOverlayDrag.pointerId) {
      return;
    }

    const didMove = activeTabOverlayDrag.moved;
    activeTabOverlayDrag = null;
    removeTabOverlayDragListeners();
    if (tabOverlay.hasPointerCapture(event.pointerId)) {
      tabOverlay.releasePointerCapture(event.pointerId);
    }
    tabOverlay.classList.remove("is-dragging");

    if (didMove && event.type === "pointerup") {
      const position = getTabOverlayPosition();
      saveTabOverlayPosition(position.x, position.y);
      suppressNextTabOverlayClick = true;
      window.setTimeout(() => {
        suppressNextTabOverlayClick = false;
      }, 0);
    }
  }

  function getTabOverlay() {
    if (tabOverlay) {
      return tabOverlay;
    }

    tabOverlay = document.createElement("div");
    tabOverlay.className = "tab-overlay";
    tabOverlay.hidden = true;
    tabOverlay.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      startTabOverlayDrag(event);
    });
    tabOverlay.addEventListener(
      "click",
      (event) => {
        if (!suppressNextTabOverlayClick) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        suppressNextTabOverlayClick = false;
      },
      true
    );
    tabOverlay.addEventListener("lostpointercapture", () => {
      activeTabOverlayDrag = null;
      removeTabOverlayDragListeners();
      tabOverlay.classList.remove("is-dragging");
    });

    const toggleRedlines = document.createElement("button");
    toggleRedlines.type = "button";
    toggleRedlines.dataset.action = "toggle-redlines";
    toggleRedlines.addEventListener("click", () => {
      redlinesEnabled = !redlinesEnabled;
      applyRedlineSetting();
    });
    tabOverlay.appendChild(toggleRedlines);

    document.body.appendChild(tabOverlay);
    syncTabOverlayState();
    restoreTabOverlayPosition();
    return tabOverlay;
  }

  function openTabOverlay() {
    hideSpellingBubble();
    const overlay = getTabOverlay();
    overlay.hidden = false;
    syncTabOverlayState();
    keepTabOverlayOnscreen();
  }

  function closeTabOverlay() {
    if (tabOverlay) {
      tabOverlay.hidden = true;
    }
  }

  function toggleTabOverlay() {
    const overlay = getTabOverlay();
    if (overlay.hidden) {
      openTabOverlay();
    } else {
      closeTabOverlay();
    }
  }

  function sortedBoards() {
    const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
    const pinned = boards.filter((board) => board.pinned).sort(byOrder);
    const unpinned = boards.filter((board) => !board.pinned).sort(byOrder);
    return [...pinned, ...unpinned];
  }

  // Reassign each board's order to its position in the sorted list, so the
  // numbers stay a clean 0..N-1 after any reorder or pin change.
  function renumberBoards() {
    sortedBoards().forEach((board, index) => {
      board.order = index;
    });
  }

  // Pressing a board row opens it; press-and-drag (or press-and-hold) lifts
  // the row so it can be reordered within its group — pinned boards stay
  // pinned, unpinned stay unpinned.
  let boardDrag = null;

  function startBoardPress(event, boardId) {
    if (event.button === 1) {
      // Middle button: suppress the autoscroll glyph. Opening the new tab
      // is handled by the auxclick listener on the same button.
      event.preventDefault();
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const list = boardOverlay?.querySelector(".board-list");
    const row = list?.querySelector(
      `.board-row[data-board-id="${CSS.escape(boardId)}"]`
    );
    if (!list || !row) {
      return;
    }
    const target = event.currentTarget;
    boardDrag = {
      boardId,
      list,
      row,
      target,
      pinned: row.dataset.pinned === "true",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      holdTimer: window.setTimeout(beginBoardDrag, 300),
    };
    target.setPointerCapture(event.pointerId);
    target.addEventListener("pointermove", onBoardPressMove);
    target.addEventListener("pointerup", endBoardPress);
    target.addEventListener("pointercancel", endBoardPress);
  }

  // Promote the press into a drag: lift the row out of flow and snapshot
  // the geometry of its group so the other rows can reflow live.
  function beginBoardDrag() {
    if (!boardDrag || boardDrag.dragging) {
      return;
    }
    const { list, row, pinned } = boardDrag;
    boardDrag.dragging = true;
    window.clearTimeout(boardDrag.holdTimer);
    clearTimeout(boardClickTimer); // cancel any pending board switch

    const groupRows = Array.from(list.querySelectorAll(".board-row")).filter(
      (other) => other.dataset.pinned === String(pinned)
    );
    boardDrag.groupRows = groupRows;
    boardDrag.homeRects = groupRows.map((other) =>
      other.getBoundingClientRect()
    );
    boardDrag.fromIndex = groupRows.indexOf(row);
    boardDrag.targetIndex = boardDrag.fromIndex;
    boardDrag.pitch =
      boardDrag.homeRects.length > 1
        ? boardDrag.homeRects[1].top - boardDrag.homeRects[0].top
        : row.getBoundingClientRect().height + 4;

    row.classList.add("is-dragging");
  }

  function onBoardPressMove(event) {
    if (!boardDrag) {
      return;
    }
    if (!boardDrag.dragging) {
      const moved = Math.hypot(
        event.clientX - boardDrag.startX,
        event.clientY - boardDrag.startY
      );
      if (moved <= 6) {
        return; // still within click tolerance
      }
      beginBoardDrag();
    }

    const { row, groupRows, homeRects, fromIndex, pitch } = boardDrag;
    const delta = event.clientY - boardDrag.startY;

    // The lifted row tracks the cursor exactly.
    row.style.transform = `translateY(${delta}px) scale(1.03)`;

    if (!groupRows || groupRows.length < 2) {
      return; // nothing else in this group to reorder against
    }

    // Which slot is the lifted row's centre over now?
    const home = homeRects[fromIndex];
    const draggedCenter = home.top + home.height / 2 + delta;
    let targetIndex = 0;
    for (let i = 0; i < groupRows.length; i += 1) {
      if (i === fromIndex) {
        continue;
      }
      const rect = homeRects[i];
      if (rect.top + rect.height / 2 < draggedCenter) {
        targetIndex += 1;
      }
    }
    boardDrag.targetIndex = targetIndex;

    // Slide every other row to open a gap at the target slot.
    for (let i = 0; i < groupRows.length; i += 1) {
      if (i === fromIndex) {
        continue;
      }
      let shift = 0;
      if (i < fromIndex && i >= targetIndex) {
        shift = pitch;
      } else if (i > fromIndex && i <= targetIndex) {
        shift = -pitch;
      }
      groupRows[i].style.transform = shift ? `translateY(${shift}px)` : "";
    }
  }

  function endBoardPress(event) {
    if (!boardDrag) {
      return;
    }
    const drag = boardDrag;
    boardDrag = null;
    window.clearTimeout(drag.holdTimer);
    drag.target.releasePointerCapture?.(drag.pointerId);
    drag.target.removeEventListener("pointermove", onBoardPressMove);
    drag.target.removeEventListener("pointerup", endBoardPress);
    drag.target.removeEventListener("pointercancel", endBoardPress);

    if (!drag.dragging) {
      if (event.type === "pointerup") {
        scheduleBoardSwitch(drag.boardId); // a plain press opens the board
      }
      return;
    }

    commitBoardDrag(drag);
  }

  function commitBoardDrag(drag) {
    const { row, groupRows, fromIndex, targetIndex, pitch } = drag;

    // Reorder this group's ids, then renumber every board's order.
    const groupIds = groupRows.map((other) => other.dataset.boardId);
    if (groupRows.length >= 2 && targetIndex !== fromIndex) {
      const [movedId] = groupIds.splice(fromIndex, 1);
      groupIds.splice(targetIndex, 0, movedId);
    }
    const pinnedIds = drag.pinned
      ? groupIds
      : sortedBoards()
          .filter((board) => board.pinned)
          .map((board) => board.id);
    const unpinnedIds = drag.pinned
      ? sortedBoards()
          .filter((board) => !board.pinned)
          .map((board) => board.id)
      : groupIds;
    [...pinnedIds, ...unpinnedIds].forEach((id, index) => {
      const board = boards.find((entry) => entry.id === id);
      if (board) {
        board.order = index;
      }
    });
    saveBoardsIndex();

    // Ease the lifted row into its slot, then redraw the list cleanly.
    row.style.transition = "transform 0.14s ease";
    row.style.transform = `translateY(${(targetIndex - fromIndex) * pitch}px)`;
    window.setTimeout(renderBoardOverlay, 150);
  }

  function getBoardOverlay() {
    if (boardOverlay) {
      return boardOverlay;
    }

    boardOverlay = document.createElement("section");
    boardOverlay.className = "board-overlay";
    boardOverlay.hidden = true;
    boardOverlay.setAttribute("aria-label", "Board history");
    boardOverlay.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    document.body.appendChild(boardOverlay);
    renderBoardOverlay();
    return boardOverlay;
  }

  function renderBoardOverlay() {
    if (!boardOverlay || boardDrag) {
      return;
    }

    boardOverlay.innerHTML = "";

    const top = document.createElement("div");
    top.className = "board-overlay-top";
    const title = document.createElement("strong");
    title.textContent = "Boards";
    const hint = document.createElement("span");
    hint.textContent = "Shift+Tab toggles";
    top.appendChild(title);
    top.appendChild(hint);

    const historyActions = document.createElement("div");
    historyActions.className = "board-history-actions";

    const undoButton = document.createElement("button");
    undoButton.type = "button";
    undoButton.className = "board-history-button";
    undoButton.dataset.action = "undo";
    undoButton.textContent = "↶";
    undoButton.title = "Undo (Ctrl+Z)";
    undoButton.setAttribute("aria-label", "Undo");
    undoButton.addEventListener("click", () => {
      undoLastAction();
    });
    historyActions.appendChild(undoButton);

    const redoButton = document.createElement("button");
    redoButton.type = "button";
    redoButton.className = "board-history-button";
    redoButton.dataset.action = "redo";
    redoButton.textContent = "↷";
    redoButton.title = "Redo (Ctrl+Y)";
    redoButton.setAttribute("aria-label", "Redo");
    redoButton.addEventListener("click", () => {
      redoLastAction();
    });
    historyActions.appendChild(redoButton);

    top.appendChild(historyActions);
    boardOverlay.appendChild(top);

    const side = document.createElement("aside");
    side.className = "board-overlay-side";

    const newButton = document.createElement("button");
    newButton.type = "button";
    newButton.className = "board-new-button";
    newButton.textContent = "+ New board";
    newButton.addEventListener("click", openNewBoardInTab);
    // Middle button (scroll-wheel) opens a new board too, matching the
    // middle-click behaviour of the existing board rows.
    newButton.addEventListener("pointerdown", (event) => {
      if (event.button === 1) {
        event.preventDefault(); // suppress the middle-click autoscroll glyph
      }
    });
    newButton.addEventListener("auxclick", (event) => {
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
      openNewBoardInTab();
    });
    side.appendChild(newButton);

    const list = document.createElement("div");
    list.className = "board-list";
    for (const board of sortedBoards()) {
      const row = document.createElement("div");
      row.className = "board-row";
      row.dataset.boardId = board.id;
      row.dataset.pinned = board.pinned ? "true" : "false";
      row.classList.toggle("is-current", board.id === currentBoardId);
      // Right-click a row for the board menu (currently: Delete board).
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showBoardContextMenu(board.id, event.clientX, event.clientY);
      });

      if (renamingBoardId === board.id) {
        const renameForm = document.createElement("form");
        renameForm.className = "board-rename-form";

        const input = document.createElement("input");
        input.className = "board-rename-input";
        input.dataset.renameBoardId = board.id;
        input.value = board.title || "Untitled board";
        input.maxLength = 80;
        input.spellcheck = false;
        input.addEventListener("pointerdown", (event) => {
          event.stopPropagation();
        });
        input.addEventListener("blur", () => {
          finishBoardRename(board.id, input.value);
        });

        renameForm.addEventListener("submit", (event) => {
          event.preventDefault();
          finishBoardRename(board.id, input.value);
        });

        renameForm.appendChild(input);
        row.appendChild(renameForm);
      } else {
        const select = document.createElement("button");
        select.type = "button";
        select.className = "board-select";
        select.addEventListener("pointerdown", (event) =>
          startBoardPress(event, board.id)
        );
        // Middle button (scroll-wheel click) opens the board in a new tab.
        select.addEventListener("auxclick", (event) => {
          if (event.button !== 1) {
            return;
          }
          event.preventDefault();
          openBoardInNewTab(board.id);
        });
        select.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          clearTimeout(boardClickTimer);
          startBoardRename(board.id);
        });
        const name = document.createElement("span");
        name.textContent = board.title || "Untitled board";
        select.appendChild(name);
        row.appendChild(select);
      }

      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "board-pin";
      pin.textContent = board.pinned ? "Pinned" : "Pin";
      pin.setAttribute("aria-pressed", board.pinned ? "true" : "false");
      pin.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleBoardPin(board.id);
      });
      row.appendChild(pin);

      list.appendChild(row);
    }
    side.appendChild(list);
    boardOverlay.appendChild(side);
    syncBoardOverlayUndoRedoControls();
    updateBoardOverlayHighlight();
  }

  function syncBoardOverlayUndoRedoControls() {
    if (!boardOverlay) {
      return;
    }

    const undoButton = boardOverlay.querySelector("[data-action='undo']");
    const redoButton = boardOverlay.querySelector("[data-action='redo']");
    if (undoButton) {
      undoButton.disabled = undoInProgress || !undoStack.length;
    }
    if (redoButton) {
      redoButton.disabled = undoInProgress || !redoStack.length;
    }
  }

  function startBoardRename(boardId) {
    if (!boards.some((board) => board.id === boardId)) {
      return;
    }
    renamingBoardId = boardId;
    renderBoardOverlay();
    window.requestAnimationFrame(() => {
      const input = boardOverlay?.querySelector(".board-rename-input");
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }

  function getFocusedBoardOverlayId() {
    if (!boardOverlay || boardOverlay.hidden) {
      return "";
    }

    const row = document.activeElement?.closest?.(".board-row");
    return row?.dataset.boardId || currentBoardId;
  }

  function scheduleBoardSwitch(boardId) {
    clearTimeout(boardClickTimer);
    boardClickTimer = window.setTimeout(() => {
      switchBoard(boardId);
    }, 180);
  }

  // Middle-click on a board row opens it in a fresh browser tab — the same
  // gesture that opens any link on the web. The new tab carries a
  // ?board=<id> so it loads straight into that board.
  function openBoardInNewTab(boardId) {
    if (!boards.some((board) => board.id === boardId)) {
      return;
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("board", boardId);
      url.hash = "";
      window.open(url.toString(), "_blank");
    } catch (error) {
      console.error("Infinite Paper: could not open board in a new tab", error);
    }
  }

  // Creating a board opens it in its own browser tab. The new tab is
  // launched with ?newboard=1 and spawns the board itself on boot, so the
  // current tab stays on whatever board it was already showing.
  function openNewBoardInTab() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("board"); // the new tab makes its own board
      url.searchParams.set("newboard", "1");
      url.hash = "";
      window.open(url.toString(), "_blank");
    } catch (error) {
      console.error("Infinite Paper: could not open a new board tab", error);
    }
  }

  // Boot hook: a tab opened with ?newboard=1 creates a fresh board and
  // drops straight into renaming it.
  function maybeSpawnNewBoardFromUrl() {
    let wantsNewBoard = false;
    try {
      wantsNewBoard =
        new URLSearchParams(window.location.search).get("newboard") === "1";
    } catch (error) {
      wantsNewBoard = false;
    }
    if (!wantsNewBoard) {
      return;
    }
    // Drop the flag first, so refreshing this tab does not spawn again.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("newboard");
      window.history.replaceState(null, "", url);
    } catch (error) {
      // A malformed URL is not worth crashing the app over.
    }
    openBoardOverlay();
    createAndSwitchBoard();
  }

  // --- board overlay keyboard cursor + multi-selection ---------------

  let boardCursorId = "";
  let boardSelectionAnchorId = "";
  let boardSelection = new Set();

  function boardOrderIds() {
    return sortedBoards().map((board) => board.id);
  }

  // Move the keyboard highlight to a board. extend:true (Shift+Arrow)
  // selects the whole inclusive range from the anchor to here; otherwise
  // the selection collapses to this board and it becomes the new anchor.
  function setBoardCursor(boardId, options = {}) {
    if (!boardId || !boards.some((board) => board.id === boardId)) {
      return;
    }
    boardCursorId = boardId;
    if (options.extend && boardSelectionAnchorId) {
      const order = boardOrderIds();
      const a = order.indexOf(boardSelectionAnchorId);
      const b = order.indexOf(boardId);
      if (a !== -1 && b !== -1) {
        boardSelection = new Set(
          order.slice(Math.min(a, b), Math.max(a, b) + 1)
        );
      } else {
        boardSelection = new Set([boardId]);
      }
    } else {
      boardSelectionAnchorId = boardId;
      boardSelection = new Set([boardId]);
    }
    updateBoardOverlayHighlight();
  }

  function moveBoardCursor(delta, extend) {
    const order = boardOrderIds();
    if (!order.length) {
      return;
    }
    let index = order.indexOf(boardCursorId);
    if (index === -1) {
      index = order.indexOf(currentBoardId);
    }
    index =
      index === -1
        ? 0
        : Math.min(order.length - 1, Math.max(0, index + delta));
    setBoardCursor(order[index], { extend });
    // Move real focus onto the cursor row — keeps focus inside the overlay
    // so Delete targets a board only while you're actually navigating it.
    focusBoardCursorRow();
    const row = boardOverlay?.querySelector(
      `.board-row[data-board-id="${CSS.escape(order[index])}"]`
    );
    row?.scrollIntoView({ block: "nearest" });
  }

  // Put keyboard focus on the cursor row's button (without a scroll jump).
  function focusBoardCursorRow() {
    if (!boardOverlay || boardOverlay.hidden) {
      return;
    }
    const button = boardOverlay.querySelector(
      `.board-row[data-board-id="${CSS.escape(boardCursorId)}"] .board-select`
    );
    button?.focus({ preventScroll: true });
  }

  // Repaint the cursor / selection classes without rebuilding the list.
  function updateBoardOverlayHighlight() {
    if (!boardOverlay) {
      return;
    }
    const multi = boardSelection.size > 1;
    for (const row of boardOverlay.querySelectorAll(".board-row")) {
      const id = row.dataset.boardId;
      row.classList.toggle("is-cursor", id === boardCursorId);
      row.classList.toggle("is-selected", multi && boardSelection.has(id));
    }
  }

  // --- board deletion -------------------------------------------------

  function boardTitleOf(boardId) {
    const board = boards.find((item) => item.id === boardId);
    return board ? board.title || "Untitled board" : "board";
  }

  function deleteBoard(boardId) {
    return deleteBoards([boardId]);
  }

  async function deleteBoards(ids) {
    const targets = [...new Set(ids)].filter((id) =>
      boards.some((board) => board.id === id)
    );
    if (!targets.length) {
      return;
    }
    if (targets.length >= boards.length) {
      showPasteStatus("Can't delete every board — keep at least one", true);
      return;
    }

    const label =
      targets.length === 1
        ? `board "${boardTitleOf(targets[0])}"`
        : `${targets.length} boards`;

    // Confirm only the first time — once acknowledged, later deletes are
    // immediate.
    const deleteConfirmedKey = `${appStoragePrefix}:board-delete-confirmed`;
    let alreadyConfirmed = false;
    try {
      alreadyConfirmed = localStorage.getItem(deleteConfirmedKey) === "1";
    } catch (error) {
      alreadyConfirmed = false;
    }
    if (!alreadyConfirmed) {
      const confirmed = window.confirm(
        `Delete ${label}?\n\n` +
          "This permanently removes the .md file(s) and cannot be undone.\n" +
          "(You won't be asked again.)"
      );
      if (!confirmed) {
        return;
      }
      try {
        localStorage.setItem(deleteConfirmedKey, "1");
      } catch (error) {
        // Non-fatal: the confirm just shows again next time.
      }
    }

    // Work out where the cursor should land afterwards: the first
    // surviving board below the deleted run, else the first one above it.
    const order = boardOrderIds();
    const targetSet = new Set(targets);
    const indices = targets.map((id) => order.indexOf(id));
    const lastIndex = Math.max(...indices);
    const firstIndex = Math.min(...indices);
    let landingId = "";
    for (let i = lastIndex + 1; i < order.length && !landingId; i += 1) {
      if (!targetSet.has(order[i])) {
        landingId = order[i];
      }
    }
    for (let i = firstIndex - 1; i >= 0 && !landingId; i -= 1) {
      if (!targetSet.has(order[i])) {
        landingId = order[i];
      }
    }

    // If we're viewing a doomed board, move off it first — skipSave so the
    // leaving board isn't re-saved (which would re-create its .md file).
    if (targetSet.has(currentBoardId) && landingId) {
      await switchBoard(landingId, { skipSave: true });
    }

    const deleted = [];
    for (const id of targets) {
      boardWriteQueue.delete(id); // drop queued writes so they can't revive it
      try {
        await apiJson(`/api/boards/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        deleted.push(id);
      } catch (error) {
        console.error("Infinite Paper: failed to delete board", id, error);
      }
    }
    if (!deleted.length) {
      showPasteStatus("Could not delete the board(s)", true);
      return;
    }

    const deletedSet = new Set(deleted);
    boards = boards.filter((board) => !deletedSet.has(board.id));
    renumberBoards();
    saveBoardsIndex();

    // Park the keyboard cursor on the landing board.
    if (landingId && boards.some((board) => board.id === landingId)) {
      setBoardCursor(landingId);
    } else if (boards.length) {
      setBoardCursor(boards[0].id);
    }

    renderBoardOverlay();
    focusBoardCursorRow();
    showPasteStatus(
      deleted.length === 1
        ? `Deleted ${label}`
        : `Deleted ${deleted.length} boards`
    );
  }

  // --- board right-click menu ----------------------------------------

  let boardContextMenu = null;

  function closeBoardContextMenu() {
    if (!boardContextMenu) {
      return;
    }
    boardContextMenu.remove();
    boardContextMenu = null;
    window.removeEventListener("pointerdown", dismissBoardContextMenu, true);
    window.removeEventListener("keydown", onBoardContextMenuKey, true);
  }

  function dismissBoardContextMenu(event) {
    if (boardContextMenu && !boardContextMenu.contains(event.target)) {
      closeBoardContextMenu();
    }
  }

  function onBoardContextMenuKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeBoardContextMenu();
    }
  }

  function showBoardContextMenu(boardId, x, y) {
    closeBoardContextMenu();
    if (!boards.some((item) => item.id === boardId)) {
      return;
    }

    const menu = document.createElement("div");
    menu.className = "board-context-menu";

    const deleteItem = document.createElement("button");
    deleteItem.type = "button";
    deleteItem.className = "board-context-item is-danger";
    deleteItem.textContent = "Delete board";
    deleteItem.addEventListener("click", () => {
      closeBoardContextMenu();
      deleteBoard(boardId);
    });
    menu.appendChild(deleteItem);

    document.body.appendChild(menu);

    // Keep the menu fully on-screen.
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    boardContextMenu = menu;
    // Defer the dismiss listeners so the opening event doesn't close it.
    window.setTimeout(() => {
      if (!boardContextMenu) {
        return;
      }
      window.addEventListener("pointerdown", dismissBoardContextMenu, true);
      window.addEventListener("keydown", onBoardContextMenuKey, true);
    }, 0);
  }

  function finishBoardRename(boardId, value) {
    if (renamingBoardId !== boardId) {
      return;
    }

    const board = boards.find((item) => item.id === boardId);
    if (!board) {
      renamingBoardId = "";
      renderBoardOverlay();
      return;
    }

    const nextTitle = normalizeTabTitle(value) || board.title || "Untitled board";
    board.title = nextTitle;
    board.updatedAt = Date.now();
    renamingBoardId = "";
    saveBoardsIndex();
    sessionStorage.setItem(getTabTitleStorageKey(boardId), nextTitle);

    if (boardId === currentBoardId) {
      applyTabTitle(nextTitle, { persist: false, updateBoard: false });
    }

    renderBoardOverlay();
  }

  // Remember whether the overlay is open so a refresh restores it. Stored
  // in sessionStorage, so the state is per-tab and survives a reload but
  // not the tab closing.
  function saveBoardOverlayState(open) {
    try {
      sessionStorage.setItem(boardOverlayStateKey, open ? "1" : "0");
    } catch (error) {
      // Non-fatal — the overlay just won't survive a refresh.
    }
  }

  function restoreBoardOverlayState() {
    let wasOpen = false;
    try {
      wasOpen = sessionStorage.getItem(boardOverlayStateKey) === "1";
    } catch (error) {
      wasOpen = false;
    }
    if (wasOpen) {
      openBoardOverlay();
    }
  }

  function openBoardOverlay() {
    hideSpellingBubble();
    const overlay = getBoardOverlay();
    setBoardCursor(currentBoardId); // start the keyboard cursor on the current board
    renderBoardOverlay();
    overlay.hidden = false;
    saveBoardOverlayState(true);
  }

  function closeBoardOverlay() {
    if (boardOverlay) {
      clearTimeout(boardClickTimer);
      renamingBoardId = "";
      boardOverlay.hidden = true;
    }
    closeBoardContextMenu();
    saveBoardOverlayState(false);
  }

  function toggleBoardOverlay() {
    const overlay = getBoardOverlay();
    // Remember the pre-toggle state so a following N (the "Shift+Tab N"
    // gesture) can undo this toggle and leave the page's overlay as it was.
    lastBoardOverlayToggle = { at: Date.now(), wasHidden: overlay.hidden };
    // Shift+Tab is a context switch to board management — drop focus out of
    // any note being edited, so the next key (e.g. N for a new board) is the
    // shortcut and isn't typed into the note.
    if (isTextEntryElement(document.activeElement)) {
      document.activeElement.blur();
    }
    if (overlay.hidden) {
      openBoardOverlay();
    } else {
      closeBoardOverlay();
    }
  }

  // Undo a board-overlay toggle — used when a Shift+Tab turns out to have
  // been the lead-in to a "Shift+Tab N" gesture, which must leave this
  // page's overlay exactly as it was.
  function restoreBoardOverlay(shouldBeHidden) {
    const overlay = getBoardOverlay();
    if (shouldBeHidden && !overlay.hidden) {
      closeBoardOverlay();
    } else if (!shouldBeHidden && overlay.hidden) {
      openBoardOverlay();
    }
  }

  async function switchBoard(boardId, options = {}) {
    if (!boards.some((board) => board.id === boardId)) {
      return;
    }
    if (boardId === currentBoardId) {
      return;
    }

    clearTimeout(boardClickTimer);
    renamingBoardId = "";
    // skipSave: used when the board we're leaving is about to be deleted —
    // saving it would just re-create the .md file we're removing.
    if (!options.skipSave) {
      saveNotesNow();
      saveViewNow();
    }
    currentBoardId = boardId;
    syncBoardUrl();
    setBoardCursor(boardId); // keep the keyboard cursor on the viewed board

    const board = getCurrentBoard();
    if (board) {
      board.lastOpenedAt = Date.now();
      if (!options.skipSave) {
        saveBoardsIndex();
      }
    }

    for (const element of paper.querySelectorAll(".image-note")) {
      releaseImageElement(element);
    }
    await loadCurrentBoardNotes();
    loadTabTitle();
    applyView();
    renderNotes();
    if (!findBar.hidden) {
      refreshFindMatches();
    }
    renderBoardOverlay();
  }

  function createAndSwitchBoard() {
    saveNotesNow();
    saveViewNow();
    renamingBoardId = "";
    const board = createBoardRecord(`Board ${boards.length + 1}`);
    boards.push(board);
    board.order = -1; // float a new board to the top of the unpinned group
    renumberBoards();
    currentBoardId = board.id;
    syncBoardUrl();
    notes = [];
    boardRevision = 0;
    migratedFromLegacy = false;
    selectedNoteIds.clear();
    undoStack = [];
    redoStack = [];
    textAddUndoIds.clear();
    loadCurrentBoardView();
    queueBoardWrite({
      ...boardMetaPayload(board),
      revision: 0,
      view: { ...view },
      notes: [],
    });
    saveBoardsIndex(); // persist the renumbered order of the other boards too
    loadTabTitle();
    applyView();
    renderNotes();
    startBoardRename(board.id); // a fresh board opens straight into rename
  }

  function toggleBoardPin(boardId) {
    const board = boards.find((item) => item.id === boardId);
    if (!board) {
      return;
    }
    board.pinned = !board.pinned;
    board.updatedAt = Date.now();
    board.order = boards.length; // drop it at the end of its new group
    renumberBoards();
    saveBoardsIndex();
    renderBoardOverlay();
  }

  function nextRevision() {
    boardRevision = Math.max(Date.now(), boardRevision + 1);
    return boardRevision;
  }

  function cleanNotes(sourceNotes) {
    return sourceNotes.map((note) => {
      const base = {
        id: note.id,
        type: note.type || "text",
        x: note.x,
        y: note.y,
      };

      if (base.type === "image") {
        return {
          ...base,
          imageId: note.imageId,
          mimeType: note.mimeType || "image/png",
          width: note.width,
          height: note.height,
          rotation: normalizeRotation(note.rotation),
          flipX: Boolean(note.flipX),
          flipY: Boolean(note.flipY),
          crop: cleanCrop(note.crop),
        };
      }

      if (base.type === "markdown") {
        return {
          ...base,
          text: note.text || "",
          width: Math.round(Number(note.width)) || 380,
          height: Math.round(Number(note.height)) || 420,
        };
      }

      return {
        ...base,
        text: note.text || "",
      };
    });
  }

  function cloneNote(note) {
    return cleanNotes([note])[0];
  }

  function normalizeNotes(sourceNotes) {
    if (!Array.isArray(sourceNotes)) {
      return [];
    }

    return sourceNotes
      .filter(
        (note) =>
          note &&
          typeof note.id === "string" &&
          Number.isFinite(Number(note.x)) &&
          Number.isFinite(Number(note.y))
      )
      .map((note) => ({
        id: note.id,
        type:
          note.type === "image"
            ? "image"
            : note.type === "markdown"
            ? "markdown"
            : "text",
        x: Math.round(Number(note.x)),
        y: Math.round(Number(note.y)),
        text: typeof note.text === "string" ? note.text : "",
        imageId: typeof note.imageId === "string" ? note.imageId : "",
        mimeType: typeof note.mimeType === "string" ? note.mimeType : "image/png",
        width: Number.isFinite(Number(note.width)) ? Math.round(Number(note.width)) : 320,
        height: Number.isFinite(Number(note.height)) ? Math.round(Number(note.height)) : 180,
        rotation: normalizeRotation(note.rotation),
        flipX: Boolean(note.flipX),
        flipY: Boolean(note.flipY),
        crop: cleanCrop(note.crop),
      }));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeRotation(value) {
    const degrees = Number(value) || 0;
    return ((degrees % 360) + 360) % 360;
  }

  // A crop is the fraction {x, y, w, h} of the natural image that is shown.
  // {0,0,1,1} means the whole image (no crop).
  function cleanCrop(crop) {
    const source = crop && typeof crop === "object" ? crop : {};
    const num = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };
    let x = clamp(num(source.x, 0), 0, 1);
    let y = clamp(num(source.y, 0), 0, 1);
    let w = clamp(num(source.w, 1), 0.02, 1);
    let h = clamp(num(source.h, 1), 0.02, 1);
    if (x + w > 1) {
      w = 1 - x;
    }
    if (y + h > 1) {
      h = 1 - y;
    }
    return { x, y, w, h };
  }

  function isCropped(crop) {
    const c = cleanCrop(crop);
    return c.x > 0.0005 || c.y > 0.0005 || c.w < 0.9995 || c.h < 0.9995;
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function openImageDb() {
    if (!window.indexedDB) {
      return Promise.reject(new Error("IndexedDB is unavailable"));
    }

    if (!imageDbPromise) {
      imageDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(imageDbName, 1);

        request.onupgradeneeded = () => {
          request.result.createObjectStore(imageStoreName);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    return imageDbPromise;
  }

  async function saveImageBlob(imageId, blob) {
    const db = await openImageDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(imageStoreName, "readwrite");
      transaction.objectStore(imageStoreName).put(blob, imageId);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function getImageBlob(imageId) {
    const db = await openImageDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(imageStoreName, "readonly").objectStore(imageStoreName).get(imageId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteImageBlob(imageId) {
    if (!imageId) {
      return;
    }

    const db = await openImageDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(imageStoreName, "readwrite");
      transaction.objectStore(imageStoreName).delete(imageId);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // --- portable image storage (server attachments) --------------------
  //
  // Image bytes are written to the local server's notes folder (an
  // `attachments/` file) so a pasted screenshot shows in any browser, not
  // just the one that pasted it. IndexedDB (above) stays as a per-browser
  // cache + undo source, and as the migration source for older boards.

  function mimeToExt(mime) {
    switch ((mime || "").toLowerCase()) {
      case "image/jpeg":
      case "image/jpg":
        return "jpg";
      case "image/webp":
        return "webp";
      case "image/gif":
        return "gif";
      case "image/svg+xml":
        return "svg";
      default:
        return "png";
    }
  }

  function attachmentUrl(note) {
    if (!note || !note.imageId) {
      return "";
    }
    return `${apiBase}/attachments/${encodeURIComponent(note.imageId)}.${mimeToExt(
      note.mimeType
    )}`;
  }

  // Best-effort — never throws, so a server hiccup can't break a paste.
  async function uploadAttachment(imageId, blob) {
    if (!imageId || !blob) {
      return false;
    }
    try {
      const ext = mimeToExt(blob.type);
      const response = await fetch(
        `${apiBase}/api/attachments?id=${encodeURIComponent(imageId)}&ext=${ext}`,
        {
          method: "POST",
          headers: { "Content-Type": blob.type || "application/octet-stream" },
          body: blob,
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async function getImageDimensions(blob) {
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = reject;
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function loadImageIntoElement(note, image) {
    image.dataset.imageId = note.imageId || "";
    if (!note.imageId) {
      image.removeAttribute("src");
      return;
    }

    // Prefer the server file (portable across browsers). If it isn't there —
    // e.g. an older board whose bytes only live in this browser's IndexedDB —
    // fall back to IndexedDB and upload it so it's portable from now on.
    image.onerror = () => {
      image.onerror = null;
      if (image.dataset.imageId !== note.imageId) {
        return;
      }
      getImageBlob(note.imageId)
        .then((blob) => {
          if (!blob || image.dataset.imageId !== note.imageId) {
            image.removeAttribute("src");
            return;
          }
          uploadAttachment(note.imageId, blob); // migrate to the server
          if (image.dataset.objectUrl) {
            URL.revokeObjectURL(image.dataset.objectUrl);
          }
          const url = URL.createObjectURL(blob);
          image.dataset.objectUrl = url;
          image.src = url;
        })
        .catch(() => image.removeAttribute("src"));
    };
    image.src = attachmentUrl(note);
  }

  function releaseImageElement(element) {
    const image = element.querySelector?.("img");
    if (image?.dataset.objectUrl) {
      URL.revokeObjectURL(image.dataset.objectUrl);
      delete image.dataset.objectUrl;
    }
  }

  function applyView() {
    paper.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function viewportToWorld(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    };
  }

  function worldToViewport(worldX, worldY) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: rect.left + view.x + worldX * view.scale,
      y: rect.top + view.y + worldY * view.scale,
    };
  }

  function getViewportCenterWorld() {
    const rect = viewport.getBoundingClientRect();
    return viewportToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function isTextNote(note) {
    return (note.type || "text") === "text";
  }

  function handleBoardItemPointerDown(event, noteId) {
    const note = findNote(noteId);
    hideSpellingBubble();

    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
      startSelectionDrag(event, noteId);
      return;
    }

    if (event.button === 0 && note && !isTextNote(note) && !selectedNoteIds.has(noteId)) {
      event.preventDefault();
      event.stopPropagation();
      setSelectedNotes([noteId]);
      return;
    }

    if (event.button === 0 && selectedNoteIds.has(noteId)) {
      event.preventDefault();
      event.stopPropagation();
      startMoveSelection(event);
      return;
    }

    if (event.button === 0) {
      clearSelectedNotes();
    }

    event.stopPropagation();
  }

  function makeMarkdownTab(label, mode) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "md-tab";
    tab.dataset.mdMode = mode;
    tab.textContent = label;
    tab.addEventListener("pointerdown", (event) => event.stopPropagation());
    return tab;
  }

  // Switch a markdown note between the rendered Preview and the raw
  // Markdown source. Leaving source mode captures whatever was typed.
  function setMarkdownMode(element, mode) {
    const note = findNote(element.dataset.id);
    if (!note) {
      return;
    }
    const body = element.querySelector(".md-body");
    if (element.dataset.mdMode === "source" && body.isContentEditable) {
      note.text = getNoteText(body);
    }
    element.dataset.mdMode = mode;
    for (const tab of element.querySelectorAll(".md-tab")) {
      tab.classList.toggle("is-active", tab.dataset.mdMode === mode);
    }
    if (mode === "source") {
      body.contentEditable = "plaintext-only";
      body.spellcheck = false;
      body.textContent = note.text || "";
    } else {
      body.contentEditable = "false";
      body.innerHTML = window.renderInfinitePaperMarkdown
        ? window.renderInfinitePaperMarkdown(note.text || "")
        : "";
    }
  }

  function createMarkdownElement(note) {
    const noteId = note.id;
    const element = document.createElement("div");
    element.className = "board-item markdown-note";
    element.dataset.id = noteId;
    element.dataset.type = "markdown";
    element.dataset.mdMode = "preview";
    element.style.left = `${note.x}px`;
    element.style.top = `${note.y}px`;
    element.style.width = `${Math.round(Number(note.width)) || 380}px`;
    element.style.height = `${Math.round(Number(note.height)) || 420}px`;

    const tabs = document.createElement("div");
    tabs.className = "md-tabs";
    const previewTab = makeMarkdownTab("Preview", "preview");
    const sourceTab = makeMarkdownTab("Markdown", "source");
    tabs.append(previewTab, sourceTab);
    // The tab strip doubles as the note's drag handle.
    tabs.addEventListener("pointerdown", (event) => {
      handleBoardItemPointerDown(event, noteId);
    });
    previewTab.addEventListener("click", () =>
      setMarkdownMode(element, "preview")
    );
    sourceTab.addEventListener("click", () =>
      setMarkdownMode(element, "source")
    );

    const body = document.createElement("div");
    body.className = "md-body";
    // In Preview the body is read-only — pressing it picks up and moves the
    // whole note, like pressing the tab strip. In Markdown (source) mode the
    // body is the editor, so keep clicks and text selection inside it.
    body.addEventListener("pointerdown", (event) => {
      if (element.dataset.mdMode === "source") {
        event.stopPropagation();
        return;
      }
      // A press on the body's own scrollbar should scroll, not move.
      if (
        event.target === body &&
        (event.offsetX > body.clientWidth || event.offsetY > body.clientHeight)
      ) {
        event.stopPropagation();
        return;
      }
      // Drag moves the note; a plain click does nothing (no select).
      startMarkdownMove(event, noteId);
    });
    // Wheeling inside the body scrolls the document, not the canvas.
    body.addEventListener("wheel", (event) => event.stopPropagation());
    body.addEventListener("input", () => {
      if (!body.isContentEditable) {
        return;
      }
      const currentNote = findNote(noteId);
      if (currentNote) {
        currentNote.text = getNoteText(body);
        saveNotesSoon();
      }
    });

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "md-resize-handle";
    resizeHandle.title = "Drag to resize";
    resizeHandle.addEventListener("pointerdown", (event) => {
      startMarkdownResize(event, noteId);
    });

    element.append(tabs, body, resizeHandle);
    setMarkdownMode(element, "preview");
    return element;
  }

  function createNoteElement(note) {
    if (note.type === "image") {
      return createImageElement(note);
    }
    if (note.type === "markdown") {
      return createMarkdownElement(note);
    }

    const noteId = note.id;
    const element = document.createElement("div");
    element.className = "board-item note";
    element.contentEditable = "plaintext-only";
    element.spellcheck = false;
    element.dataset.id = noteId;
    element.dataset.type = "text";
    element.style.left = `${note.x}px`;
    element.style.top = `${note.y}px`;
    element.textContent = note.text || "";

    element.addEventListener("pointerdown", (event) => {
      handleBoardItemPointerDown(event, noteId);
    });

    element.addEventListener("click", (event) => {
      handleSpellClick(event, element);
    });

    element.addEventListener("input", () => {
      const currentNote = findNote(noteId);
      if (!currentNote) {
        return;
      }
      dirtyNoteIds.add(noteId);
      currentNote.text = getNoteText(element);
      recordTextAddUndo(noteId, currentNote.text);
      if (!findBar.hidden) {
        refreshFindMatches();
      }
      hideSpellingBubble();
      refreshSpellHighlightsSoon();
      saveNotesSoon();
    });

    element.addEventListener("blur", () => {
      const currentNote = findNote(noteId);
      if (!currentNote) {
        return;
      }
      currentNote.text = getNoteText(element);
      if (!currentNote.text.trim()) {
        removeUndoAddReferences([noteId]);
        removeNote(noteId);
      } else {
        refreshSpellHighlightsSoon();
        saveNotesSoon();
      }
    });

    element.addEventListener("keydown", (event) => {
      if (handleTextWallNavigation(event, element)) {
        return;
      }
      if (event.key === "Escape") {
        hideSpellingBubble();
        element.blur();
        window.getSelection()?.removeAllRanges();
      }
    });

    return element;
  }

  function createImageElement(note) {
    const noteId = note.id;
    const element = document.createElement("figure");
    element.className = "board-item image-note";
    element.dataset.id = noteId;
    element.dataset.type = "image";
    element.style.left = `${note.x}px`;
    element.style.top = `${note.y}px`;

    const cropFrame = document.createElement("div");
    cropFrame.className = "image-crop-frame";
    const image = document.createElement("img");
    image.alt = "Pasted image";
    image.draggable = false;
    cropFrame.appendChild(image);
    element.appendChild(cropFrame);

    const controls = document.createElement("div");
    controls.className = "image-controls";
    controls.setAttribute("aria-hidden", "true");

    const rotateHandle = document.createElement("button");
    rotateHandle.type = "button";
    rotateHandle.className = "image-control image-rotate-control";
    rotateHandle.title = "Drag to rotate";
    rotateHandle.textContent = "⟳"; // curved rotation arrow
    rotateHandle.setAttribute("aria-label", "Rotate image");
    rotateHandle.addEventListener("pointerdown", (event) => {
      startImageTransform(event, noteId, "rotate");
    });

    const mirrorHorizontalButton = document.createElement("button");
    mirrorHorizontalButton.type = "button";
    mirrorHorizontalButton.className = "image-control image-mirror-control image-mirror-horizontal-control";
    mirrorHorizontalButton.title = "Mirror horizontally";
    mirrorHorizontalButton.textContent = "H";
    mirrorHorizontalButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    mirrorHorizontalButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      mirrorSelectedImages("x");
    });

    const mirrorVerticalButton = document.createElement("button");
    mirrorVerticalButton.type = "button";
    mirrorVerticalButton.className = "image-control image-mirror-control image-mirror-vertical-control";
    mirrorVerticalButton.title = "Mirror vertically";
    mirrorVerticalButton.textContent = "V";
    mirrorVerticalButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    mirrorVerticalButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      mirrorSelectedImages("y");
    });

    const resizeHandle = document.createElement("button");
    resizeHandle.type = "button";
    resizeHandle.className = "image-control image-resize-control";
    resizeHandle.title = "Drag to resize";
    resizeHandle.addEventListener("pointerdown", (event) => {
      startImageTransform(event, noteId, "resize");
    });

    const cropButton = document.createElement("button");
    cropButton.type = "button";
    cropButton.className = "image-control image-crop-control";
    cropButton.title = "Crop";
    cropButton.textContent = "⛶";
    cropButton.setAttribute("aria-label", "Crop image");
    cropButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    cropButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCropMode(noteId);
    });

    controls.appendChild(rotateHandle);
    controls.appendChild(mirrorHorizontalButton);
    controls.appendChild(mirrorVerticalButton);
    controls.appendChild(cropButton);
    controls.appendChild(resizeHandle);
    element.appendChild(controls);

    const cropEditor = document.createElement("div");
    cropEditor.className = "image-crop-editor";
    cropEditor.setAttribute("aria-hidden", "true");
    const cropRubber = document.createElement("div");
    cropRubber.className = "crop-rubber";
    cropRubber.hidden = true;
    cropEditor.appendChild(cropRubber);
    cropEditor.addEventListener("pointerdown", (event) => {
      startCropRubber(event, noteId);
    });
    element.appendChild(cropEditor);

    applyImageGeometry(element, note);
    loadImageIntoElement(note, image);

    element.addEventListener("pointerdown", (event) => {
      handleBoardItemPointerDown(event, noteId);
    });

    return element;
  }

  function updateImageElement(element, note) {
    applyImageGeometry(element, note);

    const image = element.querySelector("img");
    if (!image) {
      return;
    }

    if (image.dataset.imageId !== note.imageId) {
      loadImageIntoElement(note, image);
    }
  }

  function applyImageGeometry(element, note) {
    const width = note.width || 320;
    const height = note.height || 180;
    const rotation = normalizeRotation(note.rotation);
    const crop = cleanCrop(note.crop);
    const image = element.querySelector("img");

    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.style.transform = `rotate(${rotation}deg)`;
    element.dataset.rotation = String(rotation);

    if (!image) {
      return;
    }

    image.style.transform = `${note.flipX ? "scaleX(-1)" : "scaleX(1)"} ${
      note.flipY ? "scaleY(-1)" : "scaleY(1)"
    }`;

    if (!isCropped(crop)) {
      image.style.position = "";
      image.style.left = "";
      image.style.top = "";
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.objectFit = "";
      return;
    }

    // Cropped: scale the image up and offset it inside the clipped frame so
    // only the crop region shows.
    const fullWidth = width / crop.w;
    const fullHeight = height / crop.h;
    const fracX = note.flipX ? 1 - crop.x - crop.w : crop.x;
    const fracY = note.flipY ? 1 - crop.y - crop.h : crop.y;
    image.style.position = "absolute";
    image.style.left = `${-fracX * fullWidth}px`;
    image.style.top = `${-fracY * fullHeight}px`;
    image.style.width = `${fullWidth}px`;
    image.style.height = `${fullHeight}px`;
    image.style.objectFit = "fill";
  }

  function setSelectedNotes(ids) {
    selectedNoteIds = new Set(ids);
    updateSelectedNoteStyles();
  }

  function clearSelectedNotes() {
    if (!selectedNoteIds.size) {
      return;
    }
    selectedNoteIds.clear();
    updateSelectedNoteStyles();
  }

  function pruneSelectedNotes() {
    const noteIds = new Set(notes.map((note) => note.id));
    selectedNoteIds = new Set([...selectedNoteIds].filter((id) => noteIds.has(id)));
  }

  function updateSelectedNoteStyles() {
    for (const element of paper.querySelectorAll(".board-item")) {
      element.classList.toggle("is-selected", selectedNoteIds.has(element.dataset.id));
    }
  }

  function findNote(id) {
    return notes.find((note) => note.id === id);
  }

  function getActiveTextNoteElement() {
    return document.activeElement?.classList.contains("note") ? document.activeElement : null;
  }

  function showPasteStatus(message, isError = false) {
    let status = document.getElementById("paste-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "paste-status";
      status.className = "paste-status";
      document.body.appendChild(status);
    }

    status.textContent = message;
    status.classList.toggle("is-error", isError);
    status.hidden = false;
    window.clearTimeout(pasteStatusTimer);
    pasteStatusTimer = window.setTimeout(() => {
      status.hidden = true;
    }, 1800);
  }

  function isSpellWordCharacter(character) {
    return /[\p{L}']/u.test(character || "");
  }

  function getWordRangeFromPoint(clientX, clientY, element) {
    let caretRange = null;
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(clientX, clientY);
      if (position) {
        caretRange = document.createRange();
        caretRange.setStart(position.offsetNode, position.offset);
        caretRange.collapse(true);
      }
    } else if (document.caretRangeFromPoint) {
      caretRange = document.caretRangeFromPoint(clientX, clientY);
    }

    if (!caretRange || !element.contains(caretRange.startContainer)) {
      return null;
    }

    let node = caretRange.startContainer;
    let offset = caretRange.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      node = node.childNodes[offset] || node.childNodes[offset - 1];
      offset = node?.nodeValue?.length || 0;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !element.contains(node)) {
      return null;
    }

    const text = node.nodeValue || "";
    let index = Math.min(offset, text.length - 1);
    if (!isSpellWordCharacter(text[index]) && offset > 0) {
      index = offset - 1;
    }
    if (!isSpellWordCharacter(text[index])) {
      return null;
    }

    let start = index;
    let end = index + 1;
    while (start > 0 && isSpellWordCharacter(text[start - 1])) start -= 1;
    while (end < text.length && isSpellWordCharacter(text[end])) end += 1;

    const word = text.slice(start, end).replace(/^'+|'+$/g, "");
    if (!word) {
      return null;
    }

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return { word, range, element, node, start, end };
  }

  function collectMisspelledRanges() {
    const ranges = [];
    for (const element of paper.querySelectorAll(".note")) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.nodeValue || "";
        const matches = text.matchAll(/[\p{L}'][\p{L}']*/gu);
        for (const match of matches) {
          const word = match[0].replace(/^'+|'+$/g, "");
          if (!word || spellService.isCorrect(word)) {
            continue;
          }
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          ranges.push(range);
        }
      }
    }
    return ranges;
  }

  function refreshSpellHighlights() {
    if (!CSS.highlights || !window.Highlight) {
      return;
    }
    CSS.highlights.delete("app-spell-error");
    if (!redlinesEnabled) {
      return;
    }
    const ranges = collectMisspelledRanges();
    if (ranges.length) {
      CSS.highlights.set("app-spell-error", new Highlight(...ranges));
    }
  }

  function refreshSpellHighlightsSoon() {
    window.clearTimeout(spellHighlightTimer);
    spellHighlightTimer = window.setTimeout(refreshSpellHighlights, 80);
  }

  function getSpellingBubble() {
    if (spellingBubble) {
      return spellingBubble;
    }
    spellingBubble = document.createElement("div");
    spellingBubble.className = "spelling-bubble";
    spellingBubble.hidden = true;
    spellingBubble.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    document.body.appendChild(spellingBubble);
    return spellingBubble;
  }

  function hideSpellingBubble() {
    activeSpelling = null;
    if (spellingBubble) {
      spellingBubble.hidden = true;
    }
  }

  function positionSpellingBubble(range, event) {
    const bubble = getSpellingBubble();
    const rect = range.getBoundingClientRect();
    const left = rect.left || event.clientX;
    const top = rect.top || event.clientY;
    window.requestAnimationFrame(() => {
      const bubbleWidth = bubble.offsetWidth || 260;
      const bubbleHeight = bubble.offsetHeight || 44;
      const maxLeft = Math.max(8, window.innerWidth - bubbleWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - bubbleHeight - 8);
      bubble.style.left = `${clamp(left, 8, maxLeft)}px`;
      bubble.style.top = `${clamp(top - bubbleHeight - 8, 8, maxTop)}px`;
    });
  }

  function replaceActiveSpellingWord(value) {
    if (!activeSpelling) {
      return;
    }
    const replacement = value;
    const { element, node, start, end } = activeSpelling;
    if (!node?.isConnected || !element.contains(node)) {
      hideSpellingBubble();
      refreshSpellHighlightsSoon();
      return;
    }

    const textLength = node.nodeValue ? node.nodeValue.length : 0;
    if (start > textLength) {
      hideSpellingBubble();
      refreshSpellHighlightsSoon();
      return;
    }

    const currentNote = findNote(element.dataset.id);
    if (!currentNote) {
      hideSpellingBubble();
      refreshSpellHighlightsSoon();
      return;
    }

    currentNote.text = getNoteText(element);
    const beforeItem = { note: cloneNote(currentNote) };
    const safeEnd = Math.min(end, textLength);
    node.nodeValue = `${node.nodeValue.slice(0, start)}${replacement}${node.nodeValue.slice(safeEnd)}`;

    element.focus({ preventScroll: true });
    const caret = document.createRange();
    caret.setStart(node, start + replacement.length);
    caret.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);

    currentNote.text = getNoteText(element);
    if (beforeItem.note.text !== currentNote.text) {
      dirtyNoteIds.add(currentNote.id);
      pushUndoAction({ type: "spell-replace", items: [beforeItem] });
      saveNotesSoon();
    }
    hideSpellingBubble();
    refreshSpellHighlightsSoon();
  }

  function showSpellingBubble(match, event) {
    const bubble = getSpellingBubble();
    const suggestions = spellService.suggestions(match.word);
    activeSpelling = match;
    bubble.innerHTML = "";

    suggestions.forEach((suggestion, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = index === 0 ? "spelling-primary" : "";
      button.textContent = suggestion;
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => replaceActiveSpellingWord(suggestion));
      bubble.appendChild(button);
    });

    if (!suggestions.length) {
      const empty = document.createElement("span");
      empty.className = "spelling-empty";
      empty.textContent = "No suggestions";
      bubble.appendChild(empty);
    }

    const ignoreButton = document.createElement("button");
    ignoreButton.type = "button";
    ignoreButton.textContent = "Ignore";
    ignoreButton.addEventListener("click", () => {
      const word = spellService.ignore(match.word);
      if (word) {
        pushUndoAction({ type: "spell-ignore", word });
      }
      hideSpellingBubble();
      refreshSpellHighlightsSoon();
    });
    bubble.appendChild(ignoreButton);

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.textContent = "Add";
    addButton.addEventListener("click", () => {
      const word = spellService.add(match.word);
      if (word) {
        pushUndoAction({ type: "spell-add", word });
      }
      hideSpellingBubble();
      refreshSpellHighlightsSoon();
    });
    bubble.appendChild(addButton);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "spelling-close";
    closeButton.textContent = "x";
    closeButton.addEventListener("click", hideSpellingBubble);
    bubble.appendChild(closeButton);

    bubble.hidden = false;
    positionSpellingBubble(match.range, event);
  }

  function handleSpellClick(event, element) {
    if (!redlinesEnabled) {
      hideSpellingBubble();
      return;
    }

    if (
      event.button !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      selectedNoteIds.has(element.dataset.id)
    ) {
      return;
    }
    const match = getWordRangeFromPoint(event.clientX, event.clientY, element);
    if (!match || spellService.isCorrect(match.word)) {
      hideSpellingBubble();
      return;
    }
    showSpellingBubble(match, event);
  }

  function hasSelectionOutsideActiveNote(activeNote) {
    if (!selectedNoteIds.size) {
      return false;
    }

    if (!activeNote) {
      return true;
    }

    return [...selectedNoteIds].some((id) => id !== activeNote.dataset.id);
  }

  function shouldUseBoardShortcut(activeNote) {
    return !activeNote || !getNoteText(activeNote) || hasSelectionOutsideActiveNote(activeNote);
  }

  function removeActiveEmptyTextNote(activeNote) {
    if (!activeNote || getNoteText(activeNote).trim()) {
      return;
    }

    removeUndoAddReferences([activeNote.dataset.id]);
    removeNote(activeNote.dataset.id);
  }

  function trimActionStack(stack) {
    return stack;
  }

  function pushUndoAction(action, options = {}) {
    undoStack.push(action);
    trimActionStack(undoStack);
    if (options.clearRedo !== false) {
      redoStack = [];
    }
    syncBoardOverlayUndoRedoControls();
  }

  function pushRedoAction(action) {
    redoStack.push(action);
    trimActionStack(redoStack);
    syncBoardOverlayUndoRedoControls();
  }

  function removeIdsFromAddActions(stack, idSet) {
    return stack
      .map((action) => {
        if (action.type !== "add") {
          return action;
        }

        return {
          ...action,
          ids: (action.ids || []).filter((id) => !idSet.has(id)),
          items: (action.items || []).filter((item) => !idSet.has(item?.note?.id)),
        };
      })
      .filter((action) => action.type !== "add" || (action.ids || []).length || (action.items || []).length);
  }

  function removeUndoAddReferences(ids) {
    const idSet = new Set(ids);
    undoStack = removeIdsFromAddActions(undoStack, idSet);
    redoStack = removeIdsFromAddActions(redoStack, idSet);
    syncBoardOverlayUndoRedoControls();

    for (const id of idSet) {
      textAddUndoIds.delete(id);
    }
  }

  function recordTextAddUndo(id, text) {
    if (!text.trim() || textAddUndoIds.has(id)) {
      return;
    }

    textAddUndoIds.add(id);
    pushUndoAction({ type: "add", ids: [id] });
  }

  async function captureUndoItems(ids) {
    const items = [];
    for (const id of ids) {
      const note = findNote(id);
      if (!note) {
        continue;
      }

      const element = paper.querySelector(`[data-id="${CSS.escape(id)}"]`);
      const item = {
        note: cloneNote(note),
        blob: null,
        width: element?.offsetWidth || note.width || 0,
        height: element?.offsetHeight || note.height || 0,
      };
      if (note.type === "image" && note.imageId) {
        item.blob = await getImageBlob(note.imageId).catch(() => null);
      }
      items.push(item);
    }
    return items;
  }

  function captureNoteSnapshots(ids) {
    return ids
      .map((id) => findNote(id))
      .filter(Boolean)
      .map((note) => ({ note: cloneNote(note) }));
  }

  function restoreNoteSnapshots(items) {
    const restoredIds = [];
    for (const item of items) {
      if (!item?.note) {
        continue;
      }

      const index = notes.findIndex((note) => note.id === item.note.id);
      if (index === -1) {
        continue;
      }

      notes[index] = cloneNote(item.note);
      restoredIds.push(item.note.id);
    }

    if (!restoredIds.length) {
      return;
    }

    renderSyncedNotes();
    setSelectedNotes(restoredIds);
    saveNotesNow();
  }

  function getClipboardBounds(items) {
    const left = Math.min(...items.map((item) => item.note.x));
    const top = Math.min(...items.map((item) => item.note.y));
    const right = Math.max(...items.map((item) => item.note.x + item.width));
    const bottom = Math.max(...items.map((item) => item.note.y + item.height));

    return {
      left,
      top,
      right,
      bottom,
    };
  }

  async function writeSystemClipboard(items) {
    if (!navigator.clipboard) {
      return;
    }

    const imageItems = items.filter((item) => item.note.type === "image" && item.blob);
    if (items.length === 1 && imageItems.length === 1 && window.ClipboardItem) {
      const item = imageItems[0];
      const mimeType = item.blob.type || item.note.mimeType || "image/png";
      await navigator.clipboard.write([new ClipboardItem({ [mimeType]: item.blob })]);
      return;
    }

    const text = items
      .filter((item) => isTextNote(item.note) && item.note.text)
      .map((item) => item.note.text)
      .join("\n\n");
    if (text) {
      await navigator.clipboard.writeText(text);
    }
  }

  async function copySelectedNotes() {
    if (!selectedNoteIds.size) {
      return false;
    }

    syncNotesFromDom();
    const orderedIds = notes
      .filter((note) => selectedNoteIds.has(note.id))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((note) => note.id);
    const items = await captureUndoItems(orderedIds);
    if (!items.length) {
      return false;
    }

    boardClipboard = {
      items,
      bounds: getClipboardBounds(items),
      pasteCount: 0,
    };
    writeSystemClipboard(items).catch(() => {});
    return true;
  }

  function getNoteText(element) {
    return element.innerText.replace(/\n$/, "");
  }

  function syncNotesFromDom() {
    for (const note of notes) {
      if (isTextNote(note)) {
        const element = paper.querySelector(
          `.note[data-id="${CSS.escape(note.id)}"]`
        );
        if (element) {
          note.text = getNoteText(element);
        }
      } else if (note.type === "markdown") {
        const body = paper.querySelector(
          `.markdown-note[data-id="${CSS.escape(note.id)}"] .md-body`
        );
        if (body && body.isContentEditable) {
          note.text = getNoteText(body);
        }
      }
    }
  }

  function renderNotes() {
    for (const element of paper.querySelectorAll(".image-note")) {
      releaseImageElement(element);
    }
    paper.replaceChildren();
    for (const note of notes) {
      paper.appendChild(createNoteElement(note));
    }
    updateSelectedNoteStyles();
    refreshSpellHighlightsSoon();
  }

  function renderSyncedNotes() {
    // Any focused note is protected — its DOM text is never reset under it.
    const protectedElement = document.activeElement?.classList.contains("note")
      ? document.activeElement
      : null;
    const noteIds = new Set(notes.map((note) => note.id));

    for (const element of Array.from(paper.querySelectorAll(".board-item"))) {
      if (!noteIds.has(element.dataset.id) && element !== protectedElement) {
        releaseImageElement(element);
        element.remove();
      }
    }

    for (const note of notes) {
      let element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
      if (element && element.dataset.type !== (note.type || "text")) {
        releaseImageElement(element);
        element.remove();
        element = null;
      }
      if (!element) {
        element = createNoteElement(note);
        paper.appendChild(element);
      }

      element.style.left = `${note.x}px`;
      element.style.top = `${note.y}px`;

      if (isTextNote(note) && element !== protectedElement && getNoteText(element) !== (note.text || "")) {
        element.textContent = note.text || "";
      }
      if (note.type === "image") {
        updateImageElement(element, note);
      }
      if (note.type === "markdown") {
        const body = element.querySelector(".md-body");
        if (body && !body.isContentEditable) {
          body.innerHTML = window.renderInfinitePaperMarkdown(note.text || "");
        }
      }
    }

    pruneSelectedNotes();
    updateSelectedNoteStyles();
    refreshSpellHighlightsSoon();
  }

  function applyIncomingBoard(state) {
    if (!state || state.origin === clientId || !Array.isArray(state.notes)) {
      return;
    }
    if (isEditingANote()) {
      return; // never disturb a note the user is typing into
    }

    if (state.boardId && state.boardId !== currentBoardId) {
      return;
    }

    const incomingRevision = Number(state.revision) || 0;
    if (incomingRevision <= boardRevision) {
      return;
    }

    boardRevision = incomingRevision;
    notes = normalizeNotes(state.notes);
    pruneSelectedNotes();
    renderSyncedNotes();

    if (!findBar.hidden) {
      refreshFindMatches();
    }
  }

  function focusAtEnd(element) {
    element.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function focusAtStart(element) {
    element.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function getKeyboardDirection(event) {
    const directions = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    return directions[event.key] || null;
  }

  function getIntervalDistance(value, start, end) {
    if (value < start) {
      return start - value;
    }
    if (value > end) {
      return value - end;
    }
    return 0;
  }

  function getDirectionalScore(currentRect, candidateRect, direction) {
    const currentCenterX = currentRect.left + currentRect.width / 2;
    const currentCenterY = currentRect.top + currentRect.height / 2;
    const candidateCenterX = candidateRect.left + candidateRect.width / 2;
    const candidateCenterY = candidateRect.top + candidateRect.height / 2;

    if (direction === "left" && candidateCenterX < currentCenterX) {
      return currentCenterX - candidateCenterX + getIntervalDistance(candidateCenterY, currentRect.top, currentRect.bottom) * 2;
    }
    if (direction === "right" && candidateCenterX > currentCenterX) {
      return candidateCenterX - currentCenterX + getIntervalDistance(candidateCenterY, currentRect.top, currentRect.bottom) * 2;
    }
    if (direction === "up" && candidateCenterY < currentCenterY) {
      return currentCenterY - candidateCenterY + getIntervalDistance(candidateCenterX, currentRect.left, currentRect.right) * 2;
    }
    if (direction === "down" && candidateCenterY > currentCenterY) {
      return candidateCenterY - currentCenterY + getIntervalDistance(candidateCenterX, currentRect.left, currentRect.right) * 2;
    }

    return Infinity;
  }

  function findTextWallInDirection(activeElement, direction) {
    const currentRect = activeElement.getBoundingClientRect();
    let bestElement = null;
    let bestScore = Infinity;

    for (const element of paper.querySelectorAll(".note")) {
      if (element === activeElement || !getNoteText(element).trim()) {
        continue;
      }

      const score = getDirectionalScore(currentRect, element.getBoundingClientRect(), direction);
      if (score < bestScore) {
        bestScore = score;
        bestElement = element;
      }
    }

    return bestElement;
  }

  function focusTextWallForDirection(element, direction) {
    setSelectedNotes([element.dataset.id]);
    if (direction === "right" || direction === "down") {
      focusAtStart(element);
    } else {
      focusAtEnd(element);
    }
  }

  function handleTextWallNavigation(event, activeElement) {
    const direction = getKeyboardDirection(event);
    if (!direction || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return false;
    }

    const targetElement = findTextWallInDirection(activeElement, direction);
    if (!targetElement) {
      return false;
    }

    const currentNote = findNote(activeElement.dataset.id);
    if (currentNote) {
      currentNote.text = getNoteText(activeElement);
      recordTextAddUndo(currentNote.id, currentNote.text);
    }

    event.preventDefault();
    event.stopPropagation();
    removeActiveEmptyTextNote(activeElement);
    focusTextWallForDirection(targetElement, direction);
    saveNotesSoon();
    return true;
  }

  function addNoteAt(clientX, clientY) {
    const point = viewportToWorld(clientX, clientY);
    lastPasteTargetPoint = {
      x: Math.round(point.x),
      y: Math.round(point.y),
    };
    const note = {
      id: makeId(),
      type: "text",
      x: lastPasteTargetPoint.x,
      y: lastPasteTargetPoint.y,
      text: "",
    };
    notes.push(note);
    const element = createNoteElement(note);
    paper.appendChild(element);
    focusAtEnd(element);
    refreshSpellHighlightsSoon();
    saveNotesSoon();
  }

  function removeNotes(ids, options = {}) {
    const idSet = new Set(ids);
    const shouldDeleteImages = options.deleteImages !== false;
    const shouldSave = options.save !== false;
    const removedNotes = [];

    notes = notes.filter((note) => {
      if (!idSet.has(note.id)) {
        return true;
      }
      removedNotes.push(note);
      return false;
    });

    for (const removedNote of removedNotes) {
      selectedNoteIds.delete(removedNote.id);
      textAddUndoIds.delete(removedNote.id);
      const element = paper.querySelector(`[data-id="${CSS.escape(removedNote.id)}"]`);
      if (element) {
        releaseImageElement(element);
        element.remove();
      }
      if (shouldDeleteImages && removedNote.type === "image") {
        deleteImageBlob(removedNote.imageId).catch(() => {});
      }
    }

    updateSelectedNoteStyles();
    if (removedNotes.length) {
      hideSpellingBubble();
      refreshSpellHighlightsSoon();
    }
    if (shouldSave) {
      saveNotesSoon();
    }
    return removedNotes;
  }

  function removeNote(id) {
    removeNotes([id]);
  }

  function openFind() {
    hideSpellingBubble();
    syncNotesFromDom();
    const selectedText = window.getSelection()?.toString().trim();
    findBar.hidden = false;
    if (selectedText) {
      findInput.value = selectedText;
    }
    refreshFindMatches();
    findInput.focus({ preventScroll: true });
    findInput.select();
  }

  function closeFind() {
    findBar.hidden = true;
    clearFindHighlight();
    findState = {
      query: "",
      matches: [],
      activeIndex: -1,
      hasJumped: false,
    };
    viewport.focus?.();
  }

  function refreshFindMatches() {
    syncNotesFromDom();
    findState.query = findInput.value;
    findState.matches = collectFindMatches(findState.query);
    findState.activeIndex = findState.matches.length ? 0 : -1;
    findState.hasJumped = false;
    updateFindCount();
    clearFindHighlight();
  }

  function collectFindMatches(query) {
    const needle = query.toLocaleLowerCase();
    if (!needle) {
      return [];
    }

    const matches = [];
    for (const note of notes) {
      if (!isTextNote(note)) {
        continue;
      }
      const haystack = (note.text || "").toLocaleLowerCase();
      let start = haystack.indexOf(needle);
      while (start !== -1) {
        matches.push({
          note,
          start,
          end: start + query.length,
        });
        start = haystack.indexOf(needle, start + Math.max(query.length, 1));
      }
    }

    return matches.sort((a, b) => {
      if (a.note.y !== b.note.y) {
        return a.note.y - b.note.y;
      }
      if (a.note.x !== b.note.x) {
        return a.note.x - b.note.x;
      }
      return a.start - b.start;
    });
  }

  function updateFindCount() {
    const total = findState.matches.length;
    findCount.textContent = total ? `${findState.activeIndex + 1}/${total}` : "0/0";
    findBar.classList.toggle("is-empty", !total);
  }

  function jumpFind(direction) {
    if (findBar.hidden) {
      openFind();
      return;
    }

    if (findInput.value !== findState.query) {
      refreshFindMatches();
    }

    if (!findState.matches.length) {
      updateFindCount();
      return;
    }

    if (findState.hasJumped) {
      findState.activeIndex =
        (findState.activeIndex + direction + findState.matches.length) % findState.matches.length;
    }
    findState.hasJumped = true;
    updateFindCount();
    focusFindMatch(findState.matches[findState.activeIndex]);
  }

  function focusFindMatch(match) {
    const element = paper.querySelector(`[data-id="${CSS.escape(match.note.id)}"]`);
    if (!element) {
      return;
    }

    const range = makeTextRange(element, match.start, match.end);
    if (!range) {
      return;
    }

    showFindHighlight(range);
    centerRange(range);
    findInput.focus({ preventScroll: true });
  }

  function makeTextRange(element, start, end) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let current = 0;
    let hasStart = false;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const next = current + node.nodeValue.length;

      if (!hasStart && start <= next) {
        range.setStart(node, Math.max(0, start - current));
        hasStart = true;
      }

      if (hasStart && end <= next) {
        range.setEnd(node, Math.max(0, end - current));
        return range;
      }

      current = next;
    }

    return null;
  }

  function showFindHighlight(range) {
    clearFindHighlight();
    if (CSS.highlights && window.Highlight) {
      CSS.highlights.set("find-active", new Highlight(range));
      return;
    }

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clearFindHighlight() {
    if (CSS.highlights) {
      CSS.highlights.delete("find-active");
    }
    if (document.activeElement !== findInput) {
      window.getSelection()?.removeAllRanges();
    }
  }

  function centerRange(range) {
    const matchRect = range.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const matchX = matchRect.left + matchRect.width / 2;
    const matchY = matchRect.top + matchRect.height / 2;
    const centerX = viewportRect.left + viewportRect.width / 2;
    const centerY = viewportRect.top + viewportRect.height / 2;

    view.x += centerX - matchX;
    view.y += centerY - matchY;
    applyView();
    saveViewSoon();
  }

  function getDragDistance(event) {
    return Math.hypot(event.clientX - activeDrag.startX, event.clientY - activeDrag.startY);
  }

  function getSelectionRect(clientX, clientY) {
    const left = Math.min(activeDrag.startX, clientX);
    const top = Math.min(activeDrag.startY, clientY);
    const right = Math.max(activeDrag.startX, clientX);
    const bottom = Math.max(activeDrag.startY, clientY);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  function showSelectionBox(rect) {
    selectionBox.hidden = false;
    selectionBox.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    selectionBox.style.width = `${rect.width}px`;
    selectionBox.style.height = `${rect.height}px`;
  }

  function hideSelectionBox() {
    selectionBox.hidden = true;
    selectionBox.style.width = "0";
    selectionBox.style.height = "0";
  }

  function noteIntersectsRect(element, rect) {
    const noteRect = element.getBoundingClientRect();
    return !(
      noteRect.right < rect.left ||
      noteRect.left > rect.right ||
      noteRect.bottom < rect.top ||
      noteRect.top > rect.bottom
    );
  }

  function getNoteIdsInRect(rect) {
    const ids = [];
    for (const element of paper.querySelectorAll(".board-item")) {
      if (noteIntersectsRect(element, rect)) {
        ids.push(element.dataset.id);
      }
    }
    return ids;
  }

  function startSelectionDrag(event, anchorNoteId = null) {
    window.getSelection()?.removeAllRanges();
    activeDrag = {
      type: "select",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      anchorNoteId,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-selecting");
  }

  function moveSelectionDrag(event) {
    if (getDragDistance(event) > panThreshold) {
      activeDrag.moved = true;
    }

    const rect = getSelectionRect(event.clientX, event.clientY);
    showSelectionBox(rect);
    setSelectedNotes(getNoteIdsInRect(rect));
  }

  function endSelectionDrag(event) {
    if (activeDrag.moved) {
      setSelectedNotes(getNoteIdsInRect(getSelectionRect(event.clientX, event.clientY)));
    } else if (activeDrag.anchorNoteId) {
      setSelectedNotes([activeDrag.anchorNoteId]);
    } else {
      clearSelectedNotes();
    }

    hideSelectionBox();
    viewport.classList.remove("is-selecting");
  }

  function startMoveSelection(event) {
    syncNotesFromDom();
    activeDrag = {
      type: "move-selection",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      startNotes: notes
        .filter((note) => selectedNoteIds.has(note.id))
        .map((note) => {
          const element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
          return {
            id: note.id,
            x: note.x,
            y: note.y,
            width: element?.offsetWidth || 0,
            height: element?.offsetHeight || 0,
          };
        }),
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-moving-selection");
  }

  function moveSelectedNotes(event) {
    let dx = (event.clientX - activeDrag.startX) / view.scale;
    let dy = (event.clientY - activeDrag.startY) / view.scale;
    const snapped = getEdgeSnapOffset(dx, dy);
    dx = snapped.dx;
    dy = snapped.dy;

    if (Math.hypot(dx, dy) > 0.5) {
      activeDrag.moved = true;
    }

    for (const startNote of activeDrag.startNotes) {
      const note = findNote(startNote.id);
      const element = paper.querySelector(`[data-id="${CSS.escape(startNote.id)}"]`);
      if (!note || !element) {
        continue;
      }

      note.x = Math.round(startNote.x + dx);
      note.y = Math.round(startNote.y + dy);
      element.style.left = `${note.x}px`;
      element.style.top = `${note.y}px`;
    }

    saveNotesSoon();
  }

  function getMovingGroupRect(dx, dy) {
    const left = Math.min(...activeDrag.startNotes.map((note) => note.x + dx));
    const top = Math.min(...activeDrag.startNotes.map((note) => note.y + dy));
    const right = Math.max(...activeDrag.startNotes.map((note) => note.x + note.width + dx));
    const bottom = Math.max(...activeDrag.startNotes.map((note) => note.y + note.height + dy));
    return {
      left,
      top,
      right,
      bottom,
      centerX: left + (right - left) / 2,
      centerY: top + (bottom - top) / 2,
    };
  }

  function getStationaryNoteRects() {
    return notes
      .filter((note) => !selectedNoteIds.has(note.id))
      .map((note) => {
        const element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
        return {
          left: note.x,
          top: note.y,
          right: note.x + (element?.offsetWidth || 0),
          bottom: note.y + (element?.offsetHeight || 0),
        };
      })
      .map((rect) => ({
        ...rect,
        centerX: rect.left + (rect.right - rect.left) / 2,
        centerY: rect.top + (rect.bottom - rect.top) / 2,
      }));
  }

  function getEdgeSnapOffset(dx, dy) {
    const movingRect = getMovingGroupRect(dx, dy);
    const movingX = [movingRect.left, movingRect.centerX, movingRect.right];
    const movingY = [movingRect.top, movingRect.centerY, movingRect.bottom];
    let snapX = 0;
    let snapY = 0;
    let bestX = snapDistance + 1;
    let bestY = snapDistance + 1;

    for (const rect of getStationaryNoteRects()) {
      for (const targetX of [rect.left, rect.centerX, rect.right]) {
        for (const sourceX of movingX) {
          const offset = targetX - sourceX;
          const distance = Math.abs(offset);
          if (distance < bestX && distance <= snapDistance) {
            bestX = distance;
            snapX = offset;
          }
        }
      }

      for (const targetY of [rect.top, rect.centerY, rect.bottom]) {
        for (const sourceY of movingY) {
          const offset = targetY - sourceY;
          const distance = Math.abs(offset);
          if (distance < bestY && distance <= snapDistance) {
            bestY = distance;
            snapY = offset;
          }
        }
      }
    }

    return {
      dx: dx + snapX,
      dy: dy + snapY,
    };
  }

  function normalizeClipboardImageBlob(blob, fallbackType = "") {
    if (!blob) {
      return null;
    }

    if (blob.type?.startsWith("image/")) {
      return blob;
    }

    if (fallbackType.startsWith("image/")) {
      return new Blob([blob], { type: fallbackType });
    }

    return null;
  }

  function addClipboardImage(images, seen, blob, fallbackType = "") {
    const imageBlob = normalizeClipboardImageBlob(blob, fallbackType);
    if (!imageBlob) {
      return;
    }

    const key = `${imageBlob.type}:${imageBlob.size}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    images.push(imageBlob);
  }

  function getDataTransferImages(dataTransfer) {
    if (!dataTransfer) {
      return [];
    }

    const images = [];
    const seen = new Set();

    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) {
        continue;
      }
      addClipboardImage(images, seen, item.getAsFile(), item.type);
    }

    for (const file of Array.from(dataTransfer.files || [])) {
      addClipboardImage(images, seen, file);
    }

    return images;
  }

  function getDataTransferText(dataTransfer, type) {
    try {
      return dataTransfer?.getData(type) || "";
    } catch {
      return "";
    }
  }

  function getDataTransferImageDataUrls(dataTransfer) {
    if (!dataTransfer) {
      return [];
    }

    const urls = [];
    const seen = new Set();
    const addUrl = (value) => {
      if (!value || !value.startsWith("data:image/") || seen.has(value)) {
        return;
      }
      seen.add(value);
      urls.push(value);
    };

    const html = getDataTransferText(dataTransfer, "text/html");
    if (html) {
      const documentFragment = document.implementation.createHTMLDocument("");
      documentFragment.body.innerHTML = html;
      for (const image of documentFragment.body.querySelectorAll("img")) {
        addUrl(image.getAttribute("src") || "");
      }
    }

    const text = getDataTransferText(dataTransfer, "text/plain").trim();
    addUrl(text);

    return urls;
  }

  function dataTransferHasReadableText(dataTransfer) {
    return Boolean(
      getDataTransferText(dataTransfer, "text/plain").trim() ||
        getDataTransferText(dataTransfer, "text/html").trim()
    );
  }

  async function getImageBlobsFromDataUrls(dataUrls) {
    const images = [];
    const seen = new Set();

    for (const dataUrl of dataUrls) {
      try {
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        addClipboardImage(images, seen, blob);
      } catch {
        // Some clipboard providers include broken HTML fragments. Ignore those.
      }
    }

    return images;
  }

  function getClipboardImages(event) {
    return getDataTransferImages(event.clipboardData);
  }

  async function readSystemClipboardImages() {
    if (!navigator.clipboard?.read) {
      return [];
    }

    const images = [];
    const seen = new Set();

    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) {
          continue;
        }

        addClipboardImage(images, seen, await item.getType(imageType), imageType);
      }
    } catch {
      return [];
    }

    return images;
  }

  async function readBridgeClipboardImages() {
    const images = [];
    const seen = new Set();

    try {
      const response = await fetch(`${clipboardBridgeImageUrl}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!response.ok || response.status === 204) {
        return [];
      }

      addClipboardImage(images, seen, await response.blob(), "image/png");
    } catch {
      return [];
    }

    return images;
  }

  async function readFallbackClipboardImages() {
    const bridgeImages = await readBridgeClipboardImages();
    if (bridgeImages.length) {
      return bridgeImages;
    }

    return readSystemClipboardImages();
  }

  function getImagePasteSignature(images) {
    return images.map((image) => `${image.type || "image"}:${image.size || 0}`).join("|");
  }

  function isRecentImagePaste(images) {
    const signature = getImagePasteSignature(images);
    return Boolean(
      signature &&
        signature === lastImagePasteSignature &&
        performance.now() - lastImagePasteAt < 400
    );
  }

  function rememberImagePaste(images) {
    lastImagePasteSignature = getImagePasteSignature(images);
    lastImagePasteAt = performance.now();
  }

  function getDisplaySize(width, height) {
    const naturalWidth = Math.max(1, width || pastedImageMaxWidth);
    const naturalHeight = Math.max(1, height || pastedImageMaxHeight);
    let scale = Math.min(1, pastedImageMaxWidth / naturalWidth, pastedImageMaxHeight / naturalHeight);
    let displayWidth = Math.round(naturalWidth * scale);
    let displayHeight = Math.round(naturalHeight * scale);
    const minimumScale = Math.max(80 / displayWidth, 60 / displayHeight, 1);

    if (minimumScale > 1) {
      scale *= minimumScale;
      displayWidth = Math.round(naturalWidth * scale);
      displayHeight = Math.round(naturalHeight * scale);
    }

    return {
      width: displayWidth,
      height: displayHeight,
    };
  }

  async function createImageNoteFromBlob(blob, point, index) {
    const imageId = makeId();
    await Promise.allSettled([
      saveImageBlob(imageId, blob), // per-browser cache + undo source
      uploadAttachment(imageId, blob), // portable server file
    ]);
    const naturalSize = await getImageDimensions(blob);
    const displaySize = getDisplaySize(naturalSize.width, naturalSize.height);
    const offset = index * 28;

    return {
      id: imageId,
      type: "image",
      imageId,
      mimeType: blob.type || "image/png",
      x: Math.round(point.x - displaySize.width / 2 + offset),
      y: Math.round(point.y - displaySize.height / 2 + offset),
      width: displaySize.width,
      height: displaySize.height,
      rotation: 0,
      flipX: false,
      flipY: false,
    };
  }

  function clipboardMatchesBoardClipboard(images) {
    const imageItems = boardClipboard?.items.filter((item) => item.note.type === "image" && item.blob) || [];
    if (images.length !== 1 || imageItems.length !== 1 || boardClipboard.items.length !== 1) {
      return false;
    }

    const clipboardImage = images[0];
    const boardImage = imageItems[0].blob;
    return clipboardImage.type === boardImage.type && clipboardImage.size === boardImage.size;
  }

  async function pasteBoardClipboard() {
    if (!boardClipboard?.items.length) {
      return;
    }

    syncNotesFromDom();

    const repeatOffset = boardClipboard.pasteCount * 28;
    const fallbackOffset = (boardClipboard.pasteCount + 1) * 28;
    const offsetX = lastPasteTargetPoint && boardClipboard.bounds
      ? lastPasteTargetPoint.x - boardClipboard.bounds.left + repeatOffset
      : fallbackOffset;
    const offsetY = lastPasteTargetPoint && boardClipboard.bounds
      ? lastPasteTargetPoint.y - boardClipboard.bounds.top + repeatOffset
      : fallbackOffset;
    const addedIds = [];

    for (const item of boardClipboard.items) {
      const note = cloneNote(item.note);
      note.x = Math.round(item.note.x + offsetX);
      note.y = Math.round(item.note.y + offsetY);

      if (note.type === "image") {
        if (!item.blob) {
          continue;
        }
        const imageId = makeId();
        note.id = imageId;
        note.imageId = imageId;
        await Promise.allSettled([
          saveImageBlob(imageId, item.blob),
          uploadAttachment(imageId, item.blob),
        ]);
      } else {
        note.id = makeId();
      }

      notes.push(note);
      paper.appendChild(createNoteElement(note));
      addedIds.push(note.id);
    }

    if (addedIds.length) {
      boardClipboard.pasteCount += 1;
      setSelectedNotes(addedIds);
      pushUndoAction({ type: "add", ids: addedIds });
      saveNotesNow();
    }
  }

  let imagePasteActive = false;

  async function pasteImageBlobs(images, activeTextNote) {
    if (!images.length) {
      return false;
    }

    // One Ctrl+V fires both a `paste` and a `beforeinput` event. Guard
    // against pasting the same image twice: imagePasteActive blocks a
    // second call while the first is still running, isRecentImagePaste
    // blocks one that arrives just after the first finishes.
    if (imagePasteActive || isRecentImagePaste(images)) {
      return true;
    }
    imagePasteActive = true;
    rememberImagePaste(images);

    syncNotesFromDom();
    if (shouldUseBoardShortcut(activeTextNote)) {
      removeActiveEmptyTextNote(activeTextNote);
    }

    const point = lastPasteTargetPoint || getViewportCenterWorld();
    const addedIds = [];

    for (let index = 0; index < images.length; index += 1) {
      try {
        const note = await createImageNoteFromBlob(images[index], point, index);
        notes.push(note);
        paper.appendChild(createNoteElement(note));
        addedIds.push(note.id);
      } catch (error) {
        console.warn("Image paste failed", error);
      }
    }

    if (addedIds.length) {
      setSelectedNotes(addedIds);
      pushUndoAction({ type: "add", ids: addedIds });
      saveNotesNow();
      showPasteStatus(`Pasted ${addedIds.length} image${addedIds.length === 1 ? "" : "s"}`);
    } else {
      showPasteStatus("Image paste failed", true);
    }

    imagePasteActive = false;
    return addedIds.length > 0;
  }

  let lastPasteEventAt = 0;

  async function handlePaste(event) {
    lastPasteEventAt = performance.now();
    if (findBar.contains(document.activeElement)) {
      return;
    }

    const activeTextNote = getActiveTextNoteElement();
    let images = getClipboardImages(event);
    const imageDataUrls = getDataTransferImageDataUrls(event.clipboardData);

    if (boardCopyPromise) {
      await boardCopyPromise;
    }

    if (!images.length) {
      images = await getImageBlobsFromDataUrls(imageDataUrls);
    }

    if (!images.length) {
      images = await readFallbackClipboardImages();
    }

    if (
      boardClipboard &&
      shouldUseBoardShortcut(activeTextNote) &&
      (!images.length || clipboardMatchesBoardClipboard(images))
    ) {
      event.preventDefault();
      removeActiveEmptyTextNote(activeTextNote);
      pasteBoardClipboard();
      return;
    }

    // The native paste event (or the fallback above) already gave us the
    // image. The PowerShell clipboard bridge stays as a fallback inside
    // readFallbackClipboardImages — re-fetching it here just to override a
    // working image added a round-trip to every paste.
    if (!images.length) {
      return;
    }

    event.preventDefault();
    await pasteImageBlobs(images, activeTextNote);
  }

  async function handleBeforeInput(event) {
    if (event.inputType !== "insertFromPaste" || findBar.contains(document.activeElement)) {
      return;
    }
    // A Ctrl+V fires both `paste` and `beforeinput`. handlePaste owns the
    // gesture (it also covers the slow clipboard fallbacks), so defer here
    // whenever a paste event has just fired.
    if (performance.now() - lastPasteEventAt < 1000) {
      return;
    }

    const images = getDataTransferImages(event.dataTransfer);
    if (!images.length) {
      return;
    }

    event.preventDefault();
    await pasteImageBlobs(images, getActiveTextNoteElement());
  }

  async function probeKeyboardImagePaste(activeTextNote) {
    const probeId = ++keyboardImagePasteProbe;
    const images = await readFallbackClipboardImages();
    // This probe is only a fallback for when no `paste` event fires. If a
    // paste event did fire for this Ctrl+V, handlePaste already handled it
    // — bail, or the image is pasted twice.
    if (
      probeId !== keyboardImagePasteProbe ||
      !images.length ||
      isRecentImagePaste(images) ||
      performance.now() - lastPasteEventAt < 2500
    ) {
      return;
    }

    if (boardClipboard && clipboardMatchesBoardClipboard(images)) {
      return;
    }

    await pasteImageBlobs(images, activeTextNote);
  }

  function getSelectedImageNotes() {
    return notes.filter((note) => selectedNoteIds.has(note.id) && note.type === "image");
  }

  function rotateSelectedImages(direction) {
    const imageNotes = getSelectedImageNotes();
    if (!imageNotes.length) {
      return false;
    }

    const snapshots = captureNoteSnapshots(imageNotes.map((note) => note.id));

    for (const note of imageNotes) {
      note.rotation = normalizeRotation((note.rotation || 0) + direction * 90);

      const element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
      if (element) {
        updateImageElement(element, note);
      }
    }

    pushUndoAction({ type: "update", items: snapshots });
    saveNotesNow();
    showPasteStatus(`Rotated ${imageNotes.length} image${imageNotes.length === 1 ? "" : "s"}`);
    return true;
  }

  function mirrorSelectedImages(axis) {
    const imageNotes = getSelectedImageNotes();
    if (!imageNotes.length) {
      return false;
    }

    const snapshots = captureNoteSnapshots(imageNotes.map((note) => note.id));

    for (const note of imageNotes) {
      if (axis === "y") {
        note.flipY = !note.flipY;
      } else {
        note.flipX = !note.flipX;
      }

      const element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
      if (element) {
        updateImageElement(element, note);
      }
    }

    pushUndoAction({ type: "update", items: snapshots });
    saveNotesNow();
    const direction = axis === "y" ? "vertically" : "horizontally";
    showPasteStatus(`Mirrored ${imageNotes.length} image${imageNotes.length === 1 ? "" : "s"} ${direction}`);
    return true;
  }

  function getPointerAngle(clientX, clientY, center) {
    return Math.atan2(clientY - center.y, clientX - center.x) * (180 / Math.PI);
  }

  function startImageTransform(event, noteId, transformType) {
    const note = findNote(noteId);
    if (!note || note.type !== "image") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    syncNotesFromDom();
    setSelectedNotes([noteId]);

    const centerWorld = {
      x: note.x + (note.width || 320) / 2,
      y: note.y + (note.height || 180) / 2,
    };
    const centerClient = worldToViewport(centerWorld.x, centerWorld.y);

    activeDrag = {
      type: transformType === "rotate" ? "image-rotate" : "image-resize",
      pointerId: event.pointerId,
      noteId,
      snapshots: captureNoteSnapshots([noteId]),
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      startWorld: viewportToWorld(event.clientX, event.clientY),
      startRotation: normalizeRotation(note.rotation),
      startAngle: getPointerAngle(event.clientX, event.clientY, centerClient),
      startWidth: note.width || 320,
      startHeight: note.height || 180,
      centerClient,
    };

    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-transforming-image");
  }

  function updateImageTransformElement(note) {
    const element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
    if (!element) {
      return;
    }

    element.style.left = `${note.x}px`;
    element.style.top = `${note.y}px`;
    updateImageElement(element, note);
  }

  function rotateImageWithPointer(event) {
    const note = findNote(activeDrag.noteId);
    if (!note) {
      return;
    }

    const currentAngle = getPointerAngle(event.clientX, event.clientY, activeDrag.centerClient);
    const delta = currentAngle - activeDrag.startAngle;
    note.rotation = normalizeRotation(activeDrag.startRotation + delta);
    activeDrag.moved = true;
    updateImageTransformElement(note);
  }

  function resizeImageWithPointer(event) {
    const note = findNote(activeDrag.noteId);
    if (!note) {
      return;
    }

    const pointerWorld = viewportToWorld(event.clientX, event.clientY);
    const dx = pointerWorld.x - activeDrag.startWorld.x;
    const dy = pointerWorld.y - activeDrag.startWorld.y;
    const radians = activeDrag.startRotation * (Math.PI / 180);
    const localDx = dx * Math.cos(radians) + dy * Math.sin(radians);
    const localDy = -dx * Math.sin(radians) + dy * Math.cos(radians);

    note.width = Math.round(clamp(activeDrag.startWidth + localDx, 40, 4000));
    note.height = Math.round(clamp(activeDrag.startHeight + localDy, 40, 4000));
    activeDrag.moved = true;
    updateImageTransformElement(note);
  }

  function endImageTransform() {
    viewport.classList.remove("is-transforming-image");
    if (!activeDrag.moved) {
      return;
    }

    pushUndoAction({ type: "update", items: activeDrag.snapshots });
    saveNotesNow();
  }

  // --- markdown note resize --------------------------------------------

  function startMarkdownResize(event, noteId) {
    const note = findNote(noteId);
    if (!note || note.type !== "markdown") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    syncNotesFromDom();

    const element = paper.querySelector(`[data-id="${CSS.escape(noteId)}"]`);
    activeDrag = {
      type: "markdown-resize",
      pointerId: event.pointerId,
      noteId,
      snapshots: captureNoteSnapshots([noteId]),
      moved: false,
      startWorld: viewportToWorld(event.clientX, event.clientY),
      startWidth: element?.offsetWidth || note.width || 380,
      startHeight: element?.offsetHeight || note.height || 420,
    };

    viewport.setPointerCapture(event.pointerId);
  }

  function resizeMarkdownWithPointer(event) {
    const note = findNote(activeDrag.noteId);
    if (!note) {
      return;
    }

    // World coords so the resize tracks the cursor at any zoom level.
    const pointerWorld = viewportToWorld(event.clientX, event.clientY);
    note.width = Math.round(
      clamp(
        activeDrag.startWidth + pointerWorld.x - activeDrag.startWorld.x,
        220,
        4000
      )
    );
    note.height = Math.round(
      clamp(
        activeDrag.startHeight + pointerWorld.y - activeDrag.startWorld.y,
        140,
        4000
      )
    );
    activeDrag.moved = true;

    const element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
    if (element) {
      element.style.width = `${note.width}px`;
      element.style.height = `${note.height}px`;
    }
  }

  function endMarkdownResize() {
    if (!activeDrag.moved) {
      return;
    }
    pushUndoAction({ type: "update", items: activeDrag.snapshots });
    saveNotesNow();
  }

  // --- markdown note move (drag the body in Preview mode) --------------
  //
  // A press on the preview body starts a threshold drag: move past a few
  // pixels and the whole note moves; release without moving and nothing
  // happens — no selection — so the body stays free to read and scroll.

  function startMarkdownMove(event, noteId) {
    const note = findNote(noteId);
    if (!note || note.type !== "markdown" || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    syncNotesFromDom();

    activeDrag = {
      type: "markdown-move",
      pointerId: event.pointerId,
      noteId,
      snapshots: captureNoteSnapshots([noteId]),
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      startNoteX: note.x,
      startNoteY: note.y,
    };

    viewport.setPointerCapture(event.pointerId);
  }

  function moveMarkdownWithPointer(event) {
    const note = findNote(activeDrag.noteId);
    if (!note) {
      return;
    }
    if (
      !activeDrag.moved &&
      Math.hypot(
        event.clientX - activeDrag.startX,
        event.clientY - activeDrag.startY
      ) <= panThreshold
    ) {
      return; // still within click tolerance — treat as a click, not a move
    }
    activeDrag.moved = true;

    const dx = (event.clientX - activeDrag.startX) / view.scale;
    const dy = (event.clientY - activeDrag.startY) / view.scale;
    note.x = Math.round(activeDrag.startNoteX + dx);
    note.y = Math.round(activeDrag.startNoteY + dy);

    const element = paper.querySelector(`[data-id="${CSS.escape(note.id)}"]`);
    if (element) {
      element.style.left = `${note.x}px`;
      element.style.top = `${note.y}px`;
    }
  }

  function endMarkdownMove() {
    if (!activeDrag.moved) {
      return;
    }
    pushUndoAction({ type: "update", items: activeDrag.snapshots });
    saveNotesNow();
  }

  // --- image crop -------------------------------------------------------

  let cropModeNoteId = "";
  let cropDrag = null;

  function toggleCropMode(noteId) {
    if (cropModeNoteId === noteId) {
      exitCropMode();
    } else {
      enterCropMode(noteId);
    }
  }

  function enterCropMode(noteId) {
    exitCropMode();
    const note = findNote(noteId);
    if (!note || note.type !== "image") {
      return;
    }
    cropModeNoteId = noteId;
    setSelectedNotes([noteId]);
    paper
      .querySelector(`[data-id="${CSS.escape(noteId)}"]`)
      ?.classList.add("is-cropping");
    showPasteStatus("Crop: drag a box over the image");
  }

  function exitCropMode() {
    if (!cropModeNoteId) {
      return;
    }
    const element = paper.querySelector(
      `[data-id="${CSS.escape(cropModeNoteId)}"]`
    );
    if (element) {
      element.classList.remove("is-cropping");
      const rubber = element.querySelector(".crop-rubber");
      if (rubber) {
        rubber.hidden = true;
      }
    }
    cropDrag = null;
    cropModeNoteId = "";
  }

  function positionRubber(rubber, ax, ay, bx, by) {
    rubber.style.left = `${Math.min(ax, bx)}px`;
    rubber.style.top = `${Math.min(ay, by)}px`;
    rubber.style.width = `${Math.abs(bx - ax)}px`;
    rubber.style.height = `${Math.abs(by - ay)}px`;
  }

  function startCropRubber(event, noteId) {
    if (cropModeNoteId !== noteId || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const note = findNote(noteId);
    if (!note) {
      return;
    }
    const editor = event.currentTarget;
    cropDrag = {
      noteId,
      editor,
      rubber: editor.querySelector(".crop-rubber"),
      pointerId: event.pointerId,
      rotation: normalizeRotation(note.rotation),
      startX: event.offsetX,
      startY: event.offsetY,
      startClientX: event.clientX,
      startClientY: event.clientY,
      curX: event.offsetX,
      curY: event.offsetY,
    };
    editor.setPointerCapture(event.pointerId);
    editor.addEventListener("pointermove", onCropRubberMove);
    editor.addEventListener("pointerup", endCropRubber);
    editor.addEventListener("pointercancel", endCropRubber);
    cropDrag.rubber.hidden = false;
    positionRubber(
      cropDrag.rubber,
      cropDrag.startX,
      cropDrag.startY,
      cropDrag.startX,
      cropDrag.startY
    );
  }

  function onCropRubberMove(event) {
    if (!cropDrag) {
      return;
    }
    // Convert the screen-space pointer delta into the image's own
    // (unscaled, unrotated) coordinate space.
    const scale = view.scale || 1;
    const radians = cropDrag.rotation * (Math.PI / 180);
    const dx = (event.clientX - cropDrag.startClientX) / scale;
    const dy = (event.clientY - cropDrag.startClientY) / scale;
    cropDrag.curX = cropDrag.startX + dx * Math.cos(radians) + dy * Math.sin(radians);
    cropDrag.curY = cropDrag.startY - dx * Math.sin(radians) + dy * Math.cos(radians);
    positionRubber(
      cropDrag.rubber,
      cropDrag.startX,
      cropDrag.startY,
      cropDrag.curX,
      cropDrag.curY
    );
  }

  function endCropRubber(event) {
    if (!cropDrag) {
      return;
    }
    const drag = cropDrag;
    cropDrag = null;
    drag.editor.releasePointerCapture?.(drag.pointerId);
    drag.editor.removeEventListener("pointermove", onCropRubberMove);
    drag.editor.removeEventListener("pointerup", endCropRubber);
    drag.editor.removeEventListener("pointercancel", endCropRubber);
    drag.rubber.hidden = true;

    const rx = Math.min(drag.startX, drag.curX);
    const ry = Math.min(drag.startY, drag.curY);
    const rw = Math.abs(drag.curX - drag.startX);
    const rh = Math.abs(drag.curY - drag.startY);
    if (event.type !== "pointerup" || rw < 8 || rh < 8) {
      exitCropMode();
      return;
    }
    applyCrop(drag.noteId, rx, ry, rw, rh);
  }

  function applyCrop(noteId, rx, ry, rw, rh) {
    const note = findNote(noteId);
    if (!note || note.type !== "image") {
      exitCropMode();
      return;
    }
    const width = note.width || 320;
    const height = note.height || 180;
    const left = clamp(rx, 0, width);
    const top = clamp(ry, 0, height);
    const cropW = clamp(rw, 8, width - left);
    const cropH = clamp(rh, 8, height - top);

    const snapshots = captureNoteSnapshots([noteId]);
    const current = cleanCrop(note.crop);
    note.crop = cleanCrop({
      x: current.x + (left / width) * current.w,
      y: current.y + (top / height) * current.h,
      w: (cropW / width) * current.w,
      h: (cropH / height) * current.h,
    });
    note.width = Math.round(cropW);
    note.height = Math.round(cropH);
    note.x += Math.round(left);
    note.y += Math.round(top);

    exitCropMode();
    updateImageTransformElement(note);
    pushUndoAction({ type: "update", items: snapshots });
    saveNotesNow();
    showPasteStatus("Image cropped");
  }

  // --- import a dropped markdown file -----------------------------------

  async function importBoardFile(text, name) {
    let board;
    try {
      const data = await apiJson(
        `/api/import?name=${encodeURIComponent(name || "")}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/markdown" },
          body: text,
        }
      );
      board = data?.board;
    } catch {
      showPasteStatus("Board import failed", true);
      return;
    }
    if (!board || !board.id) {
      return;
    }
    boards.push(normalizeBoardRecord(board, boards.length));
    renumberBoards();
    saveBoardsIndex();
    await switchBoard(board.id);
    showPasteStatus(`Imported board: ${board.title}`);
  }

  function handleFileDragOver(event) {
    if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
      event.preventDefault(); // allow the drop
    }
  }

  async function handleFileDrop(event) {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) {
      return;
    }
    event.preventDefault(); // don't let the browser open the dropped file
    const markdownFiles = files.filter(
      (file) =>
        file.name.toLowerCase().endsWith(".md") ||
        file.type === "text/markdown"
    );
    if (!markdownFiles.length) {
      return;
    }
    // A dropped markdown file always becomes its own new board.
    for (const file of markdownFiles) {
      let text = "";
      try {
        text = await file.text();
      } catch {
        continue;
      }
      await importBoardFile(text, file.name);
    }
  }

  async function deleteSelectedNotes() {
    if (!selectedNoteIds.size || undoInProgress) {
      return;
    }

    syncNotesFromDom();
    const ids = [...selectedNoteIds].filter((id) => findNote(id));
    if (!ids.length) {
      clearSelectedNotes();
      return;
    }

    const items = await captureUndoItems(ids);
    if (!items.length) {
      return;
    }

    pushUndoAction({ type: "delete", items });
    removeNotes(ids, { save: false });
    saveNotesNow();
  }

  async function restoreDeletedItems(items) {
    const restoredIds = [];

    for (const item of items) {
      if (!item?.note || findNote(item.note.id)) {
        continue;
      }

      if (item.note.type === "image" && item.blob) {
        await saveImageBlob(item.note.imageId, item.blob);
      }

      const note = cloneNote(item.note);
      notes.push(note);
      paper.appendChild(createNoteElement(note));
      restoredIds.push(note.id);
    }

    if (restoredIds.length) {
      setSelectedNotes(restoredIds);
      saveNotesNow();
    }

    return restoredIds;
  }

  function getActionIds(action) {
    if ((action.ids || []).length) {
      return action.ids;
    }

    return (action.items || [])
      .map((item) => item?.note?.id)
      .filter(Boolean);
  }

  function getActionName(action) {
    if (action.type === "add") {
      return "addition";
    }
    if (action.type === "delete") {
      return "deletion";
    }
    if (action.type === "update") {
      return "change";
    }
    if (action.type === "spell-ignore") {
      return "ignore";
    }
    if (action.type === "spell-add") {
      return "dictionary add";
    }
    if (action.type === "spell-replace") {
      return "correction";
    }
    return "action";
  }

  function isSpellAction(action) {
    return action?.type === "spell-ignore" || action?.type === "spell-add" || action?.type === "spell-replace";
  }

  async function undoLastAction() {
    if (undoInProgress || !undoStack.length) {
      return false;
    }

    undoInProgress = true;
    syncBoardOverlayUndoRedoControls();
    try {
      syncNotesFromDom();
      const action = undoStack.pop();
      if (action.type === "add") {
        const redoItems = (action.items || []).length
          ? action.items
          : await captureUndoItems(getActionIds(action));
        removeNotes(getActionIds(action), { save: false });
        saveNotesNow();
        if (redoItems.length) {
          pushRedoAction({ type: "add", items: redoItems });
        }
        showPasteStatus(`Undid ${getActionName(action)}. Ctrl+Y to redo`);
        return true;
      }

      if (action.type === "delete") {
        await restoreDeletedItems(action.items || []);
        pushRedoAction(action);
        showPasteStatus(`Undid ${getActionName(action)}. Ctrl+Y to redo`);
        return true;
      }

      if (action.type === "update" || action.type === "spell-replace") {
        const redoItems = captureNoteSnapshots(getActionIds(action));
        restoreNoteSnapshots(action.items || []);
        if (redoItems.length) {
          pushRedoAction({ type: action.type, items: redoItems });
        }
        showPasteStatus(`Undid ${getActionName(action)}. Ctrl+Y to redo`);
        return true;
      }

      if (action.type === "spell-ignore") {
        spellService.unignore(action.word);
        refreshSpellHighlightsSoon();
        pushRedoAction(action);
        showPasteStatus("Undid ignore. Ctrl+Y to redo");
        return true;
      }

      if (action.type === "spell-add") {
        spellService.remove(action.word);
        refreshSpellHighlightsSoon();
        pushRedoAction(action);
        showPasteStatus("Undid dictionary add. Ctrl+Y to redo");
        return true;
      }
    } finally {
      undoInProgress = false;
      syncBoardOverlayUndoRedoControls();
    }

    return false;
  }

  async function redoLastAction() {
    if (undoInProgress || !redoStack.length) {
      return false;
    }

    undoInProgress = true;
    syncBoardOverlayUndoRedoControls();
    try {
      syncNotesFromDom();
      const action = redoStack.pop();
      if (action.type === "add") {
        const restoredIds = await restoreDeletedItems(action.items || []);
        if (restoredIds.length) {
          pushUndoAction({ type: "add", ids: restoredIds, items: action.items || [] }, { clearRedo: false });
        }
        showPasteStatus(`Redid ${getActionName(action)}`);
        return true;
      }

      if (action.type === "delete") {
        removeNotes(getActionIds(action), { save: false });
        saveNotesNow();
        pushUndoAction(action, { clearRedo: false });
        showPasteStatus(`Redid ${getActionName(action)}`);
        return true;
      }

      if (action.type === "update" || action.type === "spell-replace") {
        const undoItems = captureNoteSnapshots(getActionIds(action));
        restoreNoteSnapshots(action.items || []);
        if (undoItems.length) {
          pushUndoAction({ type: action.type, items: undoItems }, { clearRedo: false });
        }
        showPasteStatus(`Redid ${getActionName(action)}`);
        return true;
      }

      if (action.type === "spell-ignore") {
        spellService.ignore(action.word);
        refreshSpellHighlightsSoon();
        pushUndoAction(action, { clearRedo: false });
        showPasteStatus("Redid ignore");
        return true;
      }

      if (action.type === "spell-add") {
        spellService.add(action.word);
        refreshSpellHighlightsSoon();
        pushUndoAction(action, { clearRedo: false });
        showPasteStatus("Redid dictionary add");
        return true;
      }
    } finally {
      undoInProgress = false;
      syncBoardOverlayUndoRedoControls();
    }

    return false;
  }

  async function undoOrDeleteSelection() {
    if (undoStack.length) {
      await undoLastAction();
      return;
    }

    if (selectedNoteIds.size) {
      await deleteSelectedNotes();
    }
  }

  function endMoveSelection() {
    viewport.classList.remove("is-moving-selection");
    if (activeDrag.moved) {
      saveNotesNow();
    }
  }

  function beginDrag(event) {
    hideSpellingBubble();

    if (event.button === 2) {
      event.preventDefault();
      startSelectionDrag(event);
      return;
    }

    if (event.button !== 0 && event.button !== 1) {
      return;
    }

    clearSelectedNotes();

    activeDrag = {
      type: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: view.x,
      viewY: view.y,
      moved: false,
      panOnly: event.button === 1 || spaceDown,
    };

    viewport.setPointerCapture(event.pointerId);
    if (activeDrag.panOnly) {
      event.preventDefault();
      viewport.classList.add("is-panning");
    }
  }

  function moveDrag(event) {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) {
      return;
    }

    if (activeDrag.type === "select") {
      moveSelectionDrag(event);
      return;
    }

    if (activeDrag.type === "move-selection") {
      moveSelectedNotes(event);
      return;
    }

    if (activeDrag.type === "image-rotate") {
      rotateImageWithPointer(event);
      return;
    }

    if (activeDrag.type === "image-resize") {
      resizeImageWithPointer(event);
      return;
    }

    if (activeDrag.type === "markdown-resize") {
      resizeMarkdownWithPointer(event);
      return;
    }

    if (activeDrag.type === "markdown-move") {
      moveMarkdownWithPointer(event);
      return;
    }

    const dx = event.clientX - activeDrag.startX;
    const dy = event.clientY - activeDrag.startY;
    const shouldPan = activeDrag.panOnly || Math.hypot(dx, dy) > panThreshold;

    if (!shouldPan) {
      return;
    }

    activeDrag.moved = true;
    viewport.classList.add("is-panning");
    view.x = activeDrag.viewX + dx;
    view.y = activeDrag.viewY + dy;
    applyView();
    saveViewSoon();
  }

  function endDrag(event) {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) {
      return;
    }

    if (activeDrag.type === "select") {
      viewport.releasePointerCapture(event.pointerId);
      endSelectionDrag(event);
      activeDrag = null;
      return;
    }

    if (activeDrag.type === "move-selection") {
      viewport.releasePointerCapture(event.pointerId);
      endMoveSelection();
      activeDrag = null;
      return;
    }

    if (activeDrag.type === "image-rotate" || activeDrag.type === "image-resize") {
      viewport.releasePointerCapture(event.pointerId);
      endImageTransform();
      activeDrag = null;
      return;
    }

    if (activeDrag.type === "markdown-resize") {
      viewport.releasePointerCapture(event.pointerId);
      endMarkdownResize();
      activeDrag = null;
      return;
    }

    if (activeDrag.type === "markdown-move") {
      viewport.releasePointerCapture(event.pointerId);
      endMarkdownMove();
      activeDrag = null;
      return;
    }

    const wasClick = !activeDrag.moved && !activeDrag.panOnly && event.button === 0;
    const clickX = activeDrag.startX;
    const clickY = activeDrag.startY;
    viewport.releasePointerCapture(event.pointerId);
    viewport.classList.remove("is-panning");
    activeDrag = null;

    if (wasClick) {
      addNoteAt(clickX, clickY);
    }
  }

  viewport.addEventListener("pointerdown", beginDrag);
  viewport.addEventListener("pointermove", moveDrag);
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", () => {
    activeDrag = null;
    hideSelectionBox();
    viewport.classList.remove("is-panning");
    viewport.classList.remove("is-selecting");
    viewport.classList.remove("is-moving-selection");
    viewport.classList.remove("is-transforming-image");
  });

  viewport.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  document.addEventListener("beforeinput", handleBeforeInput, true);
  document.addEventListener("paste", handlePaste, true);
  document.addEventListener("dragover", handleFileDragOver);
  document.addEventListener("drop", handleFileDrop);

  findBar.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  findBar.addEventListener("submit", (event) => {
    event.preventDefault();
    jumpFind(1);
  });

  findInput.addEventListener("input", refreshFindMatches);

  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpFind(event.shiftKey ? -1 : 1);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  });

  findPrev.addEventListener("click", () => jumpFind(-1));
  findNext.addEventListener("click", () => jumpFind(1));
  findClose.addEventListener("click", closeFind);

  titleBar.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  titleBar.addEventListener("submit", (event) => {
    event.preventDefault();
    saveTitleRename();
  });

  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTitleRename();
    }
  });

  titleClose.addEventListener("click", closeTitleRename);

  syncChannel?.addEventListener("message", (event) => {
    if (event.data?.type === "board-updated") {
      applyIncomingBoard(event.data.state);
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key === boardsStorageKey && event.newValue) {
      loadBoardsIndex();
      renderBoardOverlay();
      return;
    }

    if (event.key !== getBoardStorageKey(currentBoardId) || !event.newValue) {
      return;
    }

    try {
      applyIncomingBoard(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed external storage writes.
    }
  });

  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const point = viewportToWorld(event.clientX, event.clientY);
        const nextScale = clamp(view.scale * Math.exp(-event.deltaY * 0.001), 0.45, 2.4);
        view.scale = nextScale;
        view.x = event.clientX - point.x * view.scale;
        view.y = event.clientY - point.y * view.scale;
      } else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
      }
      applyView();
      saveViewSoon();
    },
    { passive: false }
  );

  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
      if (!findBar.contains(document.activeElement) && !titleBar.contains(document.activeElement)) {
        event.preventDefault();
        if (event.shiftKey) {
          toggleBoardOverlay();
        } else {
          toggleTabOverlay();
        }
        return;
      }
    }

    if (event.key === "Escape" && activeSpelling) {
      event.preventDefault();
      hideSpellingBubble();
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "F2") {
      event.preventDefault();
      if (boardOverlay && !boardOverlay.hidden) {
        startBoardRename(getFocusedBoardOverlayId());
        return;
      }
      openTitleRename();
      return;
    }

    // N creates a new board in its own tab — the keyboard form of
    // "+ New board". It works whether or not the overlay is open, so the
    // habitual "Shift+Tab then N" gesture always lands a new board, even
    // when that Shift+Tab just toggled the overlay shut.
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLowerCase() === "n" &&
      !renamingBoardId &&
      !isTextEntryElement(document.activeElement)
    ) {
      event.preventDefault();
      // "Shift+Tab N": if a Shift+Tab toggled the overlay a moment ago, it
      // was the lead-in to this gesture — undo it so this page's overlay is
      // left untouched (the new board opens in its own tab instead).
      if (
        lastBoardOverlayToggle &&
        Date.now() - lastBoardOverlayToggle.at < 1000
      ) {
        restoreBoardOverlay(lastBoardOverlayToggle.wasHidden);
        lastBoardOverlayToggle = null;
      }
      openNewBoardInTab();
      return;
    }

    // Arrow keys move the highlight through the board list; holding Shift
    // extends a multi-board selection.
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      boardOverlay &&
      !boardOverlay.hidden &&
      !renamingBoardId &&
      !isTextEntryElement(document.activeElement)
    ) {
      event.preventDefault();
      moveBoardCursor(event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
      return;
    }

    // Delete removes the highlighted board — or every board in the
    // multi-selection — and lands the highlight on the board below.
    if (
      event.key === "Delete" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      boardOverlay &&
      !boardOverlay.hidden &&
      boardOverlay.contains(document.activeElement) &&
      !renamingBoardId &&
      !isTextEntryElement(document.activeElement)
    ) {
      event.preventDefault();
      const ids = boardSelection.size
        ? [...boardSelection]
        : boardCursorId
        ? [boardCursorId]
        : [];
      if (ids.length) {
        deleteBoards(ids);
      }
      return;
    }

    // Enter opens (switches to) the highlighted board.
    if (
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      boardOverlay &&
      !boardOverlay.hidden &&
      !renamingBoardId &&
      !isTextEntryElement(document.activeElement)
    ) {
      if (boardCursorId) {
        event.preventDefault();
        switchBoard(boardCursorId);
      }
      return;
    }

    if (!titleBar.hidden && event.key === "Escape") {
      event.preventDefault();
      closeTitleRename();
      return;
    }

    if (titleBar.contains(document.activeElement)) {
      return;
    }

    if (boardOverlay?.contains(document.activeElement) && isTextEntryElement(document.activeElement)) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
      event.preventDefault();
      if (findBar.hidden) {
        openFind();
      } else {
        closeFind();
      }
      return;
    }

    if (!findBar.hidden && event.key === "Escape") {
      event.preventDefault();
      closeFind();
      return;
    }

    if (event.key === "Escape" && selectedNoteIds.size) {
      event.preventDefault();
      clearSelectedNotes();
      return;
    }

    if (findBar.contains(document.activeElement)) {
      return;
    }

    const activeTextNote = getActiveTextNoteElement();

    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "v") {
      if (event.shiftKey) {
        event.preventDefault();
        readBridgeClipboardImages()
          .then((images) => {
            if (!images.length) {
              showPasteStatus("No image found in Windows clipboard", true);
              return false;
            }
            return pasteImageBlobs(images, activeTextNote);
          })
          .catch(() => showPasteStatus("Windows clipboard bridge is not running", true));
      } else {
        probeKeyboardImagePaste(activeTextNote).catch(() => {});
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "c") {
      if (selectedNoteIds.size && shouldUseBoardShortcut(activeTextNote)) {
        event.preventDefault();
        boardCopyPromise = copySelectedNotes().finally(() => {
          boardCopyPromise = null;
        });
      }
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.key.toLocaleLowerCase() === "z"
    ) {
      if ((isSpellAction(redoStack.at(-1)) || shouldUseBoardShortcut(activeTextNote)) && redoStack.length) {
        event.preventDefault();
        if (!isSpellAction(redoStack.at(-1))) {
          removeActiveEmptyTextNote(activeTextNote);
        }
        redoLastAction();
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "y") {
      if ((isSpellAction(redoStack.at(-1)) || shouldUseBoardShortcut(activeTextNote)) && redoStack.length) {
        event.preventDefault();
        if (!isSpellAction(redoStack.at(-1))) {
          removeActiveEmptyTextNote(activeTextNote);
        }
        redoLastAction();
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "z") {
      if (
        isSpellAction(undoStack.at(-1)) ||
        (shouldUseBoardShortcut(activeTextNote) && (undoStack.length || selectedNoteIds.size))
      ) {
        event.preventDefault();
        if (!isSpellAction(undoStack.at(-1))) {
          removeActiveEmptyTextNote(activeTextNote);
        }
        undoOrDeleteSelection();
      }
      return;
    }

    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      selectedNoteIds.size &&
      shouldUseBoardShortcut(activeTextNote)
    ) {
      event.preventDefault();
      removeActiveEmptyTextNote(activeTextNote);
      deleteSelectedNotes();
      return;
    }

    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLocaleLowerCase() === "r" &&
      selectedNoteIds.size &&
      shouldUseBoardShortcut(activeTextNote) &&
      getSelectedImageNotes().length
    ) {
      event.preventDefault();
      removeActiveEmptyTextNote(activeTextNote);
      rotateSelectedImages(event.shiftKey ? -1 : 1);
      return;
    }

    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLocaleLowerCase() === "m" &&
      selectedNoteIds.size &&
      shouldUseBoardShortcut(activeTextNote) &&
      getSelectedImageNotes().length
    ) {
      event.preventDefault();
      removeActiveEmptyTextNote(activeTextNote);
      mirrorSelectedImages(event.shiftKey ? "y" : "x");
      return;
    }

    if (activeTextNote) {
      return;
    }

    if (event.code === "Space") {
      spaceDown = true;
      event.preventDefault();
      viewport.classList.add("is-panning");
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      spaceDown = false;
      if (!activeDrag) {
        viewport.classList.remove("is-panning");
      }
    }
  });

  window.addEventListener("resize", keepTabOverlayOnscreen);

  window.addEventListener("keydown", (event) => {
    if (cropModeNoteId && event.key === "Escape") {
      exitCropMode();
    }
  });

  window.addEventListener("beforeunload", () => {
    window.clearTimeout(noteSaveTimer);
    window.clearTimeout(viewSaveTimer);
    window.clearTimeout(spellHighlightTimer);
    CSS.highlights?.delete("app-spell-error");
    if (pendingNoteSave) {
      // Only flush a genuinely pending edit. A page that is merely
      // displaying notes must not write its (possibly stale) copy back
      // over a newer version of the file.
      saveNotesNow();
    }
    saveViewNow();
    syncChannel?.close();
  });

  void (async function startInfinitePaper() {
    const ready = await loadState();
    if (!ready) {
      return;
    }
    loadTabTitle();
    applyView();
    renderNotes();
    setupLiveReload();
    restoreBoardOverlayState();
    maybeSpawnNewBoardFromUrl();
  })();
})();
