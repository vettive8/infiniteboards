/**
 * Import boards from an Infinite Paper "all-boards" backup JSON into the
 * running v11-md server as new .md board files.
 *
 *   node tools/import-backup.js <backup.json> [version ...]
 *
 * With no versions listed, every non-empty board is imported. Each imported
 * board becomes its own board file; text notes keep their canvas positions.
 *
 * Image notes keep their layout and imageId, but the image *bytes* are not
 * in the backup JSON (they lived in the browser's IndexedDB), so imported
 * images will be blank until their bytes are restored separately.
 */

import fs from "node:fs";
import crypto from "node:crypto";

const [, , backupPath, ...wanted] = process.argv;
const SERVER = process.env.SERVER || "http://127.0.0.1:4321";

if (!backupPath) {
  console.error("usage: node tools/import-backup.js <backup.json> [version ...]");
  process.exit(1);
}

function convertNote(note) {
  if (!note || typeof note.id !== "string") return null;
  const base = {
    id: note.id,
    x: Math.round(Number(note.x) || 0),
    y: Math.round(Number(note.y) || 0),
  };
  if (note.type === "image") {
    return {
      ...base,
      type: "image",
      width: Math.round(Number(note.width)) || 320,
      height: Math.round(Number(note.height)) || 180,
      rotation: Number(note.rotation) || 0,
      flipX: Boolean(note.flipX),
      flipY: Boolean(note.flipY),
      imageId: typeof note.imageId === "string" ? note.imageId : "",
      mimeType: note.mimeType || "image/png",
    };
  }
  return { ...base, type: "text", text: typeof note.text === "string" ? note.text : "" };
}

const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
const boards = Array.isArray(backup.boards) ? backup.boards : [];
let importedCount = 0;

for (const entry of boards) {
  const version = entry.version || entry.storageKey || "board";
  if (wanted.length && !wanted.includes(version)) continue;

  const parsed = entry.parsedValue || {};
  const notes = (parsed.notes || []).map(convertNote).filter(Boolean);
  if (!notes.length) {
    console.log(`skip ${version}: no notes`);
    continue;
  }

  const now = Date.now();
  const view =
    parsed.view && Number.isFinite(Number(parsed.view.x))
      ? {
          x: Number(parsed.view.x),
          y: Number(parsed.view.y),
          scale: Number(parsed.view.scale) || 1,
        }
      : { x: 0, y: 0, scale: 1 };

  const board = {
    id: crypto.randomUUID(),
    title: `${version} (imported)`,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    revision: 1,
    view,
    notes,
  };

  const response = await fetch(`${SERVER}/api/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board }),
  });
  const result = await response.json();
  const images = notes.filter((n) => n.type === "image").length;
  console.log(
    `imported ${version}: ${notes.length} notes` +
      (images ? ` (${images} image)` : "") +
      ` -> ${result.file || result.error}`
  );
  importedCount += 1;
}

console.log(`done — ${importedCount} board(s) imported`);
