import {
  getSameOriginImageBlob,
  hasImportBeenHandled,
  markImportHandled,
  readBackupFile,
  readSameOriginLocalBoard,
} from "./localImport.js";
import { createSpellService } from "./spellingCore.js";

export function createBoardApp(options) {
  const remoteApi = options.api;
  const session = options.session;
  const currentBoard = options.board;
  const currentUserId = session.user.id;
  const viewport = document.getElementById("viewport");
  const paper = document.getElementById("paper");
  const boardTitle = document.getElementById("board-title");
  const syncStatus = document.getElementById("sync-status");
  const shareOpen = document.getElementById("share-open");
  const sharePanel = document.getElementById("share-panel");
  const shareClose = document.getElementById("share-close");
  const inviteForm = document.getElementById("invite-form");
  const inviteEmail = document.getElementById("invite-email");
  const inviteMessage = document.getElementById("invite-message");
  const memberList = document.getElementById("member-list");
  const importOpen = document.getElementById("import-open");
  const importPanel = document.getElementById("import-panel");
  const importClose = document.getElementById("import-close");
  const importLocal = document.getElementById("import-local");
  const importFile = document.getElementById("import-file");
  const importSkip = document.getElementById("import-skip");
  const importMessage = document.getElementById("import-message");
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
  const boardStorageKey = "infinite-paper:v8.1.1:board";
  const legacyBoardStorageKey = "infinite-paper:v8.1:board";
  const viewStorageKey = "infinite-paper:v8.1.1:view";
  const tabTitleStorageKey = "infinite-paper:v8.1.1:tab-title";
  const redlineSettingsKey = `infinite-paper:web:redlines-enabled:${currentUserId}`;
  const syncChannelName = "infinite-paper:v8.1.1:sync";
  const imageDbName = "infinite-paper:v8.1.1:images";
  const imageStoreName = "images";
  const clipboardBridgeImageUrl = "http://127.0.0.1:8124/clipboard-image";
  const canUseClipboardBridge = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const panThreshold = 5;
  const snapDistance = 8;
  const pastedImageMaxWidth = 760;
  const pastedImageMaxHeight = 540;
  const clientId = makeId();
  const syncChannel = "BroadcastChannel" in window ? new BroadcastChannel(syncChannelName) : null;
  const spellService = createSpellService(`infinite-paper:web:personal-dictionary:${currentUserId}`);
  const imageBlobCache = new Map();
  let unsubscribeRemote = null;
  let destroyed = false;
  let remoteReloadTimer = 0;
  let savingRemote = false;

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

  async function loadState() {
    try {
      setSyncStatus("Loading");
      notes = normalizeNotes(await remoteApi.loadNotes(currentBoard.id));
      boardRevision = Date.now();
      setSyncStatus("Synced");
    } catch (error) {
      notes = [];
      boardRevision = 0;
      migratedFromLegacy = false;
      setSyncStatus(error.message || "Load failed", true);
    }

    try {
      const savedView = JSON.parse(sessionStorage.getItem(viewStorageKey) || "{}");
      if (savedView && Number.isFinite(savedView.x) && Number.isFinite(savedView.y)) {
        view = {
          x: savedView.x,
          y: savedView.y,
          scale: clamp(Number(savedView.scale) || 1, 0.45, 2.4),
        };
      }
    } catch {
      saveViewNow();
    }
  }

  function saveNotesSoon() {
    window.clearTimeout(noteSaveTimer);
    noteSaveTimer = window.setTimeout(saveNotesNow, 80);
  }

  function saveViewSoon() {
    window.clearTimeout(viewSaveTimer);
    viewSaveTimer = window.setTimeout(saveViewNow, 120);
  }

  function saveNotesNow() {
    if (destroyed || !currentBoard?.id) {
      return;
    }
    syncNotesFromDom();
    const state = {
      version: 1,
      revision: nextRevision(),
      origin: clientId,
      migratedFrom: migratedFromLegacy ? "v8.1" : undefined,
      notes: cleanNotes(notes),
    };
    savingRemote = true;
    setSyncStatus("Saving");
    remoteApi
      .saveNotes(currentBoard.id, state.notes, currentUserId)
      .then(() => setSyncStatus("Synced"))
      .catch((error) => setSyncStatus(error.message || "Save failed", true))
      .finally(() => {
        savingRemote = false;
      });
    syncChannel?.postMessage({ type: "board-updated", state });
    dirtyNoteIds.clear();
  }

  function saveViewNow() {
    sessionStorage.setItem(viewStorageKey, JSON.stringify(view));
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

    if (options.persist === false) {
      return;
    }

    if (cleanTitle && cleanTitle !== defaultDocumentTitle) {
      sessionStorage.setItem(tabTitleStorageKey, cleanTitle);
    } else {
      sessionStorage.removeItem(tabTitleStorageKey);
    }
  }

  function loadTabTitle() {
    applyTabTitle(sessionStorage.getItem(tabTitleStorageKey), { persist: false });
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
      hideSpellingBubble();
      CSS.highlights?.delete("app-spell-error");
      return;
    }
    refreshSpellHighlightsSoon();
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
    });

    const toggleRedlines = document.createElement("button");
    toggleRedlines.type = "button";
    toggleRedlines.dataset.action = "toggle-redlines";
    toggleRedlines.addEventListener("click", () => {
      redlinesEnabled = !redlinesEnabled;
      applyRedlineSetting();
    });
    tabOverlay.appendChild(toggleRedlines);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "x";
    closeButton.setAttribute("aria-label", "Close tools");
    closeButton.addEventListener("click", closeTabOverlay);
    tabOverlay.appendChild(closeButton);

    document.body.appendChild(tabOverlay);
    syncTabOverlayState();
    return tabOverlay;
  }

  function openTabOverlay() {
    hideSpellingBubble();
    const overlay = getTabOverlay();
    overlay.hidden = false;
    syncTabOverlayState();
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
          imagePath: note.imagePath || (note.imageId ? `${currentBoard.id}/${note.imageId}` : ""),
          mimeType: note.mimeType || "image/png",
          width: note.width,
          height: note.height,
          rotation: normalizeRotation(note.rotation),
          flipX: Boolean(note.flipX),
          flipY: Boolean(note.flipY),
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
        type: note.type === "image" ? "image" : "text",
        x: Math.round(Number(note.x)),
        y: Math.round(Number(note.y)),
        text: typeof note.text === "string" ? note.text : "",
        imageId: typeof note.imageId === "string" ? note.imageId : "",
        imagePath: typeof note.imagePath === "string" ? note.imagePath : "",
        mimeType: typeof note.mimeType === "string" ? note.mimeType : "image/png",
        width: Number.isFinite(Number(note.width)) ? Math.round(Number(note.width)) : 320,
        height: Number.isFinite(Number(note.height)) ? Math.round(Number(note.height)) : 180,
        rotation: normalizeRotation(note.rotation),
        flipX: Boolean(note.flipX),
        flipY: Boolean(note.flipY),
      }));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeRotation(value) {
    const degrees = Number(value) || 0;
    return ((degrees % 360) + 360) % 360;
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
    const imagePath = await remoteApi.uploadImage(currentBoard.id, imageId, blob);
    imageBlobCache.set(imageId, blob);
    imageBlobCache.set(imagePath, blob);
    return imagePath;
  }

  async function getImageBlob(imageId) {
    const note = notes.find((candidate) => candidate.imageId === imageId || candidate.imagePath === imageId);
    const imagePath = note?.imagePath || imageId;
    if (imageBlobCache.has(imageId)) {
      return imageBlobCache.get(imageId);
    }
    if (imageBlobCache.has(imagePath)) {
      return imageBlobCache.get(imagePath);
    }
    if (!imagePath) {
      return null;
    }
    const blob = await remoteApi.downloadImage(imagePath);
    imageBlobCache.set(imageId, blob);
    imageBlobCache.set(imagePath, blob);
    return blob;
  }

  async function deleteImageBlob(imageId) {
    if (!imageId) {
      return;
    }

    const note = notes.find((candidate) => candidate.imageId === imageId || candidate.imagePath === imageId);
    const imagePath = note?.imagePath || imageId;
    imageBlobCache.delete(imageId);
    imageBlobCache.delete(imagePath);
    if (imagePath.includes("/")) {
      await remoteApi.removeImages([imagePath]);
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

  async function loadImageIntoElement(note, image) {
    image.dataset.imageId = note.imagePath || note.imageId || "";
    try {
      const blob = await getImageBlob(note.imagePath || note.imageId);
      if (!blob || image.dataset.imageId !== (note.imagePath || note.imageId)) {
        return;
      }

      if (image.dataset.objectUrl) {
        URL.revokeObjectURL(image.dataset.objectUrl);
      }
      const url = URL.createObjectURL(blob);
      image.dataset.objectUrl = url;
      image.src = url;
    } catch {
      image.removeAttribute("src");
    }
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
    closeTabOverlay();

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

  function createNoteElement(note) {
    if (!isTextNote(note)) {
      return createImageElement(note);
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

    const image = document.createElement("img");
    image.alt = "Pasted image";
    image.draggable = false;
    element.appendChild(image);

    const controls = document.createElement("div");
    controls.className = "image-controls";
    controls.setAttribute("aria-hidden", "true");

    const rotateHandle = document.createElement("button");
    rotateHandle.type = "button";
    rotateHandle.className = "image-control image-rotate-control";
    rotateHandle.title = "Drag to rotate";
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

    controls.appendChild(rotateHandle);
    controls.appendChild(mirrorHorizontalButton);
    controls.appendChild(mirrorVerticalButton);
    controls.appendChild(resizeHandle);
    element.appendChild(controls);

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

    if (image.dataset.imageId !== (note.imagePath || note.imageId)) {
      loadImageIntoElement(note, image);
    }
  }

  function applyImageGeometry(element, note) {
    const width = note.width || 320;
    const height = note.height || 180;
    const rotation = normalizeRotation(note.rotation);
    const image = element.querySelector("img");

    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.style.transform = `rotate(${rotation}deg)`;
    element.dataset.rotation = String(rotation);

    if (!image) {
      return;
    }

    image.style.width = "100%";
    image.style.height = "100%";
    image.style.transform = `${note.flipX ? "scaleX(-1)" : "scaleX(1)"} ${
      note.flipY ? "scaleY(-1)" : "scaleY(1)"
    }`;
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
    if (stack.length > 20) {
      stack.shift();
    }
  }

  function pushUndoAction(action, options = {}) {
    undoStack.push(action);
    trimActionStack(undoStack);
    if (options.clearRedo !== false) {
      redoStack = [];
    }
  }

  function pushRedoAction(action) {
    redoStack.push(action);
    trimActionStack(redoStack);
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
      if (note.type === "image" && (note.imagePath || note.imageId)) {
        item.blob = await getImageBlob(note.imagePath || note.imageId).catch(() => null);
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
      if (!isTextNote(note)) {
        continue;
      }
      const element = paper.querySelector(`.note[data-id="${CSS.escape(note.id)}"]`);
      if (element) {
        note.text = getNoteText(element);
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
    const activeElement = document.activeElement?.classList.contains("note")
      ? document.activeElement
      : null;
    const protectedElement =
      activeElement && dirtyNoteIds.has(activeElement.dataset.id) ? activeElement : null;
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
      if (!isTextNote(note)) {
        updateImageElement(element, note);
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
        deleteImageBlob(removedNote.imagePath || removedNote.imageId).catch(() => {});
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
    if (removedNotes.length) {
      remoteApi.deleteNotes(removedNotes.map((note) => note.id)).catch((error) => {
        setSyncStatus(error.message || "Delete failed", true);
      });
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
    if (!canUseClipboardBridge) {
      return [];
    }

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
    const imagePath = await saveImageBlob(imageId, blob);
    const naturalSize = await getImageDimensions(blob);
    const displaySize = getDisplaySize(naturalSize.width, naturalSize.height);
    const offset = index * 28;

    return {
      id: imageId,
      type: "image",
      imageId,
      imagePath,
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
        note.imagePath = await saveImageBlob(imageId, item.blob);
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

  async function pasteImageBlobs(images, activeTextNote) {
    if (!images.length) {
      return false;
    }

    if (isRecentImagePaste(images)) {
      return true;
    }

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
      rememberImagePaste(images);
      saveNotesNow();
      showPasteStatus(`Pasted ${addedIds.length} image${addedIds.length === 1 ? "" : "s"}`);
    } else {
      showPasteStatus("Image paste failed", true);
    }

    return addedIds.length > 0;
  }

  async function handlePaste(event) {
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

    const bridgeImages = await readBridgeClipboardImages();
    if (bridgeImages.length) {
      images = bridgeImages;
    }

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
    if (probeId !== keyboardImagePasteProbe || !images.length || isRecentImagePaste(images)) {
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
        item.note.imagePath = await saveImageBlob(item.note.imageId, item.blob);
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
    }

    return false;
  }

  async function redoLastAction() {
    if (undoInProgress || !redoStack.length) {
      return false;
    }

    undoInProgress = true;
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
    closeTabOverlay();

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
    if (event.key !== boardStorageKey || !event.newValue) {
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
      const isPanelInput =
        findBar.contains(document.activeElement) ||
        titleBar.contains(document.activeElement) ||
        sharePanel.contains(document.activeElement) ||
        importPanel.contains(document.activeElement);
      if (!isPanelInput) {
        event.preventDefault();
        toggleTabOverlay();
        return;
      }
    }

    if (event.key === "Escape" && activeSpelling) {
      event.preventDefault();
      hideSpellingBubble();
      return;
    }

    if (event.key === "Escape" && tabOverlay && !tabOverlay.hidden) {
      event.preventDefault();
      closeTabOverlay();
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "F2") {
      event.preventDefault();
      openTitleRename();
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

  window.addEventListener("beforeunload", () => {
    window.clearTimeout(noteSaveTimer);
    window.clearTimeout(viewSaveTimer);
    saveNotesNow();
    saveViewNow();
    syncChannel?.close();
  });

  function setSyncStatus(message, isError = false) {
    syncStatus.textContent = message;
    syncStatus.classList.toggle("is-error", isError);
  }

  async function reloadRemoteNotes() {
    if (destroyed || dirtyNoteIds.size) {
      return;
    }

    try {
      const remoteNotes = await remoteApi.loadNotes(currentBoard.id);
      notes = normalizeNotes(remoteNotes);
      pruneSelectedNotes();
      renderSyncedNotes();
      if (!findBar.hidden) {
        refreshFindMatches();
      }
      setSyncStatus("Synced");
    } catch (error) {
      setSyncStatus(error.message || "Sync failed", true);
    }
  }

  function scheduleRemoteReload() {
    window.clearTimeout(remoteReloadTimer);
    remoteReloadTimer = window.setTimeout(reloadRemoteNotes, savingRemote ? 350 : 80);
  }

  function setupRemoteSync() {
    unsubscribeRemote?.();
    unsubscribeRemote = remoteApi.subscribeToBoard(currentBoard.id, scheduleRemoteReload);
  }

  async function refreshPeople() {
    try {
      const people = await remoteApi.listBoardPeople(currentBoard.id);
      const memberRows = people.members
        .map((member) => {
          const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
          return `<div><strong>${profile?.display_name || profile?.email || "Member"}</strong><span>${member.role}</span></div>`;
        })
        .join("");
      const inviteRows = people.invites
        .map((invite) => `<div><strong>${invite.email}</strong><span>invited</span></div>`)
        .join("");
      memberList.innerHTML = memberRows + inviteRows || "<p>No collaborators yet.</p>";
    } catch (error) {
      memberList.textContent = error.message || "Could not load collaborators.";
    }
  }

  function openSharePanel() {
    sharePanel.hidden = false;
    refreshPeople();
  }

  function closeSharePanel() {
    sharePanel.hidden = true;
    inviteMessage.textContent = "";
  }

  async function importNotes(importedNotes, source, options = {}) {
    const imported = [];
    let skippedImages = 0;

    for (const sourceNote of normalizeNotes(importedNotes)) {
      const note = cloneNote(sourceNote);
      if (note.type === "image") {
        const blob = options.getImageBlob ? await options.getImageBlob(note.imageId) : null;
        if (!blob) {
          skippedImages += 1;
          continue;
        }
        note.imagePath = await saveImageBlob(note.imageId, blob);
      }
      imported.push(note);
    }

    if (!imported.length) {
      importMessage.textContent = skippedImages
        ? "No notes imported. Image blobs were not available from this origin/file."
        : "No notes found to import.";
      return;
    }

    notes = imported;
    renderNotes();
    await remoteApi.saveNotes(currentBoard.id, cleanNotes(notes), currentUserId);
    markImportHandled(currentBoard.id);
    importMessage.textContent = `Imported ${imported.length} notes from ${source || "local board"}${
      skippedImages ? `; skipped ${skippedImages} image notes without image data` : ""
    }.`;
    setSyncStatus("Synced");
  }

  async function importSameOriginBoard() {
    const board = readSameOriginLocalBoard();
    await importNotes(board.notes, board.source, { getImageBlob: getSameOriginImageBlob });
  }

  async function importBackupJson(file) {
    const board = await readBackupFile(file);
    await importNotes(board.notes, board.source);
  }

  function openImportPanel() {
    importPanel.hidden = false;
    importMessage.textContent = "";
  }

  function closeImportPanel() {
    importPanel.hidden = true;
    importMessage.textContent = "";
  }

  function maybePromptImport() {
    if (!hasImportBeenHandled(currentBoard.id) && !notes.length) {
      openImportPanel();
    }
  }

  function setupPanels() {
    shareOpen.addEventListener("click", openSharePanel);
    shareClose.addEventListener("click", closeSharePanel);
    inviteForm.addEventListener("submit", (event) => {
      event.preventDefault();
      inviteMessage.textContent = "Sending invite...";
      remoteApi
        .createInvite(currentBoard.id, inviteEmail.value)
        .then(() => {
          inviteMessage.textContent = "Invite saved. They can accept after signing in with that email.";
          inviteEmail.value = "";
          refreshPeople();
        })
        .catch((error) => {
          inviteMessage.textContent = error.message || "Invite failed.";
        });
    });

    importOpen.addEventListener("click", openImportPanel);
    importClose.addEventListener("click", closeImportPanel);
    importLocal.addEventListener("click", () => {
      importMessage.textContent = "Importing browser board...";
      importSameOriginBoard().catch((error) => {
        importMessage.textContent = error.message || "Import failed.";
      });
    });
    importFile.addEventListener("change", () => {
      const file = importFile.files?.[0];
      if (!file) return;
      importMessage.textContent = "Importing backup...";
      importBackupJson(file).catch((error) => {
        importMessage.textContent = error.message || "Import failed.";
      });
    });
    importSkip.addEventListener("click", () => {
      markImportHandled(currentBoard.id);
      closeImportPanel();
    });
  }

  async function start() {
    boardTitle.textContent = currentBoard.title || "Infinite Paper";
    loadTabTitle();
    await loadState();
    applyView();
    renderNotes();
    setupRemoteSync();
    setupPanels();
    maybePromptImport();
  }

  function destroy() {
    window.clearTimeout(noteSaveTimer);
    window.clearTimeout(viewSaveTimer);
    window.clearTimeout(remoteReloadTimer);
    window.clearTimeout(spellHighlightTimer);
    CSS.highlights?.delete("app-spell-error");
    spellingBubble?.remove();
    spellingBubble = null;
    tabOverlay?.remove();
    tabOverlay = null;
    activeSpelling = null;
    saveNotesNow();
    saveViewNow();
    destroyed = true;
    unsubscribeRemote?.();
    syncChannel?.close();
    for (const element of paper.querySelectorAll(".image-note")) {
      releaseImageElement(element);
    }
    paper.replaceChildren();
  }

  return {
    start,
    destroy,
  };
}
