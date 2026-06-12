# Infinite Paper — app

An infinite white-paper canvas for spatial note-taking — text notes, pasted
screenshots, and rendered markdown documents arranged freely on a zoomable
canvas. Each board is stored as a `.md` file on disk, served and saved by a
small local Node server (`server.js` in the repo root).

## Run it locally

**Requirements:** Node.js 18+. **No `npm install`** — the app is
dependency-free (plain HTML/CSS/JS + a zero-dependency Node server).

Open a terminal **in the repo folder** and start the server:

```
cd /d C:\DevelopmentNotes\InfinitePaper
node server.js
```

…or just double-click **`start.bat`** (it cd's itself, starts the server, and
opens the browser). `npm start` works too. Leave the window open while you use
the app — closing it stops the server.

Then open **http://127.0.0.1:4321**.

### Configuration (environment variables)

| Var | Default | What it does |
|-----|---------|--------------|
| `PORT` | `4321` | Port the server listens on |
| `HOST` | `127.0.0.1` | Host to bind to |
| `NOTES_DIR` | `C:\DevelopmentNotes\InfinitePaper-Notes` | Where boards are stored |

Run a second isolated instance (own port + own notes):

```powershell
# PowerShell
$env:PORT='4322'; $env:NOTES_DIR='C:\path\to\other-notes'; node server.js
```

Your boards live **outside** the repo, in `NOTES_DIR` — one `.md` file per
board under `boards/`, and pasted images as files under `attachments/`.
Nothing here is committed to git.

Images are referenced from the board's `.md` and stored as server-side files,
so they show in **any** browser and travel with the notes folder — same as
text and markdown notes. (A browser-local IndexedDB cache is kept as a
fallback; images pasted before this change self-migrate to a file the first
time you open their board in the browser that originally held them.)

## Features

- **Canvas:** click empty space to place a text note; drag (or hold Space) to
  pan; `Ctrl`+wheel to zoom.
- **Boards** (`Shift`+`Tab` opens the overlay): switch, pin/unpin, reorder
  (hold + drag), rename (double-click or `F2`), delete (right-click → *Delete
  board*, or highlight + `Delete`). Arrow keys navigate, `Shift`+arrows
  multi-select, `Enter` opens.
- **New boards open in their own browser tab** — `+ New board`, or `Shift`+`Tab`
  then `N`. Middle-click a board to open it in a new tab. The URL carries
  `?board=<id>`, so a refresh keeps you on the same board.
- **Images:** paste a screenshot (`Ctrl`+`V`) → image note; resize, rotate
  (`R`), mirror (`M`), and crop.
- **Markdown notes:** drop a `.md` file onto the canvas → rendered document with
  Preview / Markdown tabs; resize via the corner grip; scroll the document
  inside it; drag its body to move it.
- **Other:** Find (`Ctrl`+`F`), tab-title rename (`Tab`), copy/paste notes,
  unbounded undo/redo (`Ctrl`+`Z` / `Ctrl`+`Y`), and redline spell suggestions.

## Storage

Each board is a Markdown file (YAML front-matter + one `<!-- ip-note … -->`
block per note), read and written by `server.js`. Edit a board's `.md` in your
editor and the canvas live-reloads; open the same board in two tabs and edits
sync between them.

See the repo root `README.md` for repository layout and roadmap.
