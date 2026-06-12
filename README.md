# InfiniteBoards

InfiniteBoards is an infinite white-paper canvas for spatial note-taking: a calm, fast surface for capturing and arranging text notes, screenshots, and markdown documents.

This public version is based on the newest local Infinite Paper Lab build and is being evolved toward the InfiniteBoards product direction: project boards, architecture maps, work logs, decision logs, prompt logs, and AI-readable board documents.

## Repository Layout

- `app/` - the application: HTML, CSS, JavaScript, no build step.
- `server.js` - the local Node server that serves `app/` and stores each board as a `.md` file on disk.
- `tests/smoke.mjs` - browser smoke test.
- `tools/` - one-off scripts, for example importing a backup export.
- `web/` - an earlier hosted experiment with Supabase auth and cloud sync. Parked for now.

## Run Locally

Requirements:

- Node.js 18+
- No `npm install` required for the local app

```powershell
node server.js
```

Then open:

```txt
http://127.0.0.1:4321
```

Boards are stored in the notes directory set by `NOTES_DIR`. By default:

```txt
C:\DevelopmentNotes\InfinitePaper-Notes
```

## What It Does

- Place text notes on an infinite canvas.
- Paste screenshots and image notes.
- Drop `.md` files onto the board as rendered markdown documents.
- Manage boards with the `Shift+Tab` overlay.
- Open boards in separate browser tabs.
- Store each board as a readable markdown file.
- Live-reload if a board file is edited externally.

## Product Direction

- Project-level boards
- Work, decision, and prompt logs
- Markdown import/export
- AI-assisted mind maps and architecture boards
- Future database-backed version while preserving markdown export
