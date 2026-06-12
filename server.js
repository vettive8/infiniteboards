/**
 * Infinite Paper local server (v11-md).
 *
 * Serves the app/ folder and exposes a small API that reads and writes
 * boards as .md files on disk, so the boards are portable, git-trackable,
 * editable in VS Code, and reachable by AI tools.
 *
 * No dependencies — Node 18+ built-ins only.
 *   node server.js              (or: npm start, or start.bat)
 *
 * Config via env: PORT, HOST, NOTES_DIR.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, "app");

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || "127.0.0.1";
const NOTES_DIR =
  process.env.NOTES_DIR || "C:\\DevelopmentNotes\\InfinitePaper-Notes";
const BOARDS_DIR = path.join(NOTES_DIR, "boards");
const ATTACHMENTS_DIR = path.join(NOTES_DIR, "attachments");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ps1": "text/plain; charset=utf-8",
};

// --- markdown board format ----------------------------------------------

function slugify(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "board";
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseYamlString(value) {
  const text = String(value).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return text;
}

function serializeBoard(board) {
  const view = board.view || {};
  const lines = [
    "---",
    `id: ${board.id}`,
    `title: ${yamlString(board.title || "Untitled board")}`,
    `pinned: ${board.pinned ? "true" : "false"}`,
    `order: ${Number(board.order) || 0}`,
    `createdAt: ${Number(board.createdAt) || Date.now()}`,
    `updatedAt: ${Number(board.updatedAt) || Date.now()}`,
    `lastOpenedAt: ${Number(board.lastOpenedAt) || Date.now()}`,
    `revision: ${Number(board.revision) || 0}`,
    "view:",
    `  x: ${Number(view.x) || 0}`,
    `  y: ${Number(view.y) || 0}`,
    `  scale: ${Number(view.scale) || 1}`,
    "---",
    "",
    `# ${board.title || "Untitled board"}`,
    "",
  ];

  for (const note of board.notes || []) {
    if (note.type === "image") {
      const crop = note.crop || {};
      const cropStr = [crop.x, crop.y, crop.w, crop.h]
        .map((value, index) => {
          const n = Number(value);
          const fallback = index < 2 ? 0 : 1;
          return Math.round((Number.isFinite(n) ? n : fallback) * 1e4) / 1e4;
        })
        .join(",");
      const attrs = [
        `id=${note.id}`,
        "type=image",
        `x=${Math.round(note.x)}`,
        `y=${Math.round(note.y)}`,
        `width=${Math.round(note.width) || 320}`,
        `height=${Math.round(note.height) || 180}`,
        `rotation=${Number(note.rotation) || 0}`,
        `flipX=${note.flipX ? "true" : "false"}`,
        `flipY=${note.flipY ? "true" : "false"}`,
        `crop=${cropStr}`,
        `imageId=${note.imageId || ""}`,
        `mimeType=${note.mimeType || "image/png"}`,
      ].join(" ");
      lines.push(`<!-- ip-note ${attrs} -->`);
      lines.push("");
      lines.push("<!-- /ip-note -->", "");
    } else {
      const attrParts = [
        `id=${note.id}`,
        `type=${note.type === "markdown" ? "markdown" : "text"}`,
        `x=${Math.round(note.x)}`,
        `y=${Math.round(note.y)}`,
      ];
      if (note.type === "markdown") {
        attrParts.push(`width=${Math.round(note.width) || 380}`);
        attrParts.push(`height=${Math.round(note.height) || 420}`);
      }
      lines.push(`<!-- ip-note ${attrParts.join(" ")} -->`);
      lines.push(String(note.text || ""));
      lines.push("<!-- /ip-note -->", "");
    }
  }

  return lines.join("\n");
}

function parseBoard(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  const board = {
    id: "",
    title: "Untitled board",
    pinned: false,
    order: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
    revision: 0,
    view: { x: 0, y: 0, scale: 1 },
    notes: [],
  };

  if (fmMatch) {
    let inView = false;
    for (const raw of fmMatch[1].split("\n")) {
      if (/^\s/.test(raw) && inView) {
        const [k, v] = raw.trim().split(/:\s*/);
        if (k === "x") board.view.x = Number(v) || 0;
        if (k === "y") board.view.y = Number(v) || 0;
        if (k === "scale") board.view.scale = Number(v) || 1;
        continue;
      }
      inView = false;
      const idx = raw.indexOf(":");
      if (idx < 0) continue;
      const key = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (key === "view") {
        inView = true;
      } else if (key === "id") {
        board.id = value;
      } else if (key === "title") {
        board.title = parseYamlString(value);
      } else if (key === "pinned") {
        board.pinned = value === "true";
      } else if (
        ["order", "createdAt", "updatedAt", "lastOpenedAt", "revision"].includes(key)
      ) {
        board[key] = Number(value) || 0;
      }
    }
  }

  const noteRe = /<!-- ip-note (.*) -->\n([\s\S]*?)\n<!-- \/ip-note -->/g;
  let m;
  while ((m = noteRe.exec(text))) {
    const attrs = {};
    for (const pair of m[1].trim().split(/\s+/)) {
      const eq = pair.indexOf("=");
      if (eq > 0) attrs[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const body = m[2];
    if (attrs.type === "image") {
      const cropParts = String(attrs.crop || "0,0,1,1")
        .split(",")
        .map(Number);
      board.notes.push({
        id: attrs.id,
        type: "image",
        x: Number(attrs.x) || 0,
        y: Number(attrs.y) || 0,
        width: Number(attrs.width) || 320,
        height: Number(attrs.height) || 180,
        rotation: Number(attrs.rotation) || 0,
        flipX: attrs.flipX === "true",
        flipY: attrs.flipY === "true",
        crop: {
          x: Number.isFinite(cropParts[0]) ? cropParts[0] : 0,
          y: Number.isFinite(cropParts[1]) ? cropParts[1] : 0,
          w: Number.isFinite(cropParts[2]) ? cropParts[2] : 1,
          h: Number.isFinite(cropParts[3]) ? cropParts[3] : 1,
        },
        imageId: attrs.imageId || "",
        mimeType: attrs.mimeType || "image/png",
      });
    } else {
      const isMarkdown = attrs.type === "markdown";
      const note = {
        id: attrs.id,
        type: isMarkdown ? "markdown" : "text",
        x: Number(attrs.x) || 0,
        y: Number(attrs.y) || 0,
        text: body,
      };
      if (isMarkdown) {
        note.width = Number(attrs.width) || 380;
        note.height = Number(attrs.height) || 420;
      }
      board.notes.push(note);
    }
  }

  return board;
}

// --- board file index (id -> file) --------------------------------------

/** Map of board id -> absolute .md file path. */
const boardFiles = new Map();

async function indexBoards() {
  boardFiles.clear();
  let entries = [];
  try {
    entries = await fsp.readdir(BOARDS_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(BOARDS_DIR, name);
    try {
      const board = parseBoard(await fsp.readFile(file, "utf8"));
      if (board.id) boardFiles.set(board.id, file);
    } catch {
      /* skip unreadable board files */
    }
  }
}

/** Pick a free .md filename for a board, reusing its current file if any. */
function fileForBoard(board) {
  const existing = boardFiles.get(board.id);
  const desired = path.join(BOARDS_DIR, `${slugify(board.title)}.md`);
  if (existing && path.basename(existing) === path.basename(desired)) {
    return existing;
  }
  let candidate = desired;
  let n = 2;
  while (
    fs.existsSync(candidate) &&
    boardFiles.get(board.id) !== candidate &&
    !isSameBoardFile(candidate, board.id)
  ) {
    candidate = path.join(BOARDS_DIR, `${slugify(board.title)}-${n++}.md`);
  }
  return candidate;
}

function isSameBoardFile(file, id) {
  for (const [bid, f] of boardFiles) {
    if (f === file) return bid === id;
  }
  return false;
}

// --- request helpers -----------------------------------------------------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// --- file-change events (SSE) -------------------------------------------

const sseClients = new Set();
let watchTimer = null;

function broadcastBoardsChanged() {
  const payload = `event: boards-changed\ndata: ${Date.now()}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function watchBoards() {
  try {
    fs.watch(BOARDS_DIR, (event, filename) => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
        await indexBoards();
        console.log(
          `boards changed (${filename}) -> ${sseClients.size} live client(s)`
        );
        broadcastBoardsChanged();
      }, 150);
    });
  } catch (err) {
    console.warn("board folder watch unavailable:", err.message);
  }
}

// --- routing -------------------------------------------------------------

async function handleApi(req, res, pathname) {
  // GET /api/boards  -> index (metadata + note counts, no bodies)
  if (pathname === "/api/boards" && req.method === "GET") {
    const list = [];
    for (const [id, file] of boardFiles) {
      try {
        const board = parseBoard(await fsp.readFile(file, "utf8"));
        list.push({
          id,
          title: board.title,
          pinned: board.pinned,
          order: board.order,
          createdAt: board.createdAt,
          updatedAt: board.updatedAt,
          lastOpenedAt: board.lastOpenedAt,
          revision: board.revision,
          view: board.view,
          noteCount: board.notes.length,
        });
      } catch {
        /* skip */
      }
    }
    return sendJson(res, 200, { boards: list });
  }

  // POST /api/boards  -> create/replace a board (id taken from body)
  if (pathname === "/api/boards" && req.method === "POST") {
    return saveBoard(req, res);
  }

  // POST /api/import?name=<filename>  -> create a new board from a dropped
  // markdown file. An Infinite Paper board file is parsed as-is; any other
  // markdown file becomes a board holding the whole document as one note.
  if (pathname === "/api/import" && req.method === "POST") {
    try {
      const raw = (await readBody(req)).toString("utf8");
      const name = new url.URL(req.url, "http://localhost").searchParams.get(
        "name"
      );
      const now = Date.now();
      let board;
      if (/<!--\s*ip-note\b/.test(raw)) {
        board = parseBoard(raw);
      } else {
        const title =
          String(name || "")
            .replace(/\.md$/i, "")
            .replace(/[_-]+/g, " ")
            .trim() || "Imported note";
        board = {
          id: "",
          title,
          pinned: false,
          order: 0,
          createdAt: now,
          updatedAt: now,
          lastOpenedAt: now,
          revision: 1,
          view: { x: 0, y: 0, scale: 1 },
          notes: [
            { id: crypto.randomUUID(), type: "markdown", x: 0, y: 0, text: raw },
          ],
        };
      }
      board.id = crypto.randomUUID(); // a fresh id so it never collides
      board.createdAt = now;
      board.updatedAt = now;
      board.lastOpenedAt = now;
      const file = fileForBoard(board);
      await fsp.writeFile(file, serializeBoard(board), "utf8");
      boardFiles.set(board.id, file);
      return sendJson(res, 200, { board });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  const boardMatch = pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (boardMatch) {
    const id = decodeURIComponent(boardMatch[1]);

    if (req.method === "GET") {
      const file = boardFiles.get(id);
      if (!file) return sendJson(res, 404, { error: "board not found" });
      try {
        const board = parseBoard(await fsp.readFile(file, "utf8"));
        return sendJson(res, 200, { board });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === "PUT") {
      return saveBoard(req, res, id);
    }

    if (req.method === "DELETE") {
      const file = boardFiles.get(id);
      if (file) {
        await fsp.rm(file, { force: true });
        boardFiles.delete(id);
        broadcastBoardsChanged();
      }
      return sendJson(res, 200, { ok: true });
    }
  }

  // POST /api/attachments?id=<imageId>&ext=png  -> store an image file
  if (pathname === "/api/attachments" && req.method === "POST") {
    const query = new url.URL(req.url, "http://localhost").searchParams;
    const ext = (query.get("ext") || "png").replace(/[^a-z0-9]/gi, "") || "png";
    const id = (query.get("id") || crypto.randomUUID()).replace(
      /[^a-z0-9-]/gi,
      ""
    );
    try {
      const bytes = await readBody(req);
      const name = `${id}.${ext}`;
      await fsp.writeFile(path.join(ATTACHMENTS_DIR, name), bytes);
      return sendJson(res, 200, {
        imageId: id,
        src: `attachments/${name}`,
        mimeType: CONTENT_TYPES[`.${ext}`] || "image/png",
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // GET /api/events  -> server-sent events for external file changes
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  return sendJson(res, 404, { error: "unknown endpoint" });
}

/** Merge an incoming (possibly partial) board over what is on disk. */
function mergeBoard(base, incoming) {
  const fallback = base || {
    id: incoming.id,
    title: "Untitled board",
    pinned: false,
    order: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
    revision: 0,
    view: { x: 0, y: 0, scale: 1 },
    notes: [],
  };
  const pick = (key) => (incoming[key] != null ? incoming[key] : fallback[key]);
  return {
    id: incoming.id,
    title: pick("title"),
    pinned: pick("pinned"),
    order: pick("order"),
    createdAt: pick("createdAt"),
    updatedAt: pick("updatedAt"),
    lastOpenedAt: pick("lastOpenedAt"),
    revision: pick("revision"),
    view: pick("view"),
    notes: pick("notes"),
  };
}

async function saveBoard(req, res, idFromPath) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  const incoming = payload && payload.board ? payload.board : payload;
  if (!incoming || typeof incoming.id !== "string") {
    return sendJson(res, 400, { error: "board.id is required" });
  }
  if (idFromPath && incoming.id !== idFromPath) {
    return sendJson(res, 400, { error: "board id mismatch" });
  }

  try {
    const previous = boardFiles.get(incoming.id);
    let base = null;
    if (previous) {
      try {
        base = parseBoard(await fsp.readFile(previous, "utf8"));
      } catch {
        base = null;
      }
    }
    const board = mergeBoard(base, incoming);
    const file = fileForBoard(board);
    const content = serializeBoard(board);

    // Idempotent: skip the write (and the mtime/watch churn) when the
    // file already holds exactly this content.
    let unchanged = false;
    if (previous === file) {
      try {
        unchanged = (await fsp.readFile(file, "utf8")) === content;
      } catch {
        unchanged = false;
      }
    }
    if (previous && previous !== file) {
      await fsp.rm(previous, { force: true });
    }
    if (!unchanged) {
      await fsp.writeFile(file, content, "utf8");
    }
    boardFiles.set(board.id, file);
    return sendJson(res, 200, {
      ok: true,
      file: path.basename(file),
      changed: !unchanged,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function serveStatic(req, res, pathname) {
  let baseDir = APP_DIR;
  let rel = pathname;

  if (pathname.startsWith("/attachments/")) {
    baseDir = ATTACHMENTS_DIR;
    rel = pathname.slice("/attachments".length);
  }
  if (rel === "/" || rel === "") rel = "/index.html";

  const target = path.join(baseDir, path.normalize(rel));
  if (!target.startsWith(baseDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(target).toLowerCase()] ||
        "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(
    new url.URL(req.url, "http://localhost").pathname
  );
  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

// --- startup -------------------------------------------------------------

async function start() {
  await fsp.mkdir(BOARDS_DIR, { recursive: true });
  await fsp.mkdir(ATTACHMENTS_DIR, { recursive: true });
  await indexBoards();
  watchBoards();
  server.listen(PORT, HOST, () => {
    console.log(`Infinite Paper  ->  http://${HOST}:${PORT}`);
    console.log(`Notes directory ->  ${NOTES_DIR}`);
    console.log(`Boards indexed  ->  ${boardFiles.size}`);
  });
}

start();
