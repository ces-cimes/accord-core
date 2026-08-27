#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { spawn, spawnSync } from "child_process";
import { z } from "zod";

// ─── Progress & Logging Helpers ──────────────────────────────────────────────
function getProgressToken(extra) {
  return extra?._meta?.progressToken;
}

async function sendProgress(extra, message, progress, total) {
  const token = getProgressToken(extra);
  if (token === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  } catch {}
}

async function sendLog(extra, level, message) {
  try {
    await extra.sendNotification({
      method: "notifications/message",
      params: { level, logger: "accord", message },
    });
  } catch {}
}

// ─── Default Councillors ─────────────────────────────────────────────────────
const DEFAULT_COUNCILLORS = [
  {
    name: "Alpha",
    role: "reasoning specialist",
    model: "deepseek/deepseek-r1",
  },
  {
    name: "Beta",
    role: "code-focused analyst",
    model: "qwen/qwen3-coder-flash",
  },
  {
    name: "Gamma",
    role: "general perspective analyst",
    model: "xiaomi/mimo-v2.5",
  },
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CACHE_MAX = 50;

// ─── Response Cache (F2.2) ──────────────────────────────────────────────────
class ResponseCache {
  constructor(ttlMs = DEFAULT_CACHE_TTL_MS, maxEntries = DEFAULT_CACHE_MAX) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.cache = new Map();
  }

  _makeKey(model, systemPrompt, userPrompt) {
    const data = `${model}:${systemPrompt}:${userPrompt}`;
    return createHash("sha256").update(data).digest("hex").slice(0, 16);
  }

  get(model, systemPrompt, userPrompt) {
    const key = this._makeKey(model, systemPrompt, userPrompt);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(model, systemPrompt, userPrompt, value) {
    const key = this._makeKey(model, systemPrompt, userPrompt);
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }
}

const cacheTtlMs = parseInt(process.env.COUNCIL_CACHE_TTL_MS, 10);
const cacheMax = parseInt(process.env.COUNCIL_CACHE_MAX, 10);
const cache = new ResponseCache(
  isNaN(cacheTtlMs) ? DEFAULT_CACHE_TTL_MS : cacheTtlMs,
  isNaN(cacheMax) ? DEFAULT_CACHE_MAX : cacheMax
);

// ─── History Logging (F3.1) ─────────────────────────────────────────────────
const historyDir = process.env.COUNCIL_HISTORY_DIR || join(homedir(), ".local", "share", "accord-core", "history");
const MAX_HISTORY_ENTRIES = parseInt(process.env.COUNCIL_HISTORY_MAX, 10) || 100;

function logHistory(entry) {
  try {
    mkdirSync(historyDir, { recursive: true });
    const filename = `${Date.now()}-${createHash("sha256").update(entry.prompt).digest("hex").slice(0, 8)}.json`;
    writeFileSync(join(historyDir, filename), JSON.stringify(entry, null, 2));

    const files = readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort();
    while (files.length > MAX_HISTORY_ENTRIES) {
      const oldest = files.shift();
      try { writeFileSync(join(historyDir, oldest), ""); } catch {}
    }
  } catch {}
}

// ─── Session Store for Follow-up (F3.2) ─────────────────────────────────────
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessions = new Map();

function createSession(prompt, mode, rounds, results) {
  const sessionId = createHash("sha256").update(`${prompt}:${Date.now()}`).digest("hex").slice(0, 12);
  sessions.set(sessionId, { prompt, mode, rounds, results, timestamp: Date.now() });
  return sessionId;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.timestamp > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

// ─── Agreement Detection (F5) ────────────────────────────────────────────────
function detectAgreement(results) {
  const responses = results.filter((r) => r.response && r.response.length > 20);
  if (responses.length < 2) return { level: "insufficient", label: "Insufficient responses" };

  const extractKeywords = (text) => {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
    const stopwords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
      "shall", "can", "need", "dare", "ought", "used", "to", "of", "in", "for", "on", "with", "at",
      "by", "from", "as", "into", "through", "during", "before", "after", "above", "below", "between",
      "out", "off", "over", "under", "again", "further", "then", "once", "here", "there", "when",
      "where", "why", "how", "all", "both", "each", "few", "more", "most", "other", "some", "such",
      "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "just", "don", "now",
      "and", "but", "or", "if", "while", "that", "this", "these", "those", "what", "which", "who",
      "whom", "it", "its", "they", "them", "their", "we", "our", "you", "your", "he", "him", "his",
      "she", "her", "i", "me", "my", "also", "like", "well", "even", "much", "many", "still"]);
    return new Set(words.filter((w) => w.length > 3 && !stopwords.has(w)));
  };

  const keywordSets = responses.map((r) => extractKeywords(r.response));
  const allKeywords = new Set(keywordSets.flat());
  if (allKeywords.size === 0) return { level: "insufficient", label: "Insufficient signal" };

  let overlapSum = 0;
  let pairs = 0;
  for (let i = 0; i < keywordSets.length; i++) {
    for (let j = i + 1; j < keywordSets.length; j++) {
      const intersection = new Set([...keywordSets[i]].filter((w) => keywordSets[j].has(w)));
      const union = new Set([...keywordSets[i], ...keywordSets[j]]);
      overlapSum += union.size > 0 ? intersection.size / union.size : 0;
      pairs++;
    }
  }
  const avgOverlap = pairs > 0 ? overlapSum / pairs : 0;

  if (avgOverlap > 0.6) return { level: "agreement", label: "Agreement", score: avgOverlap };
  if (avgOverlap > 0.3) return { level: "mixed", label: "Mixed", score: avgOverlap };
  return { level: "disagreement", label: "Disagreement", score: avgOverlap };
}

// ─── Response Quality Flags (F3) ─────────────────────────────────────────────
function getQualityFlag(r) {
  if (r.error) return { icon: "❌", label: "Error" };
  if (!r.response) return { icon: "❌", label: "No response" };
  const tokenCount = r.usage?.totalTokens || 0;
  if (tokenCount < 20) return { icon: "⚠️", label: "Short" };
  return { icon: "✅", label: "OK" };
}

// ─── Suggested Follow-ups (F6) ───────────────────────────────────────────────
function suggestFollowUps(prompt, mode) {
  const topic = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt;
  const templates = {
    parallel: [
      `What are the main risks of ${topic}?`,
      `How would you implement ${topic} in practice?`,
      `What are the alternatives to the suggested approaches?`,
    ],
    debate: [
      `What evidence would change your mind about ${topic}?`,
      `Find common ground between the opposing positions on ${topic}`,
      `What are the strongest points from each side?`,
    ],
    review: [
      `Address the reviewers' main concerns about ${topic}`,
      `What would an MVP version of this proposal look like?`,
      `Which criticisms are most important to address first?`,
    ],
    brainstorm: [
      `Which idea has the most potential and why?`,
      `How would you combine the top ideas into a coherent plan?`,
      `What's a creative approach nobody has mentioned yet?`,
    ],
  };
  return (templates[mode] || templates.parallel).slice(0, 2);
}

// ─── Model Pricing (F3.3) ───────────────────────────────────────────────────
// Updated 2025: qwen3-coder-flash added, correct live list prices used.
const MODEL_PRICING = {
  "deepseek/deepseek-r1": { input: 0.70, output: 2.50 },
  "qwen/qwen3-coder-flash": { input: 0.195, output: 0.975 },
  "xiaomi/mimo-v2.5": { input: 0.14, output: 0.28 },
  "qwen/qwen3-coder-30b-a3b-instruct": { input: 0.07, output: 0.28 },
  "anthropic/claude-sonnet-4": { input: 3.00, output: 15.00 },
  "openai/gpt-4o": { input: 2.50, output: 10.00 },
  "google/gemini-2.5-flash": { input: 0.15, output: 0.60 },
};

function estimateCost(model, promptLength) {
  const pricing = MODEL_PRICING[model] || { input: 1.00, output: 4.00 };
  const estimatedInputTokens = Math.ceil(promptLength / 4);
  const estimatedOutputTokens = 500;
  const inputCost = (estimatedInputTokens / 1_000_000) * pricing.input;
  const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost, estimatedInputTokens, estimatedOutputTokens };
}

// ─── Config Loading ──────────────────────────────────────────────────────────
function loadConfig() {
  const configPaths = [
    join(homedir(), ".config", "accord-core", "config.json"),
    join(process.cwd(), "accord-core.json"),
  ];

  for (const p of configPaths) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch {}
    }
  }
  return {};
}

// ─── Resolve Councillors (F1.3 + F1.5 + F3.5) ───────────────────────────────
function resolveCouncillors(config, profile = null) {
  let councillors;

  if (profile && config.profiles && config.profiles[profile]) {
    councillors = config.profiles[profile];
  } else if (process.env.COUNCIL_PROFILE && config.profiles && config.profiles[process.env.COUNCIL_PROFILE]) {
    councillors = config.profiles[process.env.COUNCIL_PROFILE];
  } else if (process.env.COUNCIL_COUNCILLORS) {
    try {
      councillors = JSON.parse(process.env.COUNCIL_COUNCILLORS);
    } catch {
      councillors = config.councillors || DEFAULT_COUNCILLORS;
    }
  } else {
    councillors = config.councillors || DEFAULT_COUNCILLORS;
  }

  const envModelMap = {
    COUNCIL_ALPHA_MODEL: 0,
    COUNCIL_BETA_MODEL: 1,
    COUNCIL_GAMMA_MODEL: 2,
  };

  for (const [envVar, index] of Object.entries(envModelMap)) {
    if (process.env[envVar] && councillors[index]) {
      councillors[index] = { ...councillors[index], model: process.env[envVar] };
    }
  }

  const count = parseInt(process.env.COUNCIL_COUNT, 10);
  if (!isNaN(count) && count > 0 && count < councillors.length) {
    councillors = councillors.slice(0, count);
  }

  return councillors;
}

// ─── API Key Resolution ──────────────────────────────────────────────────────
function getApiKey() {
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }

  const authPaths = [
    join(homedir(), ".local", "share", "opencode", "auth.json"),
    join(homedir(), ".local", "share", "mimocode", "auth.json"),
    join(homedir(), ".config", "claude", "auth.json"),
    join(homedir(), ".cursor", "auth.json"),
    join(homedir(), ".windsurf", "auth.json"),
  ];

  for (const p of authPaths) {
    if (existsSync(p)) {
      try {
        const auth = JSON.parse(readFileSync(p, "utf-8"));
        if (auth.openrouter?.key) return auth.openrouter.key;
      } catch {}
    }
  }

  return "";
}

// ─── Streaming (SSE) helpers ────────────────────────────────────────────────
// Streams the body, accumulating content. `idleMs` aborts (hard) if no bytes
// arrive for that window — so a working-but-slow stream (free tier) is never cut,
// while a truly stuck stream that stops sending data is. `signal` cancels too.
async function readOpenRouterSSE(runDir, fileName, response, onDelta, signal, idleMs = 30000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let usage = {};

  const appendLine = (obj) => {
    try {
      if (runDir) writeFileSync(join(runDir, fileName), JSON.stringify(obj) + "\n", { flag: "a" });
    } catch {}
  };

  const abortErr = new Error("Aborted");
  abortErr.name = "AbortError";
  if (signal?.aborted) throw abortErr;

  // Race a single read against the idle timeout + external abort.
  const readWithTimeout = () => {
    let idle;
    const idlePromise = new Promise((_, reject) => {
      idle = setTimeout(() => reject(abortErr), idleMs);
    });
    const done = Promise.race([reader.read(), idlePromise]).finally(() => clearTimeout(idle));
    return done;
  };

  while (true) {
    const { done, value } = await readWithTimeout();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
          appendLine({ t: Date.now(), delta });
        }
        if (chunk.usage) {
          usage = chunk.usage;
          appendLine({ t: Date.now(), usage });
        }
      } catch {}
    }
  }
  return {
    content: full || "(no response)",
    // snake_case to match the raw API / queryModel result mapping
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || full.length,
    },
  };
}

// ─── Query a Single Model (F1.4 + F2.2 + F2.4) ──────────────────────────────
// Options: { timeoutMs, maxRetries, useCache, stream, runDir, fileName, onDelta }
async function queryModel(model, systemPrompt, userPrompt, apiKey, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, useCache = true, stream = false, runDir = null, fileName = null, onDelta = null } = options;

  if (useCache && !stream) {
    const cached = cache.get(model, systemPrompt, userPrompt);
    if (cached) return cached;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      // Deadline guards the header/connect phase; the streamed body is guarded
      // by an idle timeout inside readOpenRouterSSE (a working-but-slow stream
      // must not be cut, a stuck one must be).
      const deadline = setTimeout(() => controller.abort(), timeoutMs);

      const startMs = Date.now();      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/ces-cimes/accord-core",
          "X-Title": "Accord Core",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 2048,
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(deadline);
        const err = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${err}`);
      }
      // Connect succeeded — the per-body idle timeout below now owns the stream;
      // an idle-then-stuck free model is cut without capping a slow-but-flowing one.
      clearTimeout(deadline);
      const latencyMs = Date.now() - startMs;

      let content, usage;
      if (stream) {
        const streamed = await readOpenRouterSSE(runDir, fileName, response, onDelta, controller.signal, timeoutMs);
        content = streamed.content;
        usage = streamed.usage;
      } else {
        const data = await response.json();
        content = data.choices?.[0]?.message?.content || "(no response)";
        usage = data.usage || {};
      }

      const result = {
        content,
        latencyMs,
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        },
      };

      if (useCache && !stream) {
        cache.set(model, systemPrompt, userPrompt, result);
      }

      return result;
    } catch (err) {
      const status = err.message?.match(/(\d{3})/)?.[1];
      const isRetryable = err.name === "AbortError" || (status && status.startsWith("5")) || status === "429" || status === "529";
      if (attempt < maxRetries && isRetryable) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ─── Async Job Infrastructure (F7: long-running council runs) ───────────────
const runsDir = process.env.COUNCIL_RUNS_DIR || join(homedir(), ".local", "share", "accord-core", "runs");
const jobs = new Map(); // runId -> { status, allRoundResults, error, councillors, createdAt, rounds, mode, prompt, format, profile }

const NO_TUI = process.env.COUNCIL_NO_TUI === "1" || (process.env.CI && process.env.NO_COLOR !== undefined);

function sanitizeFile(name) {
  return (name || "model").replace(/[^a-z0-9_-]/gi, "_");
}

// Write a JSON-stringified event line to the run's dir: <file name>.jsonl
function writeRunEvent(runId, modelName, payload) {
  try {
    const dir = join(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sanitizeFile(modelName)}.jsonl`), JSON.stringify({ t: Date.now(), ...payload }) + "\n", { flag: "a" });
  } catch {}
}

// Spawn the TUI in a separate terminal window (best-effort).
// Note: paths passed as raw argv elements — never JSON.stringify() a filesystem
// path (it escapes `\`), and no shell has a stubborn TUI-that-must-open-a-window.
function spawnTui(runId) {
  if (NO_TUI) return;
  try {
    // Prefer Bun (OpenTUI native rendering); fall back to node (ANSI renderer).
    const tuiScript = join(import.meta.dirname, "accord-tui.js");
    const runner = hasBun ? "bun" : process.execPath;
    if (process.platform === "win32") {
      // `start ""` — the empty string is the required window-title placeholder,
      // otherwise `start` treats the first quoted token as the title.
      spawn("cmd.exe", ["/c", "start", "", "cmd", "/k", runner, tuiScript, runId], { detached: true, stdio: "ignore" });
    } else if (process.platform === "darwin") {
      spawn("osascript", ["-e", `tell app "Terminal" to do script "bun ${shq(tuiScript)} ${runId}"`], { detached: true, stdio: "ignore" });
    } else {
      spawn("gnome-terminal", ["--", "bash", "-lc", `exec ${runner} ${shq(tuiScript)} ${runId}`], { detached: true, stdio: "ignore" });
    }
  } catch {}
}

// Single-quote a string for a POSIX shell (safe for paths with spaces/$). 
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Can a fresh cmd window run `bun`? spawnSync("bun") fails on Windows when it's a
// .cmd/.ps1 shim, but the cmd /k window we open needs exactly that — so probe via cmd.
const hasBun = (() => {
  try {
    return spawnSync("cmd.exe", ["/c", "where", "bun"], { stdio: "ignore" }).status === 0;
  } catch { return false; }
})();

// Start a background council run. Returns runId.
function startCouncilRun(params, councillors, apiKey) {
  const runId = createHash("sha256").update(`${params.prompt}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12);
  const { prompt, rounds, mode, format, profile } = params;
  jobs.set(runId, { status: "running", error: null, councillors, rounds, mode, prompt, format, profile, createdAt: Date.now() });

  writeRunEvent(runId, "__meta", { status: "running", prompt, rounds, mode, councillors: councillors.map((c) => ({ name: c.name, model: c.model })) });
  spawnTui(runId);

  (async () => {
    try {
      const { allRoundResults } = await runCouncilRoundLogic({ prompt, rounds, mode, councillors, apiKey, runId });
      const flat = allRoundResults.flat();
      const prev = jobs.get(runId) || { createdAt: Date.now(), rounds, mode, prompt, format, profile };
      jobs.set(runId, { ...prev, status: "done", councillors, allRoundResults, error: null });
      writeRunEvent(runId, "__meta", { status: "done", rounds, mode });
      logHistory({
        timestamp: new Date().toISOString(),
        prompt, mode, rounds, format, profile: profile || null,
        councillors: councillors.map((c) => ({ name: c.name, model: c.model, role: c.role })),
        results: allRoundResults,
      });
      if (params.extra) await sendLog(params.extra, "info", `Council run ${runId} complete (${flat.filter((r) => r.response).length}/${flat.length} succeeded)`);
    } catch (err) {
      const prev = jobs.get(runId) || { councillors, createdAt: Date.now(), rounds, mode, prompt, format, profile };
      jobs.set(runId, { ...prev, status: "error", error: err?.message || "unknown" });
      writeRunEvent(runId, "__meta", { status: "error", error: err?.message || "unknown" });
    }
  })();

  return runId;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────
const config = loadConfig();
const timeoutMs = parseInt(process.env.COUNCIL_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;

const server = new McpServer({
  name: "accord-core",
  version: "1.0.0",
});

// ─── Mode-specific system prompt generators ──────────────────────────────────
function getModeSystemPrompt(mode, c, priorContext) {
  const base = (extra) => `You are ${c.name}, a ${c.role}. ${extra}`;

  switch (mode) {
    case "debate":
      return base(`You are in a debate. Take a clear stance (for or against) and argue it forcefully. Be concise in 2-4 sentences. Acknowledge counterarguments from others and rebut them.`);
    case "review":
      if (priorContext) {
        return base(`You are reviewing a proposal generated by another councillor. Provide constructive criticism: what works, what doesn't, and what's missing. Be concise in 2-4 sentences.`);
      }
      return base(`You are generating a proposal for others to review. Be thorough but concise in 3-5 sentences.`);
    case "brainstorm":
      return base(`You are brainstorming. Build on what others have said — extend ideas, combine concepts, or suggest novel angles. Be creative and concise in 2-4 sentences.`);
    default: // parallel
      if (c.systemPrompt) return c.systemPrompt;
      const globalTemplate = process.env.COUNCIL_SYSTEM_TEMPLATE;
      if (globalTemplate) return globalTemplate.replace("{name}", c.name).replace("{role}", c.role);
      return `You are ${c.name}, a ${c.role}. Answer concisely in 2-4 sentences. Be direct and opinionated.`;
  }
}

// ─── Council run logic (runs in background; streams deltas to run dir) ───────
async function runCouncilRoundLogic({ prompt, rounds, mode, councillors, apiKey, runId, format }) {
  const allRoundResults = [];
  const query = (model, sys, usr) => queryModel(model, sys, usr, apiKey, {
    timeoutMs,
    stream: true,
    runDir: join(runsDir, runId),
    fileName: `${sanitizeFile(model)}.jsonl`,
    // Note: readOpenRouterSSE already persists deltas to fileName (via appendLine),
    // so do NOT also writeRunEvent here — that would double every token.
  });

  if (mode === "parallel") {
    const round1Tasks = councillors.map((c) => {
      const sysPrompt = getModeSystemPrompt(mode, c, null);
      return query(c.model, sysPrompt, prompt).then(async (result) => {
        return {
          name: c.name, model: c.model, role: c.role,
          response: result.content, latencyMs: result.latencyMs, usage: result.usage,
        };
      });
    });

    const round1Settled = await Promise.allSettled(round1Tasks);
    const round1Results = round1Settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { name: councillors[i].name, model: councillors[i].model, role: councillors[i].role,
        response: null, error: r.reason?.message || "unknown", latencyMs: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    });
    allRoundResults.push(round1Results);

    for (let round = 1; round < rounds; round++) {
      const priorContext = allRoundResults
        .flatMap((r) => r.filter((x) => x.response).map((x) => `[${x.name}]: ${x.response}`))
        .join("\n\n").slice(0, 8000);

      const refinementTasks = councillors.map((c, i) => {
        const sysPrompt = getModeSystemPrompt(mode, c, priorContext);
        const prevResponse = round1Results[i]?.response;
        const refinementPrompt = `Previous perspectives:\n\n${priorContext}\n\nYour previous response: ${prevResponse || "(no response)"}\n\nRevisit your position. Identify where you agree/disagree and why. Be concise.`;
        return query(c.model, sysPrompt, refinementPrompt).then(async (result) => {
          return {
            name: c.name, model: c.model, role: c.role,
            response: result.content, latencyMs: result.latencyMs, usage: result.usage,
          };
        });
      });

      const roundSettled = await Promise.allSettled(refinementTasks);
      allRoundResults.push(roundSettled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        return { name: councillors[i].name, model: councillors[i].model, role: councillors[i].role,
          response: null, error: r.reason?.message || "unknown", latencyMs: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      }));
    }

  } else if (mode === "debate") {
    const positions = ["FOR", "AGAINST", "JUDGE"];

    const debateTasks = councillors.map((c, i) => {
      const position = positions[i] || "OBSERVER";
      const sysPrompt = `You are ${c.name}, a ${c.role}. You are arguing ${position} the following proposition. Take a clear stance, present evidence, and be persuasive. Be concise in 2-4 sentences.`;
      return query(c.model, sysPrompt, `Proposition: ${prompt}\n\nArgue ${position}.`).then(async (result) => {
        return {
          name: c.name, model: c.model, role: c.role,
          response: result.content, latencyMs: result.latencyMs, usage: result.usage,
          position,
        };
      });
    });

    const settled = await Promise.allSettled(debateTasks);
    allRoundResults.push(settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { name: councillors[i].name, model: councillors[i].model, role: councillors[i].role,
        response: null, error: r.reason?.message || "unknown", latencyMs: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        position: positions[i] || "OBSERVER" };
    }));

    for (let round = 1; round < rounds; round++) {
      const priorContext = allRoundResults
        .flatMap((r) => r.filter((x) => x.response).map((x) => `[${x.name} (${x.position})]: ${x.response}`))
        .join("\n\n").slice(0, 8000);

      const rebuttalTasks = councillors.map((c, i) => {
        const position = positions[i] || "OBSERVER";
        const sysPrompt = `You are ${c.name}, a ${c.role}. You are arguing ${position}. You have heard the other arguments. Rebut counterarguments and strengthen your position. Be concise.`;
        const rebuttalPrompt = `The debate so far:\n\n${priorContext}\n\nProvide your rebuttal for ${position}.`;
        return query(c.model, sysPrompt, rebuttalPrompt).then(async (result) => {
          return {
            name: c.name, model: c.model, role: c.role,
            response: result.content, latencyMs: result.latencyMs, usage: result.usage,
            position,
          };
        });
      });

      const roundSettled = await Promise.allSettled(rebuttalTasks);
      allRoundResults.push(roundSettled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        return { name: councillors[i].name, model: councillors[i].model, role: councillors[i].role,
          response: null, error: r.reason?.message || "unknown", latencyMs: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          position: positions[i] || "OBSERVER" };
      }));
    }

  } else if (mode === "review") {
    const proposer = councillors[0];
    const reviewers = councillors.slice(1);

    const proposalSysPrompt = getModeSystemPrompt(mode, proposer, null);
    const proposalResult = await query(proposer.model, proposalSysPrompt, prompt);
    const proposal = {
      name: proposer.name, model: proposer.model, role: proposer.role,
      response: proposalResult.content, latencyMs: proposalResult.latencyMs, usage: proposalResult.usage,
      position: "PROPOSAL",
    };
    allRoundResults.push([proposal]);

    const reviewTasks = reviewers.map((c, i) => {
      const sysPrompt = getModeSystemPrompt(mode, c, proposal.response);
      const reviewPrompt = `Proposal to review:\n\n${proposal.response}\n\nProvide constructive criticism: what works, what doesn't, and what's missing.`;
      return query(c.model, sysPrompt, reviewPrompt).then(async (result) => {
        return {
          name: c.name, model: c.model, role: c.role,
          response: result.content, latencyMs: result.latencyMs, usage: result.usage,
          position: "REVIEW",
        };
      });
    });

    const reviewSettled = await Promise.allSettled(reviewTasks);
    allRoundResults.push(reviewSettled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { name: reviewers[i].name, model: reviewers[i].model, role: reviewers[i].role,
        response: null, error: r.reason?.message || "unknown", latencyMs: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        position: "REVIEW" };
    }));

    if (rounds > 1) {
      const reviewContext = allRoundResults[1]
        .filter((x) => x.response)
        .map((x) => `[${x.name}]: ${x.response}`)
        .join("\n\n").slice(0, 8000);
      const responsePrompt = `Your proposal:\n\n${proposal.response}\n\nReviews received:\n\n${reviewContext}\n\nRespond to the feedback. Acknowledge valid points and defend your work where appropriate.`;
      const responseResult = await query(proposer.model, proposalSysPrompt, responsePrompt);
      allRoundResults.push([{
        name: proposer.name, model: proposer.model, role: proposer.role,
        response: responseResult.content, latencyMs: responseResult.latencyMs, usage: responseResult.usage,
        position: "RESPONSE",
      }]);
    }

  } else if (mode === "brainstorm") {
    const responses = [];

    for (let i = 0; i < councillors.length; i++) {
      const c = councillors[i];
      const sysPrompt = getModeSystemPrompt(mode, c, responses.length > 0 ? "prior" : null);
      let userPrompt;
      if (responses.length === 0) {
        userPrompt = `Brainstorm ideas for: ${prompt}\n\nProvide 2-3 creative ideas or angles.`;
      } else {
        const priorIdeas = responses
          .filter((x) => x.response)
          .map((x) => `[${x.name}]: ${x.response}`)
          .join("\n\n");
        userPrompt = `Topic: ${prompt}\n\nPrior ideas from the council:\n\n${priorIdeas}\n\nBuild on these — extend ideas, combine concepts, or suggest novel angles. Don't repeat what's been said.`;
      }
      const result = await query(c.model, sysPrompt, userPrompt);
      responses.push({
        name: c.name, model: c.model, role: c.role,
        response: result.content, latencyMs: result.latencyMs, usage: result.usage,
        position: `BUILD ${i + 1}`,
      });
    }
    allRoundResults.push(responses);
  }

  return { allRoundResults };
}

// Build markdown/json output for a completed run.
function buildOutput({ prompt, rounds, mode, format, councillors, allRoundResults, sessionId }) {
  const flatResults = allRoundResults.flat();
  const succeeded = flatResults.filter((r) => r.response).length;
  const totalLatency = flatResults.reduce((sum, r) => sum + (r.latencyMs || 0), 0);
  const agreement = detectAgreement(flatResults);
  const agreementIcon = { agreement: "✅", mixed: "⚠️", disagreement: "❌", insufficient: "❓" }[agreement.level];

  let output = `## Council Results — ${succeeded}/${flatResults.length} responded, ${(totalLatency / 1000).toFixed(1)}s total\n`;
  output += `**Consensus:** ${agreementIcon} ${agreement.label}`;
  if (agreement.score !== undefined) output += ` (${(agreement.score * 100).toFixed(0)}% overlap)`;
  output += "\n\n";

  output += "| Councillor | Model | Status | Latency | Cost |\n";
  output += "|-----------|-------|--------|---------|------|\n";
  for (const r of flatResults) {
    const quality = getQualityFlag(r);
    const latency = r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : "-";
    const est = estimateCost(r.model, 0);
    const cost = `$${(est.totalCost * ((r.usage?.totalTokens || 0) / 500)).toFixed(4)}`;
    const position = r.position ? ` [${r.position}]` : "";
    output += `| ${r.name}${position} | ${r.model} | ${quality.icon} ${quality.label} | ${latency} | ${cost} |\n`;
  }
  output += "\n---\n\n";

  if (format === "compact") {
    output += `*Use format="markdown" for full responses.*\n`;
    output += `\n**Suggested follow-ups:**\n`;
    for (const q of suggestFollowUps(prompt, mode)) output += `- ${q}\n`;
    return { text: output };
  }

  for (let ri = 0; ri < allRoundResults.length; ri++) {
    if (allRoundResults.length > 1) output += `### Round ${ri + 1}\n\n`;
    for (const r of allRoundResults[ri]) {
      const positionTag = r.position ? ` [${r.position}]` : "";
      const quality = getQualityFlag(r);
      output += `### ${r.name} (${r.model})${positionTag} ${quality.icon}\n`;
      if (r.response) {
        output += `${r.response}\n\n`;
        output += `*Responded in ${(r.latencyMs / 1000).toFixed(1)}s, ${r.usage.totalTokens} tokens*\n\n`;
      } else {
        output += `*Error: ${r.error}*\n\n`;
      }
      output += "---\n\n";
    }
  }

  output += "*Synthesize these perspectives into a single verdict.*\n";

  output += `\n**Suggested follow-ups:**\n`;
  for (const q of suggestFollowUps(prompt, mode)) output += `- ${q}\n`;

  if (format === "json" || format === "both") {
    const jsonData = {
      rounds: allRoundResults.map((rr) =>
        rr.map((r) => ({
          name: r.name, model: r.model, role: r.role,
          response: r.response, error: r.error || null,
          position: r.position || null,
          latencyMs: r.latencyMs, usage: r.usage,
        }))
      ),
      metadata: { totalRounds: rounds, mode, councillorCount: councillors.length, timestamp: new Date().toISOString() },
    };
    if (format === "json") return { text: JSON.stringify(jsonData, null, 2) };
    output += "\n```json\n" + JSON.stringify(jsonData, null, 2) + "\n```\n";
  }

  if (sessionId) output += `\n*Session ID: ${sessionId} (use accord_followup to continue this consultation)*\n`;
  return { text: output };
}

server.tool(
  "accord",
  "Query multiple AI models in parallel for consensus on a question or decision. Starts an asynchronous council job, returns a runId immediately; poll with accord_job.",
  {
    prompt: z.string().describe("The question or topic for the council to analyze"),
    rounds: z.number().int().min(1).max(3).optional().default(1)
      .describe("Number of refinement rounds (1 = parallel only, 2-3 = models see each other's responses). Default: 1"),
    mode: z.enum(["parallel", "debate", "review", "brainstorm"]).optional().default("parallel")
      .describe("Council interaction mode. Default: parallel"),
    format: z.enum(["markdown", "json", "both", "compact"]).optional().default("markdown")
      .describe("Output format. 'compact' shows summary only. Default: markdown"),
    profile: z.string().optional()
      .describe("Named councillor profile from config."),
  },
  async ({ prompt, rounds, mode, format, profile }, extra) => {
    const councillors = resolveCouncillors(config, profile);
    const apiKey = getApiKey();
    if (!apiKey) {
      return { content: [{ type: "text", text: "Error: No OpenRouter API key found. Set OPENROUTER_API_KEY or add to ~/.local/share/opencode/auth.json / ~/.local/share/mimocode/auth.json" }] };
    }
    const runId = startCouncilRun({ prompt, rounds, mode, format, profile, extra }, councillors, apiKey);
    await sendLog(extra, "info", `Council run ${runId} started (${councillors.length} models, ${mode} mode, ${rounds} round${rounds > 1 ? "s" : ""})`);
    const text = `Council run **${runId}** started in the background.
- Poll with the **accord_job** tool: \`accord_job(runId="${runId}")\`
- A TUI terminal shows live per-model streams (or run \`npx accord-tui ${runId}\`).
- mode=\`${mode}\`, rounds=\`${rounds}\`, format=\`${format}\`, councillors=[${councillors.map((c) => c.name).join(", ")}]`;
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "accord_job",
  "Poll the status of a council run started by accord. Returns 'running' (call again shortly) or the full formatted result once complete. Non-blocking — safe for multi-round runs.",
  {
    runId: z.string().describe("The run ID returned by the accord tool"),
    format: z.enum(["markdown", "json", "both", "compact"]).optional().default("markdown")
      .describe("Output format. Default: markdown"),
  },
  async ({ runId, format }, extra) => {
    const job = jobs.get(runId);
    if (!job) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }] };

    if (job.status === "running") {
      await sendLog(extra, "info", `Run ${runId} still running`);
      return { content: [{ type: "text", text: `Run **${runId}** is still **running** (${job.mode}, round ${job.round ?? "?"}/${job.rounds}). Poll again shortly.` }] };
    }
    if (job.status === "error") {
      return { content: [{ type: "text", text: `Run **${runId}** errored: ${job.error}` }] };
    }

    const sessionId = createSession(job.prompt, job.mode, job.rounds, job.allRoundResults);
    const { text } = buildOutput({
      prompt: job.prompt, rounds: job.rounds, mode: job.mode, format, councillors: job.councillors,
      allRoundResults: job.allRoundResults, sessionId,
    });
    await sendLog(extra, "info", `Run ${runId} completed`);
    return { content: [{ type: "text", text }] };
  }
);

// ─── F3.4: Health Check Tool ─────────────────────────────────────────────────
server.tool(
  "accord_health",
  "Check which configured models are available and responding. Returns status and latency for each model.",
  {
    profile: z.string().optional()
      .describe("Named councillor profile to check."),
  },
  async ({ profile }, extra) => {
    const councillors = resolveCouncillors(config, profile);
    const apiKey = getApiKey();
    if (!apiKey) {
      return { content: [{ type: "text", text: "Error: No OpenRouter API key found." }] };
    }

    const healthChecks = await Promise.allSettled(
      councillors.map(async (c, i) => {
        await sendProgress(extra, `Health check: Testing ${c.name} (${c.model})...`, i, councillors.length);
        const startMs = Date.now();
        try {
          const result = await queryModel(c.model, "Say OK", "Say OK", apiKey, { timeoutMs: 10000, useCache: false });
          return { name: c.name, model: c.model, role: c.role, status: "healthy", latencyMs: Date.now() - startMs, response: result.content };
        } catch (err) {
          return { name: c.name, model: c.model, role: c.role, status: "unhealthy", error: err.message, latencyMs: Date.now() - startMs };
        }
      })
    );

    let output = "## Council Health Check\n\n";
    for (const r of healthChecks) {
      const result = r.status === "fulfilled" ? r.value : { name: "unknown", model: "unknown", status: "error", error: r.reason?.message };
      const icon = result.status === "healthy" ? "+" : "x";
      output += `[${icon}] ${result.name} (${result.model})\n`;
      if (result.status === "healthy") output += `  Latency: ${(result.latencyMs / 1000).toFixed(1)}s\n\n`;
      else output += `  Error: ${result.error}\n\n`;
    }
    const healthy = healthChecks.filter((r) => r.status === "fulfilled" && r.value.status === "healthy").length;
    output += `**${healthy}/${councillors.length} models healthy**\n`;
    return { content: [{ type: "text", text: output }] };
  }
);

// ─── F3.3: Cost Estimation Tool ──────────────────────────────────────────────
server.tool(
  "accord_estimate",
  "Estimate the cost of a council query before executing. Returns per-model and total estimated cost.",
  {
    prompt: z.string().describe("The question or topic to estimate cost for"),
    rounds: z.number().int().min(1).max(3).optional().default(1).describe("Number of refinement rounds. Default: 1"),
    mode: z.enum(["parallel", "debate", "review", "brainstorm"]).optional().default("parallel").describe("Council interaction mode."),
    profile: z.string().optional().describe("Named councillor profile."),
  },
  async ({ prompt, rounds, mode, profile }, extra) => {
    const councillors = resolveCouncillors(config, profile);
    await sendLog(extra, "info", `Cost estimate: ${councillors.length} models, ${rounds} round(s), ${mode} mode`);
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    let output = "## Council Cost Estimate\n\n";

    for (const c of councillors) {
      const est = estimateCost(c.model, prompt.length * (mode === "brainstorm" ? 2 : 1) * rounds);
      totalCost += est.totalCost;
      totalInputTokens += est.estimatedInputTokens * rounds;
      totalOutputTokens += est.estimatedOutputTokens * rounds;

      output += `### ${c.name} (${c.model})\n`;
      output += `Input: ~${est.estimatedInputTokens} tokens ($${est.inputCost.toFixed(4)})\n`;
      output += `Output: ~${est.estimatedOutputTokens} tokens ($${est.outputCost.toFixed(4)})\n`;
      output += `Subtotal: $${est.totalCost.toFixed(4)}\n\n`;
    }

    output += `---\n\n`;
    output += `**Total estimated cost: $${totalCost.toFixed(4)}**\n`;
    output += `~${totalInputTokens} input tokens, ~${totalOutputTokens} output tokens\n`;
    output += `*Note: Actual costs vary based on model pricing and response length.*\n`;
    return { content: [{ type: "text", text: output }] };
  }
);

// ─── F3.2: Follow-up Tool ────────────────────────────────────────────────────
server.tool(
  "accord_followup",
  "Continue a council consultation with a follow-up question. Maintains context from the previous session.",
  {
    sessionId: z.string().describe("Session ID from a previous council call"),
    prompt: z.string().describe("Follow-up question or refinement"),
    format: z.enum(["markdown", "json", "both", "compact"]).optional().default("markdown")
      .describe("Output format. Default: markdown"),
  },
  async ({ sessionId, prompt, format }, extra) => {
    const session = getSession(sessionId);
    if (!session) {
      return { content: [{ type: "text", text: `Error: Session ${sessionId} not found or expired (sessions expire after 30 minutes).` }] };
    }

    const councillors = resolveCouncillors(config, null);
    const apiKey = getApiKey();
    if (!apiKey) return { content: [{ type: "text", text: "Error: No OpenRouter API key found." }] };

    const priorContext = session.results
      .flat()
      .filter((r) => r.response)
      .map((r) => `[${r.name}]: ${r.response}`)
      .join("\n\n");

    const followUpPrompt = `Previous council discussion:\n\n${priorContext}\n\nOriginal question: ${session.prompt}\n\nFollow-up: ${prompt}\n\nRespond to the follow-up while considering the previous discussion. Be concise.`;

    const tasks = councillors.map((c, i) => {
      const sysPrompt = `You are ${c.name}, a ${c.role}. You are continuing a previous council discussion. Consider the prior context and respond to the follow-up. Be concise in 2-4 sentences.`;
      return sendProgress(extra, `Follow-up: Querying ${c.name}...`, i, councillors.length)
        .then(() => queryModel(c.model, sysPrompt, followUpPrompt, apiKey, { timeoutMs }))
        .then(async (result) => {
          await sendProgress(extra, `Follow-up: ${c.name} completed`, i + 1, councillors.length);
          return { name: c.name, model: c.model, role: c.role, response: result.content, latencyMs: result.latencyMs, usage: result.usage };
        });
    });

    const settled = await Promise.allSettled(tasks);
    const results = settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { name: councillors[i].name, model: councillors[i].model, role: councillors[i].role,
        response: null, error: r.reason?.message || "unknown", latencyMs: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    });

    logHistory({
      timestamp: new Date().toISOString(),
      prompt, mode: session.mode, rounds: 1, format, profile: null,
      councillors: councillors.map((c) => ({ name: c.name, model: c.model, role: c.role })),
      results: [results],
      followUpTo: sessionId,
    });

    let output = `## Council Follow-up (Session: ${sessionId})\n\n`;
    for (const r of results) {
      output += `### ${r.name} (${r.model})\n`;
      if (r.response) {
        output += `${r.response}\n\n`;
        output += `*Responded in ${(r.latencyMs / 1000).toFixed(1)}s, ${r.usage.totalTokens} tokens*\n\n`;
      } else {
        output += `*Error: ${r.error}*\n\n`;
      }
      output += "---\n\n";
    }

    output += "*Synthesize these perspectives into a single verdict.*\n";

    if (format === "json" || format === "both") {
      const jsonData = {
        followUpTo: sessionId,
        results: results.map((r) => ({
          name: r.name, model: r.model, role: r.role,
          response: r.response, error: r.error || null,
          latencyMs: r.latencyMs, usage: r.usage,
        })),
        metadata: { timestamp: new Date().toISOString(), councillorCount: councillors.length },
      };
      if (format === "json") return { content: [{ type: "text", text: JSON.stringify(jsonData, null, 2) }] };
      output += "\n```json\n" + JSON.stringify(jsonData, null, 2) + "\n```\n";
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);