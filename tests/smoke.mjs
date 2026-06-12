/**
 * tests/smoke.mjs — Infinite Paper smoke test.
 *
 * Run via the app-test skill:  node <skill>/runner.mjs <thisRepo>
 *
 * The app-test runner supplies the Playwright `page`; this file has no
 * dependencies. It launches the server on a spare port against a throwaway
 * notes directory, so it never touches the real InfinitePaper-Notes data.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_NOTES = path.join(here, ".tmp-notes");
const BOARDS_DIR = path.join(TEST_NOTES, "boards");
const PORT = 4399;

export const config = {
  start: "node server.js",
  cwd: ".",
  url: `http://127.0.0.1:${PORT}`,
  env: { PORT: String(PORT), NOTES_DIR: TEST_NOTES },
  permissions: ["clipboard-read", "clipboard-write"],
  slowMo: 380, // slow enough to watch each action live
  stepPauseMs: 1100, // pause after each step so the result is visible
  readyTimeoutMs: 20000,
};

export function setup() {
  fs.rmSync(TEST_NOTES, { recursive: true, force: true });
}

export function teardown() {
  fs.rmSync(TEST_NOTES, { recursive: true, force: true });
}

async function waitFor(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function boardFiles() {
  if (!fs.existsSync(BOARDS_DIR)) return [];
  return fs.readdirSync(BOARDS_DIR).map((f) => path.join(BOARDS_DIR, f));
}

function fileWithNote(text) {
  return boardFiles().find((f) => fs.readFileSync(f, "utf8").includes(text));
}

export async function run({ page, step, expect, config }) {
  await step("app loads and the server seeds a board file", async () => {
    await page.goto(config.url);
    await page.waitForSelector("#paper");
    expect(
      (await page.locator(".server-error").count()) === 0,
      "a 'cannot reach server' message is showing"
    );
    await waitFor(() => boardFiles().length >= 1, 8000, "a board .md file on disk");
  });

  await step("clicking the canvas creates a text note", async () => {
    await page.mouse.click(640, 430);
    await page.keyboard.type("smoke test note alpha", { delay: 45 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const count = await page.locator(".note").count();
    expect(count >= 1, `expected at least one note, found ${count}`);
    const text = await page.locator(".note").first().innerText();
    expect(text.includes("smoke test note alpha"), `note text was: "${text}"`);
  });

  await step("the note is written into the board .md file", async () => {
    await waitFor(
      () => Boolean(fileWithNote("smoke test note alpha")),
      5000,
      "the note text to appear in a .md file"
    );
    const md = fs.readFileSync(fileWithNote("smoke test note alpha"), "utf8");
    expect(md.includes("<!-- ip-note"), "the .md file has no note marker");
  });

  await step("editing the .md on disk live-updates the canvas", async () => {
    const file = fileWithNote("smoke test note alpha");
    expect(Boolean(file), "could not find the board file holding the note");
    const md = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, md.replace("smoke test note alpha", "edited on disk beta"));
    await waitFor(
      async () =>
        (await page.locator(".note").first().innerText()).includes("edited on disk beta"),
      6000,
      "the canvas to reflect the external edit"
    );
  });

  await step("Shift+Tab opens the board overlay", async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Shift+Tab");
    await page.waitForSelector(".board-overlay:not([hidden])", { timeout: 4000 });
    expect(
      (await page.locator(".board-row").count()) >= 1,
      "the overlay has no board rows"
    );
  });

  await step("+ New board opens a new board tab in rename mode", async () => {
    const popupPromise = page.context().waitForEvent("page", { timeout: 8000 });
    await page.locator(".board-new-button").click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await popup.waitForSelector(".board-rename-input", { timeout: 8000 });
    const focused = await popup.evaluate(
      () =>
        document.activeElement?.classList?.contains("board-rename-input") || false
    );
    expect(focused, "the new tab did not open in rename mode");
    await popup.keyboard.type("Second Board", { delay: 30 });
    await popup.keyboard.press("Enter");
    await popup.waitForTimeout(400);
    await popup.close();

    // The new board lives on the shared server — reload so this page sees it.
    await page.reload();
    await page.waitForSelector(".board-overlay:not([hidden])", { timeout: 4000 });
    expect(
      (await page.locator(".board-row").count()) >= 2,
      "the second board was not created"
    );
  });

  await step("pressing N opens a new board in its own browser tab", async () => {
    // The board overlay is still open from the previous step.
    const popupPromise = page.context().waitForEvent("page", { timeout: 8000 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("n");
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");

    // The new tab spawns its own board and opens straight into rename.
    await popup.waitForSelector(".board-rename-input", { timeout: 8000 });
    const focused = await popup.evaluate(
      () =>
        document.activeElement?.classList?.contains("board-rename-input") || false
    );
    expect(focused, "the new tab did not open in board-rename mode");
    await popup.close();
  });

  await step("dragging a board reorders the list", async () => {
    const order = () =>
      page
        .locator(".board-row")
        .evaluateAll((els) => els.map((e) => e.dataset.boardId));
    const before = await order();
    expect(before.length >= 2, "need two or more boards to reorder");
    const box = await page
      .locator(".board-row")
      .first()
      .locator(".board-select")
      .boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 2.2, {
      steps: 14,
    });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await order();
    expect(
      JSON.stringify(after) !== JSON.stringify(before),
      `board order did not change (${before} -> ${after})`
    );
  });

  await step("middle-clicking a board opens it in a new browser tab", async () => {
    // The board overlay is still open from the drag step.
    const targetRow = page.locator(".board-row").nth(1);
    const targetId = await targetRow.getAttribute("data-board-id");
    expect(Boolean(targetId), "could not read a board id from the overlay");

    const urlBefore = await page.evaluate(() => location.href);

    // Middle button (scroll-wheel) — the web's standard "open in new tab".
    const popupPromise = page.context().waitForEvent("page", { timeout: 8000 });
    await targetRow.locator(".board-select").click({ button: "middle" });
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");

    expect(
      popup.url().includes(`board=${targetId}`),
      `new tab opened the wrong URL: ${popup.url()}`
    );
    await popup.waitForSelector("#paper", { timeout: 8000 });
    const popupBoard = await popup.evaluate(() =>
      new URLSearchParams(location.search).get("board")
    );
    expect(
      popupBoard === targetId,
      `new tab is on board "${popupBoard}", expected "${targetId}"`
    );
    await popup.close();

    // The original tab must not have navigated anywhere.
    const urlAfter = await page.evaluate(() => location.href);
    expect(
      urlAfter === urlBefore,
      `the original tab navigated (${urlBefore} -> ${urlAfter})`
    );
  });

  await step("pasting an image creates an image note", async () => {
    await page.keyboard.press("Shift+Tab"); // close the board overlay
    await page.waitForTimeout(300);
    // Put a 240x240 four-colour-quadrant PNG on the clipboard.
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      const quads = [
        ["#e2392f", 0, 0],
        ["#27a44d", 120, 0],
        ["#2b74d6", 0, 120],
        ["#f6b500", 120, 120],
      ];
      for (const [color, x, y] of quads) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 120, 120);
      }
      const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
    });
    await page.keyboard.press("Control+V");
    await waitFor(
      async () => (await page.locator(".image-note").count()) >= 1,
      6000,
      "an image note to appear on the canvas"
    );
    await page.waitForTimeout(500); // settle — a duplicate would show now
    const imageCount = await page.locator(".image-note").count();
    expect(imageCount === 1, `expected exactly one image note, got ${imageCount}`);
  });

  await step("cropping an image trims it to the dragged region", async () => {
    const imageNote = page.locator(".image-note").first();
    await imageNote.click(); // select it so its controls show
    await page.waitForTimeout(200);
    const before = await imageNote.boundingBox();

    await imageNote.locator(".image-crop-control").click();
    await page.waitForTimeout(300);

    // Drag a box over roughly the top-left quadrant of the image.
    const sx = before.x + before.width * 0.12;
    const sy = before.y + before.height * 0.12;
    const ex = before.x + before.width * 0.52;
    const ey = before.y + before.height * 0.52;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(1500); // long enough for any save echo to settle

    const after = await imageNote.boundingBox();
    expect(
      after.width < before.width * 0.7,
      `image was not cropped narrower (${Math.round(before.width)} -> ${Math.round(
        after.width
      )})`
    );

    // The .md must record a real, non-default crop region.
    const imageLine = boardFiles()
      .flatMap((f) => fs.readFileSync(f, "utf8").split("\n"))
      .find((line) => line.includes("type=image"));
    const cropMatch = (imageLine || "").match(/crop=([^ ]+)/);
    expect(
      Boolean(cropMatch) && cropMatch[1] !== "0,0,1,1",
      `crop not applied in the .md (crop=${cropMatch ? cropMatch[1] : "none"})`
    );
  });

  await step("dropping an Infinite Paper .md file imports it as a board", async () => {
    const boardMd = [
      "---",
      "id: dropped-source-id",
      'title: "Dropped Board"',
      "pinned: false",
      "order: 0",
      "createdAt: 1",
      "updatedAt: 1",
      "lastOpenedAt: 1",
      "revision: 1",
      "view:",
      "  x: 0",
      "  y: 0",
      "  scale: 1",
      "---",
      "",
      "# Dropped Board",
      "",
      "<!-- ip-note id=dropnote1 type=text x=40 y=40 -->",
      "imported note from a dropped file",
      "<!-- /ip-note -->",
      "",
    ].join("\n");
    const before = boardFiles().length;

    await page.evaluate((md) => {
      const file = new File([md], "dropped-board.md", { type: "text/markdown" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.getElementById("viewport") || document.body;
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            clientX: 700,
            clientY: 400,
          })
        );
      }
    }, boardMd);

    await waitFor(
      () => boardFiles().length > before,
      6000,
      "a new board file from the dropped import"
    );
    await waitFor(
      async () =>
        (await page.locator(".note").allInnerTexts()).some((t) =>
          t.includes("imported note from a dropped file")
        ),
      6000,
      "the imported board to open with its note on the canvas"
    );
  });

  await step("a dropped plain .md file imports as a rendered markdown board", async () => {
    const before = boardFiles().length;
    await page.evaluate(() => {
      const file = new File(
        ["# Partner SOW\n\nplain markdown body text"],
        "Partner_SOW.md",
        { type: "text/markdown" }
      );
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.getElementById("viewport") || document.body;
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            clientX: 700,
            clientY: 400,
          })
        );
      }
    });
    await waitFor(
      () => boardFiles().length > before,
      6000,
      "a new board file from the plain-markdown import"
    );
    // The imported note is a markdown note, rendered as a document.
    await waitFor(
      async () =>
        (await page.locator(".markdown-note .md-body h1").count()) >= 1,
      6000,
      "the imported markdown to render an <h1> heading"
    );
    const preview = await page
      .locator(".markdown-note .md-body")
      .first()
      .innerText();
    expect(
      preview.includes("plain markdown body text"),
      `rendered body is missing the text: ${preview}`
    );
    expect(
      !preview.includes("# Partner SOW"),
      "the heading still shows a raw '#' — it did not render"
    );

    // The Markdown tab flips the note to its raw source.
    await page
      .locator(".markdown-note .md-tab")
      .filter({ hasText: "Markdown" })
      .first()
      .click();
    await page.waitForTimeout(400);
    const raw = await page
      .locator(".markdown-note .md-body")
      .first()
      .innerText();
    expect(
      raw.includes("# Partner SOW"),
      `the Markdown tab should show the raw source: ${raw}`
    );
  });

  await step("markdown note: resize persists, body drag moves, click never selects", async () => {
    const note = page.locator(".markdown-note").first();
    // Make sure we're on the Preview tab (the import step left it on Markdown).
    await note.locator(".md-tab").filter({ hasText: "Preview" }).first().click();
    await page.waitForTimeout(300);

    // --- resize via the bottom-right grip ---
    const before = await note.boundingBox();
    const grip = await note.locator(".md-resize-handle").boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 150, grip.y + 110, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const resized = await note.boundingBox();
    expect(
      resized.width > before.width + 60,
      `resize did not widen the note (${Math.round(before.width)} -> ${Math.round(
        resized.width
      )})`
    );

    // The new size must reach the .md file.
    await waitFor(
      () => {
        const file = boardFiles().find((f) =>
          fs.readFileSync(f, "utf8").includes("type=markdown")
        );
        return file && /type=markdown[^\n]*width=/.test(fs.readFileSync(file, "utf8"));
      },
      5000,
      "width= to be written into the markdown note's marker"
    );

    // --- a plain click on the preview body must NOT select the note ---
    const body = await note.locator(".md-body").boundingBox();
    await page.mouse.click(body.x + body.width / 2, body.y + 40);
    await page.waitForTimeout(250);
    expect(
      !(await note.evaluate((el) => el.classList.contains("is-selected"))),
      "clicking the preview body selected the note — it must not"
    );

    // --- dragging the preview body moves the whole note ---
    const posBefore = await note.boundingBox();
    await page.mouse.move(body.x + body.width / 2, body.y + 40);
    await page.mouse.down();
    await page.mouse.move(body.x + body.width / 2 + 170, body.y + 150, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const posAfter = await note.boundingBox();
    expect(
      Math.abs(posAfter.x - posBefore.x) > 60,
      `dragging the body did not move the note (${Math.round(
        posBefore.x
      )} -> ${Math.round(posAfter.x)})`
    );
  });

  await step("writing several notes keeps each note's text intact", async () => {
    // A new board opens in its own tab — do the writing there, on a fresh
    // empty board.
    if (!(await page.locator(".board-overlay:not([hidden])").count())) {
      await page.keyboard.press("Shift+Tab");
      await page.waitForSelector(".board-overlay:not([hidden])", { timeout: 4000 });
    }
    const popupPromise = page.context().waitForEvent("page", { timeout: 8000 });
    await page.locator(".board-new-button").click();
    const writePage = await popupPromise;
    await writePage.waitForLoadState("domcontentloaded");
    await writePage.waitForSelector(".board-rename-input", { timeout: 8000 });
    await writePage.keyboard.type("Writing Test", { delay: 20 });
    await writePage.keyboard.press("Enter");
    await writePage.keyboard.press("Shift+Tab"); // close the overlay
    await writePage.waitForTimeout(400);

    const texts = ["alpha note one", "bravo note two", "charlie note three"];
    for (let index = 0; index < texts.length; index += 1) {
      await writePage.mouse.click(300 + index * 250, 300);
      await writePage.keyboard.type(texts[index], { delay: 25 });
      await writePage.keyboard.press("Escape");
      await writePage.waitForTimeout(400);
    }
    await writePage.waitForTimeout(1800); // let every save + live-reload echo settle

    const onCanvas = await writePage.locator(".note").allInnerTexts();
    for (const wanted of texts) {
      expect(
        onCanvas.some((actual) => actual.trim() === wanted),
        `note "${wanted}" is missing or garbled — canvas has: ${JSON.stringify(
          onCanvas
        )}`
      );
    }
    await writePage.close();
  });
}
