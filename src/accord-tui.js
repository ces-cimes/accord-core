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
//
// Design notes:
//   - round tags (added by the server) drive per-round separators.
//   - usage events feed a live token + cost footer.
//   - reveal is burst-aware: steady-paced typing, but it catches up fast when a
//     burst arrives so it never sits behind the real stream.

import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const [runId] = process.argv.slice(2);
if (!runId) {
  console.error("usage: accord-tui <runId>");
  process.exit(1);
}

const runsDir = process.env.COUNCIL_RUNS_DIR || join(homedir(), ".local", "share", "accord-core", "runs");
const dir = join(runsDir, runId);
const POLL_MS = 250; // data-read cadence
const FRAME_MS = 60; // reveal cadence (~16 fps)
const REVEAL = 8; // per frame reveal deficit/REVEAL chars (min 1)

const COLORS = ["#7dd3fc", "#fbbf24", "#a7f3d0", "#f9a8d4", "#c4b5fd", "#e2e8f0"];
const ANSI_COLORS = ["36", "33", "32", "35", "94", "37"]; // cyan, yellow, green, magenta, blue, white
const SAW_NONE = "(waiting for tokens…)";

// ─── Run state (built from files) ───────────────────────────────────────────
let runStatus = "waiting";
let runRounds = 0;
let runMode = "";
const roleByModel = new Map(); // model -> role
const received = new Map(); // model -> full text incl. round separators
const lastRound = new Map(); // model -> round of most recent delta
const usageOf = new Map(); // model -> { prompt_tokens, completion_tokens }
const visible = new Map(); // model -> revealed char count
const offsets = new Map(); // model -> byte offset (only parse new lines)

function readMeta() {
  try {
    const lines = readFileSync(join(dir, "__meta.jsonl"), "utf-8").split("\n").filter(Boolean);
    if (!lines.length) return;
    const evt = JSON.parse(lines[lines.length - 1]);
    if (evt.status) runStatus = evt.status;
    if (evt.mode) runMode = evt.mode;
    if (Number.isInteger(evt.rounds)) runRounds = evt.rounds;
  } catch {}
}

// Returns the current councillor model list (from the first councillors event),
// and caches model -> role for the column headers.
function readMetaModels() {
  try {
    const lines = readFileSync(join(dir, "__meta.jsonl"), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const evt = JSON.parse(line);
      if (Array.isArray(evt.councillors)) {
        roleByModel.clear();
        for (const c of evt.councillors) if (c.model && !roleByModel.has(c.model)) roleByModel.set(c.model, c.role || "");
        return evt.councillors.map((c) => c.model);
      }
    }
  } catch {}
  return null;
}

const fileFor = (model) => model.replace(/[^a-z0-9_-]/gi, "_") + ".jsonl";

function modelFiles() {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f !== "__meta.jsonl").map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

// Parse only the newly-appended lines; rebuild round separators + token sums.
function readModels(models) {
  for (const model of models) {
    let content = received.get(model) || "";
    let round = lastRound.get(model) || 1;
    try {
      const full = readFileSync(join(dir, fileFor(model)), "utf-8");
      const chunk = full.slice(offsets.get(model) || 0);
      offsets.set(model, full.length);
      for (const line of chunk.split("\n")) {
        try {
          const evt = JSON.parse(line);
          if (evt.delta) {
            const r = evt.round || round;
            if (r !== round) {
              if (content) content += "\n\n──── Round " + r + " ────\n\n";
              round = r;
            }
            content += evt.delta;
          } else if (evt.usage) {
            const prev = usageOf.get(model) || { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
            usageOf.set(model, {
              prompt_tokens: prev.prompt_tokens + (evt.usage.prompt_tokens || 0),
              completion_tokens: prev.completion_tokens + (evt.usage.completion_tokens || 0),
              cost: prev.cost + (evt.usage.cost || 0),
            });
          }
        } catch {}
      }
      lastRound.set(model, round);
      received.set(model, content);
    } catch {}
  }
}

function footerText(models) {
  let pin = 0, pout = 0, cost = 0;
  for (const m of models) {
    const u = usageOf.get(m);
    if (!u) continue;
    pin += u.prompt_tokens;
    pout += u.completion_tokens;
    cost += u.cost;
  }
  return `tokens ${pin}+${pout} · $${cost.toFixed(4)}`;
}

function headerFor(model) {
  const stem = model.split("/").pop();
  const role = roleByModel.get(model);
  const ref = role ? `${stem} · ${role}` : stem;
  return ref.length > 30 ? ref.slice(0, 29) + "…" : ref;
}

// Split a model's revealed text into round segments of wrapped lines, so the
// ANSI renderer can align round headers across columns on the same row.
function seg(text, width) {
  const segs = [];
  let cur = null;
  let round = 1;
  for (const ln of text.split("\n")) {
    const m = ln.match(/^─+ Round (\d+) ─+$/);
    if (m) {
      if (cur && cur.lines.length) segs.push(cur);
      round = +m[1];
      cur = { round, lines: [] };
      continue;
    }
    if (!cur) cur = { round, lines: [] };
    if (!ln.trim()) { if (cur.lines.length || !segs.length) cur.lines.push(""); continue; }
    let acc = "";
    for (const w of ln.split(/\s+/).filter(Boolean)) {
      if (acc && acc.length + 1 + w.length > width) { cur.lines.push(acc); acc = w; }
      else acc = acc ? acc + " " + w : w;
    }
    if (acc) cur.lines.push(acc);
  }
  if (cur && cur.lines.length) segs.push(cur);
  if (!segs.length) segs.push({ round, lines: [] });
  return segs;
}

// ─── Renderer: OpenTUI (Bun) ────────────────────────────────────────────────
async function createOpenTuiRenderer() {
  const { createCliRenderer, BoxRenderable, TextRenderable } = await import("@opentui/core");
  const cr = await createCliRenderer({ targetFps: 20 });

  // Column layout: title bar on top, model columns filling the middle, a
  // bordered status/footer box pinned to the bottom (Box titles only render
  // when the box has a border, so the footer is its own box — not bottomTitle).
  const root = new BoxRenderable(cr, {
    flexDirection: "column",
    width: "100%", height: "100%", flexGrow: 1, gap: 1,
  });
  cr.root.add(root);

  const titleBar = new BoxRenderable(cr, { border: true, height: 1, title: "", paddingX: 1 });
  root.add(titleBar);

  const body = new BoxRenderable(cr, {
    flexDirection: "row", alignItems: "stretch",
    flexGrow: 1, flexShrink: 1, flexBasis: 0, gap: 1,
  });
  root.add(body);

  const footerBar = new BoxRenderable(cr, { border: true, height: 1, title: "", paddingX: 1 });
  root.add(footerBar);

  const textByModel = new Map();

  const ensure = (model, i) => {
    if (textByModel.has(model)) return;
    const color = COLORS[i % COLORS.length];
    const txt = new TextRenderable(cr, { content: "", fg: color });
    const box = new BoxRenderable(cr, {
      flexDirection: "column",
      flexGrow: 1, flexShrink: 1, flexBasis: 0, // equal, stable widths — never collapse
      minWidth: 8, border: true, borderColor: color, paddingX: 1, paddingY: 1,
      title: headerFor(model),
    });
    box.add(txt);
    body.add(box);
    textByModel.set(model, txt);
  };

  return {
    name: "opentui",
    setTitle(t) { try { titleBar.title = ` ${t} `; } catch {} },
    setFooter(f) { try { footerBar.title = ` ${f} `; } catch {} },
    ensure,
    setColumn(model, text) { const n = textByModel.get(model); if (n) { n.content = text; try { n.scrollY = n.maxScrollY; } catch {} } },
    render() { cr.requestRender(); },
    destroy() { try { cr.destroy?.(); } catch {} },
  };
}

// ─── Renderer: ANSI (plain Node) ────────────────────────────────────────────
function createAnsiRenderer() {
  const render = (models, visibleOf) => {
    const w = process.stdout.columns || 100;
    const h = Math.max((process.stdout.rows || 20) - 3, 6); // reserve head + footer
    const n = Math.max(models.length, 1);
    const colw = Math.max(Math.floor((w - n - 1) / n), 12);
    const inner = colw - 2;

    // Per column: revealed text → round segments of wrapped lines.
    const segs = models.map((m) => seg(visibleOf(m) || SAW_NONE, inner));
    const maxSegs = Math.max(...segs.map((s) => s.length), 1);

    // Build a row grid where every round header sits on the same row across
    // columns, and each round's band is padded to the tallest column.
    const grid = [];
    for (let s = 0; s < maxSegs; s++) {
      const band = Math.max(0, ...segs.map((sg) => (sg[s] ? sg[s].lines.length : 0)));
      const hdr = models.map((_, i) => {
        const g = segs[i][s];
        const t = g ? ` Round ${g.round} ` : " ".repeat(inner);
        return t.slice(0, inner).padEnd(inner);
      });
      grid.push({ h: true, cells: hdr });
      for (let r = 0; r < band; r++) {
        grid.push({ h: false, cells: models.map((_, i) => ((segs[i][s] && segs[i][s].lines[r]) || "").padEnd(inner)) });
      }
    }

    // Autoscroll: pin to the bottom so the newest tokens stay visible.
    const win = grid.slice(-h);

    const divider = (i) => (i < models.length - 1 ? "\x1b[90m│\x1b[0m" : "");
    let body = win.map((g) => {
      let out = "";
      for (let i = 0; i < models.length; i++) {
        const color = g.h ? "33" : ANSI_COLORS[i % ANSI_COLORS.length];
        out += `\x1b[${color}m ${g.cells[i]} \x1b[0m${divider(i)}`;
      }
      return out;
    }).join("\n");

    let head = "";
    for (let i = 0; i < models.length; i++) {
      const c = ANSI_COLORS[i % ANSI_COLORS.length];
      head += `\x1b[${c};1m${headerFor(models[i]).slice(0, colw).padEnd(colw)}\x1b[0m`;
      if (i < models.length - 1) head += "\x1b[90m│\x1b[0m";
    }

    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${head}\n${body}\n\n\x1b[1;90m${footerText(models)}\x1b[0m   \x1b[90m${bar()}\x1b[0m`);
    process.stdout.write("\x1b[?25l");
  };

  return {
    name: "ansi",
    render,
    destroy() { try { process.stdout.write("\x1b[?25h\x1b[0m"); } catch {} },
  };
}

// ─── Shared driver ───────────────────────────────────────────────────────────
async function pickRenderer() {
  try {
    return await createOpenTuiRenderer();
  } catch {
    process.stderr.write("accord-tui: OpenTUI unavailable on this runtime — using ANSI fallback.\n");
    return createAnsiRenderer();
  }
}

// Reveal the next slice for a model (burst-aware). Returns the shown text.
function reveal(model) {
  const text = received.get(model) || "";
  const cur = visible.get(model) || 0;
  if (cur >= text.length) return text;
  const step = Math.max(1, Math.floor((text.length - cur) / REVEAL));
  visible.set(model, cur + step);
  return text.slice(0, cur + step);
}

function bar() {
  if (runStatus === "done") return `${runId} · complete — Ctrl+C to exit`;
  if (runStatus === "error") return `${runId} · errored — Ctrl+C to exit`;
  const round = Math.max(...lastRound.values(), 1);
  return `${runId} · ${runMode} · round ${round}/${runRounds || "?"} · ${runStatus}`;
}

const r = await pickRenderer();
let models = [];
const lastShown = new Map(); // model -> displayed string (to skip idle repaints)

// One paint tick: advance every column toward its received text, then repaint
// only if something actually changed. Runs on a fixed interval so streaming
// never stalls after an initial burst (the earlier deferred-timer loop did).
function draw() {
  let changed = models.length !== lastShown.size;
  const shown = new Map();
  for (const m of models) {
    const t = reveal(m);
    shown.set(m, t);
    if (lastShown.get(m) !== t) changed = true;
  }
  if (!changed) return;
  for (const [m, t] of shown) lastShown.set(m, t);
  if (r.name === "ansi") {
    r.render(models, (m) => shown.get(m));
  } else {
    try { r.setTitle(bar()); r.setFooter(footerText(models)); } catch {}
    for (const [m, t] of shown) r.setColumn(m, t);
    r.render();
  }
}

// Data poll keeps run state fresh; animation ticks on its own interval.
setInterval(() => {
  readMeta();
  const meta = readMetaModels();
  const next = (meta && meta.length) ? meta : modelFiles();
  models = (next && next.length) ? next : [];
  for (let i = 0; i < models.length; i++) r.ensure?.(models[i], i);
  readModels(models);
}, POLL_MS);

setInterval(draw, FRAME_MS);

if (r.name !== "opentui") {
  try {
    process.stdin?.setRawMode?.(true);
    process.stdin?.resume?.();
    process.stdin?.on?.("data", (d) => {
      if (d[0] === 3 || d[0] === 113) { try { r.destroy(); } catch {} process.exit(0); }
    });
  } catch {}
}

readMeta();
const firstModels = (readMetaModels() || []).filter(Boolean);
models = firstModels.length ? firstModels : modelFiles();
for (let i = 0; i < models.length; i++) r.ensure?.(models[i], i);
readModels(models);
draw();