#!/usr/bin/env node

// accord-tui — live per-model column viewer for one accord-core council run.
//
// Reads runs/<runId>/<modelName>.jsonl (delta/usage events) + __meta.jsonl
// written by the accord-core MCP server, and renders one column per model.
//
// Two renderers:
//   - OpenTUI (used when it can initialize its native binding — i.e. Bun).
//   - A dependency-free ANSI fallback for plain Node (where OpenTUI's native
//     FFI isn't shipped yet), so the TUI works on any runtime.

import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const runsDir = process.env.COUNCIL_RUNS_DIR || join(homedir(), ".local", "share", "accord-core", "runs");
const runId = process.argv[2];
if (!runId) {
  console.error("usage: accord-tui <runId>");
  process.exit(1);
}

const dir = join(runsDir, runId);
const POLL_MS = 300;
const COLORS = ["#7dd3fc", "#fbbf24", "#a7f3d0", "#f9a8d4", "#c4b5fd", "#e2e8f0"];
const ANSI_COLORS = ["36", "33", "32", "35", "94", "37"]; // cyan, yellow, green, magenta, blue, white

// ─── File reading ────────────────────────────────────────────────────────────
function readStatus() {
  try {
    const lines = readFileSync(join(dir, "__meta.jsonl"), "utf-8").split("\n").filter(Boolean);
    const evt = JSON.parse(lines[lines.length - 1]);
    return evt.status || "running";
  } catch {
    return "waiting";
  }
}

function readMetaModels() {
  try {
    const lines = readFileSync(join(dir, "__meta.jsonl"), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const evt = JSON.parse(line);
      if (Array.isArray(evt.councillors)) return evt.councillors.map((c) => c.model);
    }
  } catch {}
  return null;
}

const fileFor = (model) => model.replace(/[^a-z0-9_-]/gi, "_") + ".jsonl";
// Track last-read byte offset per file so we only re-parse new lines (no full
// re-read every poll → fixes the stall and keeps streaming smooth).
const offsets = new Map();
const accum = new Map(); // model -> full accumulated text
function readModels(models) {
  const out = {};
  for (const model of models) {
    const f = join(dir, fileFor(model));
    let prev = offsets.get(model) || 0;
    let content = accum.get(model) || "";
    try {
      const full = readFileSync(f, "utf-8");
      const newChunk = full.slice(prev);
      prev = full.length;
      offsets.set(model, prev);
      for (const line of newChunk.split("\n")) {
        try {
          const evt = JSON.parse(line);
          if (evt.delta) content += evt.delta;
        } catch {}
      }
      accum.set(model, content);
    } catch {
      // file may not exist yet
    }
    out[model] = content;
  }
  return out;
}

// Model names present on disk (for when __meta.jsonl hasn't been written yet).
function readModelFiles() {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && f !== "__meta.jsonl")
      .map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

// ─── Renderer: OpenTUI (Bun) ────────────────────────────────────────────────
// Uses the class-based renderables (BoxRenderable/TextRenderable + .add()).
// The functional Box()/Text() proxies render blanks in this OpenTUI version.
async function createOpenTuiRenderer() {
  const { createCliRenderer, BoxRenderable, TextRenderable } = await import("@opentui/core");
  const renderer = await createCliRenderer({ targetFps: 20 });
  const root = new BoxRenderable(renderer, {
    flexDirection: "row", alignItems: "stretch",
    width: "100%", height: "100%", flexGrow: 1, gap: 1,
  });
  renderer.root.add(root);
  const textByModel = new Map();

  const ensureColumn = (model, i) => {
    if (textByModel.has(model)) return;
    const color = COLORS[i % COLORS.length];
    const text = new TextRenderable(renderer, { content: "", fg: color });
    const box = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1, flexShrink: 1, flexBasis: 0, // equal, stable widths — never collapse
      minWidth: 8,
      border: true, borderColor: color, paddingX: 1,
      title: model.split("/").pop(),
    });
    box.add(text);
    root.add(box);
    textByModel.set(model, text);
  };

  return {
    name: "opentui",
    setTitle(t) { try { root.title = ` ${t} `; } catch {} },
    ensureColumn,
    setColumn(model, text) { const n = textByModel.get(model); if (n) n.content = text; },
    render() { renderer.requestRender(); },
    destroy() { try { renderer.destroy?.(); } catch {} },
  };
}

// ─── Renderer: ANSI (plain Node, no deps) ───────────────────────────────────
function createAnsiRenderer() {
  let title = "";
  const ansiByModel = new Map();

  const wordWrap = (text, width) => {
    const lines = [];
    let cur = "";
    for (const w of text.split(/\s+/).filter(Boolean)) {
      if (cur && cur.length + 1 + w.length > width) { lines.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    }
    if (cur) lines.push(cur);
    return lines;
  };

  const render = (models) => {
    const w = process.stdout.columns || 100;
    const h = (process.stdout.rows || 20) - 3;
    const n = Math.max(models.length, 1);
    const colw = Math.max(Math.floor((w - n - 1) / n), 12);
    const content = readModels(models);
    for (let i = 0; i < models.length; i++) if (!ansiByModel.has(models[i])) ansiByModel.set(models[i], i);

    const cols = models.map((m) => wordWrap(content[m] || "", colw - 2));
    const maxRows = Math.max(...cols.map((c) => c.length), 1);
    const rows = Math.max(Math.min(h, maxRows), 0);

    let out = "";
    for (let row = 0; row < rows; row++) {
      for (let m = 0; m < models.length; m++) {
        const c = ANSI_COLORS[ansiByModel.get(models[m]) % ANSI_COLORS.length];
        out += `\x1b[${c}m ${(cols[m][row] || "").padEnd(colw - 2)} \x1b[0m`;
        if (m < models.length - 1) out += "\x1b[90m│\x1b[0m";
      }
      if (row + 1 < rows) out += "\n";
    }

    let head = "";
    for (let m = 0; m < models.length; m++) {
      const c = ANSI_COLORS[ansiByModel.get(models[m]) % ANSI_COLORS.length];
      head += `\x1b[${c};1m${models[m].split("/").pop().slice(0, colw).padEnd(colw + 2)}\x1b[0m`;
      if (m < models.length - 1) head += "\x1b[90m│\x1b[0m";
    }

    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`\x1b[1m${title}\x1b[0m\n${head}\n${out}`);
    process.stdout.write("\x1b[?25l");
  };

  return {
    name: "ansi",
    setTitle(t) { title = ` ${t} `; },
    ensureColumn() {},
    setColumn() {},
    render(models) { render(models); },
    destroy() { try { process.stdout.write("\x1b[?25h\x1b[0m"); } catch {} },
  };
}

// ─── Choose renderer ────────────────────────────────────────────────────────
async function pickRenderer() {
  try {
    const r = await createOpenTuiRenderer();
    return r;
  } catch {
    const r = createAnsiRenderer();
    process.stderr.write("accord-tui: OpenTUI unavailable on this runtime — using ANSI fallback.\n");
    return r;
  }
}

const r = await pickRenderer();
let lastDirty = "";
let started = false;

function tick() {
  const status = readStatus();
  const meta = readMetaModels();
  let effective = (meta && meta.length) ? meta : readModelFiles();
  effective = effective.filter(Boolean);

  for (let i = 0; i < effective.length; i++) r.ensureColumn(effective[i], i);
  const content = readModels(effective);

  // Skip a repaint if nothing changed (fewer full reflushes → less stalling).
  const dirty = effective.map((m) => `${m}=${content[m]?.length ?? 0}`).join("|");
  const isDirty = dirty !== lastDirty;
  lastDirty = dirty;

  const title = `${runId} · ${status}${stateHint(status)}`;
  r.setTitle(title);

  if (isDirty || !started) {
    for (const m of effective) r.setColumn(m, content[m] || "(waiting for tokens...)");
    r.render(r.name === "ansi" ? effective : undefined);
    started = true;
  }
}

function stateHint(status) {
  if (status === "done") return "  — complete. Press Ctrl+C to exit.";
  if (status === "error") return "  — errored. Press Ctrl+C to exit.";
  return "";
}

tick();
setInterval(tick, POLL_MS);

// Once "done", we simply stop repainting (nothing changes) and keep the last
// frame on screen. OpenTUI exits on Ctrl+C by default; the ANSI fallback gets
// an explicit stdin listener so the window doesn't just vanish.
if (r.name !== "opentui") {
  try {
    process.stdin?.setRawMode?.(true);
    process.stdin?.resume?.();
    process.stdin?.on?.("data", (d) => {
      if (d[0] === 3 || d[0] === 113) { try { r.destroy(); } catch {} process.exit(0); } // Ctrl+C / q
    });
  } catch {}
}