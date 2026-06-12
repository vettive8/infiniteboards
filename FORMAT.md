# Infinite Paper board file format (v11-md)

Each board is **one `.md` file** in the notes directory. Boards are the
durable source of truth — portable, git-trackable, editable in VS Code, and
readable by AI tools.

## Notes directory layout

```
InfinitePaper-Notes/          (NOTES_DIR — outside the app repo)
  boards/
    inbox.md
    business-ideas.md
  attachments/
    img-3f9a2b1c.png
```

The notes directory is data, separate from the app repo (the tool). Its
location is set by the `NOTES_DIR` env var; default
`C:\DevelopmentNotes\InfinitePaper-Notes`.

A board's **filename** is a slug of its title (`Business Ideas` ->
`business-ideas.md`); on a slug collision a short id suffix is added. The
canonical identity is the `id` in frontmatter, never the filename — the app
finds boards by `id` and renames files when titles change.

## Board file structure

```md
---
id: 3f9a2b1c-...
title: "Inbox"
pinned: true
createdAt: 1778836932000
updatedAt: 1778836999000
lastOpenedAt: 1778837000000
revision: 7
view:
  x: 770
  y: 1389
  scale: 1.49
---

# Inbox

<!-- ip-note id=n1 type=text x=420 y=300 -->
I need to organize my notes.
<!-- /ip-note -->

<!-- ip-note id=n2 type=image x=900 y=520 width=500 height=260 rotation=0 flipX=false flipY=false imageId=3f9a2b1c mimeType=image/png -->

<!-- /ip-note -->
```

### Frontmatter

YAML between the opening and closing `---`. Holds board-level metadata:
`id`, `title` (always double-quoted), `pinned`, the `createdAt` /
`updatedAt` / `lastOpenedAt` millisecond timestamps, `revision`, and the
nested `view` (`x`, `y`, `scale`) — the canvas pan/zoom.

The `# <title>` heading after the frontmatter is cosmetic (it makes the
file render nicely on GitHub / in preview); the app ignores it.

### Notes

Each note is an HTML comment marker, its body, then a closing marker. The
marker is on one line, `key=value` space-separated. The body is the note's
content, written verbatim — so a text note's markdown (`#`, `**`, fenced
code blocks) round-trips untouched.

- **Text note** — marker fields: `id`, `type=text`, `x`, `y`. Body: the
  note text.
- **Image note** — marker fields: `id`, `type=image`, `x`, `y`, `width`,
  `height`, `rotation`, `flipX`, `flipY`, `imageId`, `mimeType`. Body is
  empty for now.

> Image *bytes* still live in the browser's `IndexedDB` (keyed by
> `imageId`) in this phase — only board structure and text notes are
> file-backed yet. A follow-up moves images to real files in
> `attachments/`, at which point image notes gain a `src` path and a
> `![](src)` body so they preview correctly.

### Known limitation

Note bodies are read up to the first `<!-- /ip-note -->`. A text note whose
body contains that exact literal token would parse early. The token uses an
`ip-` prefix specifically to make this effectively never happen with
human-written notes; a future format revision may length-prefix bodies.
