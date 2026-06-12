const localBoardKeys = [
  "infinite-paper:v8.1.1:board",
  "infinite-paper:v8.1:board",
  "infinite-paper:v8.1",
];

const localImageDbName = "infinite-paper:v8.1.1:images";
const localImageStoreName = "images";

function normalizeNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((note) => note && typeof note.id === "string")
    .map((note) => ({
      id: note.id,
      type: note.type === "image" ? "image" : "text",
      x: Math.round(Number(note.x) || 0),
      y: Math.round(Number(note.y) || 0),
      text: typeof note.text === "string" ? note.text : "",
      imageId: typeof note.imageId === "string" ? note.imageId : note.id,
      mimeType: typeof note.mimeType === "string" ? note.mimeType : "image/png",
      width: Math.round(Number(note.width) || 320),
      height: Math.round(Number(note.height) || 180),
      rotation: Number(note.rotation) || 0,
      flipX: Boolean(note.flipX),
      flipY: Boolean(note.flipY),
    }));
}

export function readSameOriginLocalBoard() {
  for (const key of localBoardKeys) {
    try {
      const value = localStorage.getItem(key);
      if (!value) continue;
      const parsed = JSON.parse(value);
      const notes = normalizeNotes(parsed.notes);
      if (notes.length) {
        return { source: key, notes };
      }
    } catch {
      // Keep trying older storage keys.
    }
  }
  return { source: "", notes: [] };
}

export async function readBackupFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);

  if (Array.isArray(parsed.notes)) {
    return { source: file.name, notes: normalizeNotes(parsed.notes) };
  }

  if (Array.isArray(parsed.boards)) {
    const board =
      parsed.boards.find((candidate) => candidate.version === "v8.1.1") ||
      parsed.boards.find((candidate) => candidate.version === "v8.1") ||
      parsed.boards.find((candidate) => candidate.parsedValue?.notes?.length);
    return {
      source: `${file.name}${board?.version ? `:${board.version}` : ""}`,
      notes: normalizeNotes(board?.parsedValue?.notes),
    };
  }

  return { source: file.name, notes: [] };
}

function openLocalImageDb() {
  if (!window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(localImageDbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function getSameOriginImageBlob(imageId) {
  const db = await openLocalImageDb();
  if (!db || !imageId) return null;

  return new Promise((resolve) => {
    const request = db.transaction(localImageStoreName, "readonly").objectStore(localImageStoreName).get(imageId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

export function hasImportBeenHandled(boardId) {
  return localStorage.getItem(`infinite-paper:web:import:${boardId}`) === "done";
}

export function markImportHandled(boardId) {
  localStorage.setItem(`infinite-paper:web:import:${boardId}`, "done");
}

