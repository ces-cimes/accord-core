#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
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
      params: { level, logger: "council", message },
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
    model: "qwen/qwen3-coder-30b-a3b-instruct",
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
    // Evict oldest if at capacity
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
const historyDir = process.env.COUNCIL_HISTORY_DIR || join(homedir(), ".local", "share", "council-mcp", "history");
const MAX_HISTORY_ENTRIES = parseInt(process.env.COUNCIL_HISTORY_MAX, 10) || 100;

function logHistory(entry) {
  try {
    mkdirSync(historyDir, { recursive: true });
    const filename = `${Date.now()}-${createHash("sha256").update(entry.prompt).digest("hex").slice(0, 8)}.json`;
    writeFileSync(join(historyDir, filename), JSON.stringify(entry, null, 2));

    // Evict old entries if over limit
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
const MODEL_PRICING = {
  "deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
  "qwen/qwen3-coder-30b-a3b-instruct": { input: 0.20, output: 0.60 },
  "xiaomi/mimo-v2.5": { input: 0.10, output: 0.30 },
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
    join(homedir(), ".config", "council-mcp", "config.json"),
    join(process.cwd(), "council-mcp.json"),
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

  // F3.5: Custom councillor profiles
  if (profile && config.profiles && config.profiles[profile]) {
    councillors = config.profiles[profile];
  } else if (process.env.COUNCIL_PROFILE && config.profiles && config.profiles[process.env.COUNCIL_PROFILE]) {
    councillors = config.profiles[process.env.COUNCIL_PROFILE];
  } else if (process.env.COUNCIL_COUNCILLORS) {
    // F1.3: COUNCIL_COUNCILLORS env var (full override as JSON array)
    try {
      councillors = JSON.parse(process.env.COUNCIL_COUNCILLORS);
    } catch {
      councillors = config.councillors || DEFAULT_COUNCILLORS;
    }
  } else {
    councillors = config.councillors || DEFAULT_COUNCILLORS;
  }

  // F1.3: Individual model env var overrides
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

  // F1.5: COUNCIL_COUNT env var to limit default count
  const count = parseInt(process.env.COUNCIL_COUNT, 10);
  if (!isNaN(count) && count > 0 && count < councillors.length) {
    councillors = councillors.slice(0, count);
  }

  return councillors;
}

// ─── API Key Resolution ──────────────────────────────────────────────────────
function getApiKey() {
  // 1. Environment variable
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }

  // 2. OpenCode auth
  const opencodeAuth = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (existsSync(opencodeAuth)) {
    try {
      const auth = JSON.parse(readFileSync(opencodeAuth, "utf-8"));
      if (auth.openrouter?.key) return auth.openrouter.key;
    } catch {}
  }

  // 3. MiMoCode auth.json
  const mimocodeAuth = join(homedir(), ".local", "share", "mimocode", "auth.json");
  if (existsSync(mimocodeAuth)) {
    try {
      const auth = JSON.parse(readFileSync(mimocodeAuth, "utf-8"));
      if (auth.openrouter?.key) return auth.openrouter.key;
    } catch {}
  }

  return "";
}

// ─── Query a Single Model (F1.4 + F2.2 + F2.4) ──────────────────────────────
async function queryModel(model, systemPrompt, userPrompt, apiKey, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, useCache = true } = options;

  // F2.2: Check cache first
  if (useCache) {
    const cached = cache.get(model, systemPrompt, userPrompt);
    if (cached) return cached;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const startMs = Date.now();
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/council-mcp",
          "X-Title": "Council MCP",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startMs;

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${err}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "(no response)";
      const usage = data.usage || {};

      const result = {
        content,
        latencyMs,
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        },
      };

      // F2.2: Store in cache
      if (useCache) {
        cache.set(model, systemPrompt, userPrompt, result);
      }

      return result;
    } catch (err) {
      const isRetryable = err.name === "AbortError" || (err.message && err.message.includes("5"));
      if (attempt < maxRetries && isRetryable) {
        continue;
      }
      throw err;
    }
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────
const config = loadConfig();
const timeoutMs = parseInt(process.env.COUNCIL_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;

const server = new McpServer({
  name: "council",
  version: "1.3.0",
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

server.tool(
  "council",
  "Query multiple AI models in parallel for consensus on a question or decision. Returns each model's perspective for synthesis.",
  {
    prompt: z.string().describe("The question or topic for the council to analyze"),
    rounds: z.number().int().min(1).max(3).optional().default(1)
      .describe("Number of refinement rounds (1 = parallel only, 2-3 = models see each other's responses). Default: 1"),
    mode: z.enum(["parallel", "debate", "review", "brainstorm"]).optional().default("parallel")
      .describe("Council interaction mode. Default: parallel"),
    format: z.enum(["markdown", "json", "both", "compact"]).optional().default("markdown")
      .describe("Output format. 'compact' shows summary only. Default: markdown"),
    profile: z.string().optional()
      .describe("Named councillor profile from config (e.g., 'debug', 'arch'). Overrides default councillors."),
  },
  async ({ prompt, rounds, mode, format, profile }, extra) => {
    const councillors = resolveCouncillors(config, profile);
    const apiKey = getApiKey();
    if (!apiKey) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No OpenRouter API key found. Set OPENROUTER_API_KEY env var, or add key to ~/.local/share/opencode/auth.json or ~/.local/share/mimocode/auth.json",
          },
        ],
      };
    }

    await sendLog(extra, "info", `Council query started (${councillors.length} models, ${mode} mode, ${rounds} round${rounds > 1 ? "s" : ""})`);
    const allRoundResults = [];

    if (mode === "parallel") {
      // ─── Parallel mode (original behavior) ──────────────────────────────
      const round1Tasks = councillors.map((c, i) => {
        const sysPrompt = getModeSystemPrompt(mode, c, null);
        return sendProgress(extra, `Querying ${c.name} (${c.model})...`, i, councillors.length)
          .then(() => {
            if (extra.signal.aborted) throw new Error("Cancelled");
            return queryModel(c.model, sysPrompt, prompt, apiKey, { timeoutMs });
          })
          .then(async (result) => {
            await sendProgress(extra, `${c.name} completed (${(result.latencyMs / 1000).toFixed(1)}s)`, i + 1, councillors.length);
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

      // Rounds 2+: refinement with cross-context
      for (let round = 1; round < rounds; round++) {
        if (extra.signal.aborted) {
          await sendLog(extra, "warning", "Council query cancelled");
          break;
        }
        await sendLog(extra, "info", `Starting refinement round ${round + 1}/${rounds}`);
        const priorContext = allRoundResults
          .flatMap((r) => r.filter((x) => x.response).map((x) => `[${x.name}]: ${x.response}`))
          .join("\n\n");

        const refinementTasks = councillors.map((c, i) => {
          const sysPrompt = getModeSystemPrompt(mode, c, priorContext);
          const prevResponse = round1Results[i]?.response;
          const refinementPrompt = `Previous perspectives:\n\n${priorContext}\n\nYour previous response: ${prevResponse || "(no response)"}\n\nRevisit your position. Identify where you agree/disagree and why. Be concise.`;
          return sendProgress(extra, `Round ${round + 1}: Querying ${c.name}...`, i, councillors.length)
            .then(() => queryModel(c.model, sysPrompt, refinementPrompt, apiKey, { timeoutMs }))
            .then(async (result) => {
              await sendProgress(extra, `Round ${round + 1}: ${c.name} completed`, i + 1, councillors.length);
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
      // ─── Debate mode: models argue opposing sides ───────────────────────
      // First councillor argues FOR, second AGAINST, third provides judge perspective
      const positions = ["FOR", "AGAINST", "JUDGE"];

      await sendLog(extra, "info", "Starting debate (FOR / AGAINST / JUDGE)");
      const debateTasks = councillors.map((c, i) => {
        const position = positions[i] || "OBSERVER";
        const sysPrompt = `You are ${c.name}, a ${c.role}. You are arguing ${position} the following proposition. Take a clear stance, present evidence, and be persuasive. Be concise in 2-4 sentences.`;
        return sendProgress(extra, `Debate: ${c.name} arguing ${position}...`, i, councillors.length)
          .then(() => queryModel(c.model, sysPrompt, `Proposition: ${prompt}\n\nArgue ${position}.`, apiKey, { timeoutMs }))
          .then(async (result) => {
            await sendProgress(extra, `Debate: ${c.name} (${position}) completed`, i + 1, councillors.length);
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

      // If rounds > 1, debaters see each other's arguments and rebut
      for (let round = 1; round < rounds; round++) {
        await sendLog(extra, "info", `Debate rebuttal round ${round + 1}/${rounds}`);
        const priorContext = allRoundResults
          .flatMap((r) => r.filter((x) => x.response).map((x) => `[${x.name} (${x.position})]: ${x.response}`))
          .join("\n\n");

        const rebuttalTasks = councillors.map((c, i) => {
          const position = positions[i] || "OBSERVER";
          const sysPrompt = `You are ${c.name}, a ${c.role}. You are arguing ${position}. You have heard the other arguments. Rebut counterarguments and strengthen your position. Be concise.`;
          const rebuttalPrompt = `The debate so far:\n\n${priorContext}\n\nProvide your rebuttal for ${position}.`;
          return sendProgress(extra, `Rebuttal: ${c.name} (${position})...`, i, councillors.length)
            .then(() => queryModel(c.model, sysPrompt, rebuttalPrompt, apiKey, { timeoutMs }))
            .then(async (result) => {
              await sendProgress(extra, `Rebuttal: ${c.name} completed`, i + 1, councillors.length);
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
      // ─── Review mode: first model proposes, others critique ─────────────
      // First councillor generates, rest review
      const proposer = councillors[0];
      const reviewers = councillors.slice(1);

      await sendLog(extra, "info", `Review mode: ${proposer.name} generating proposal`);
      await sendProgress(extra, `${proposer.name} generating proposal...`, 0, councillors.length);

      // Step 1: proposer generates
      const proposalSysPrompt = getModeSystemPrompt(mode, proposer, null);
      const proposalResult = await queryModel(proposer.model, proposalSysPrompt, prompt, apiKey, { timeoutMs });
      const proposal = {
        name: proposer.name, model: proposer.model, role: proposer.role,
        response: proposalResult.content, latencyMs: proposalResult.latencyMs, usage: proposalResult.usage,
        position: "PROPOSAL",
      };
      allRoundResults.push([proposal]);
      await sendProgress(extra, `${proposer.name} proposal complete`, 1, councillors.length);

      // Step 2: reviewers critique
      await sendLog(extra, "info", `${reviewers.length} reviewers critiquing proposal`);
      const reviewTasks = reviewers.map((c, i) => {
        const sysPrompt = getModeSystemPrompt(mode, c, proposal.response);
        const reviewPrompt = `Proposal to review:\n\n${proposal.response}\n\nProvide constructive criticism: what works, what doesn't, and what's missing.`;
        return sendProgress(extra, `Review: ${c.name} critiquing...`, i + 1, councillors.length)
          .then(() => queryModel(c.model, sysPrompt, reviewPrompt, apiKey, { timeoutMs }))
          .then(async (result) => {
            await sendProgress(extra, `Review: ${c.name} complete`, i + 2, councillors.length);
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

      // Step 3 (if rounds > 1): proposer responds to reviews
      if (rounds > 1) {
        await sendLog(extra, "info", "Proposer responding to reviews");
        await sendProgress(extra, `${proposer.name} responding to reviews...`, 0, 1);
        const reviewContext = allRoundResults[1]
          .filter((x) => x.response)
          .map((x) => `[${x.name}]: ${x.response}`)
          .join("\n\n");
        const responsePrompt = `Your proposal:\n\n${proposal.response}\n\nReviews received:\n\n${reviewContext}\n\nRespond to the feedback. Acknowledge valid points and defend your design where appropriate.`;
        const responseResult = await queryModel(proposer.model, proposalSysPrompt, responsePrompt, apiKey, { timeoutMs });
        allRoundResults.push([{
          name: proposer.name, model: proposer.model, role: proposer.role,
          response: responseResult.content, latencyMs: responseResult.latencyMs, usage: responseResult.usage,
          position: "RESPONSE",
        }]);
        await sendProgress(extra, `${proposer.name} response complete`, 1, 1);
      }

    } else if (mode === "brainstorm") {
      // ─── Brainstorm mode: sequential build ──────────────────────────────
      await sendLog(extra, "info", "Starting brainstorm (sequential build)");
      const responses = [];

      for (let i = 0; i < councillors.length; i++) {
        if (extra.signal.aborted) {
          await sendLog(extra, "warning", "Brainstorm cancelled");
          break;
        }
        const c = councillors[i];
        await sendProgress(extra, `Brainstorm: ${c.name} building on ideas...`, i, councillors.length);
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

        const result = await queryModel(c.model, sysPrompt, userPrompt, apiKey, { timeoutMs });
        responses.push({
          name: c.name, model: c.model, role: c.role,
          response: result.content, latencyMs: result.latencyMs, usage: result.usage,
          position: `BUILD ${i + 1}`,
        });
        await sendProgress(extra, `Brainstorm: ${c.name} complete`, i + 1, councillors.length);
      }
      allRoundResults.push(responses);
    }

    // ─── Build output ────────────────────────────────────────────────────
    // Collect all results flat for summary
    const flatResults = allRoundResults.flat();
    const succeeded = flatResults.filter((r) => r.response).length;
    const totalLatency = flatResults.reduce((sum, r) => sum + (r.latencyMs || 0), 0);
    const totalTokens = flatResults.reduce((sum, r) => sum + (r.usage?.totalTokens || 0), 0);
    const totalCost = flatResults.reduce((sum, r) => sum + estimateCost(r.model, 0).totalCost * ((r.usage?.totalTokens || 0) / 500), 0);
    const agreement = detectAgreement(flatResults);
    const agreementIcon = { agreement: "✅", mixed: "⚠️", disagreement: "❌", insufficient: "❓" }[agreement.level];

    let output = `## Council Results — ${succeeded}/${flatResults.length} responded, ${(totalLatency / 1000).toFixed(1)}s total\n`;
    output += `**Consensus:** ${agreementIcon} ${agreement.label}`;
    if (agreement.score !== undefined) output += ` (${(agreement.score * 100).toFixed(0)}% overlap)`;
    output += "\n\n";

    // Summary table (F1: emoji, F2: cost, F3: quality flags)
    output += "| Councillor | Model | Status | Latency | Tokens | Cost |\n";
    output += "|------------|-------|--------|---------|--------|------|\n";
    for (const r of flatResults) {
      const quality = getQualityFlag(r);
      const latency = r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : "-";
      const tokens = r.usage?.totalTokens || 0;
      const est = estimateCost(r.model, 0);
      const cost = `$${(est.totalCost * (tokens / 500)).toFixed(4)}`;
      const position = r.position ? ` [${r.position}]` : "";
      output += `| ${r.name}${position} | ${r.model} | ${quality.icon} ${quality.label} | ${latency} | ${tokens} | ${cost} |\n`;
    }
    output += "\n---\n\n";

    // F4: Compact mode — skip detailed responses
    if (format === "compact") {
      output += `*Use format="markdown" for full responses.*\n`;
      output += `\n**Suggested follow-ups:**\n`;
      for (const q of suggestFollowUps(prompt, mode)) {
        output += `- ${q}\n`;
      }
      return { content: [{ type: "text", text: output }] };
    }

    // Detailed responses with quality flags (F3)
    for (let ri = 0; ri < allRoundResults.length; ri++) {
      if (allRoundResults.length > 1) {
        output += `### Round ${ri + 1}\n\n`;
      }
      for (const r of allRoundResults[ri]) {
        const positionTag = r.position ? ` [${r.position}]` : "";
        const quality = getQualityFlag(r);
        output += `### ${r.name} (${r.model})${positionTag} ${quality.icon}\n`;
        output += `*Role: ${r.role}*\n\n`;
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

    // F6: Suggested follow-ups
    output += `\n**Suggested follow-ups:**\n`;
    for (const q of suggestFollowUps(prompt, mode)) {
      output += `- ${q}\n`;
    }

    // F2.3: Structured output
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
        metadata: {
          totalRounds: rounds,
          mode,
          councillorCount: councillors.length,
          timestamp: new Date().toISOString(),
        },
      };

      if (format === "json") {
        return { content: [{ type: "text", text: JSON.stringify(jsonData, null, 2) }] };
      }
      output += "\n```json\n" + JSON.stringify(jsonData, null, 2) + "\n```\n";
    }

    // F3.1: Log history
    logHistory({
      timestamp: new Date().toISOString(),
      prompt, mode, rounds, format, profile: profile || null,
      councillors: councillors.map((c) => ({ name: c.name, model: c.model, role: c.role })),
      results: allRoundResults,
    });

    // F3.2: Create session for follow-up
    const sessionId = createSession(prompt, mode, rounds, allRoundResults);
    output += `\n*Session ID: ${sessionId} (use council_followup to continue this consultation)*\n`;

    await sendLog(extra, "info", `Council query complete (${succeeded}/${flatResults.length} succeeded, ${(totalLatency / 1000).toFixed(1)}s, ${totalTokens} tokens)`);
    return { content: [{ type: "text", text: output }] };
  }
);

// ─── F3.4: Health Check Tool ─────────────────────────────────────────────────
server.tool(
  "council_health",
  "Check which configured models are available and responding. Returns status and latency for each model.",
  {
    profile: z.string().optional()
      .describe("Named councillor profile to check. Defaults to standard councillors."),
  },
  async ({ profile }, extra) => {
    const councillors = resolveCouncillors(config, profile);
    const apiKey = getApiKey();
    if (!apiKey) {
      return { content: [{ type: "text", text: "Error: No OpenRouter API key found." }] };
    }

    await sendLog(extra, "info", `Health check: testing ${councillors.length} models`);
    const healthChecks = await Promise.allSettled(
      councillors.map(async (c, i) => {
        await sendProgress(extra, `Health check: Testing ${c.name} (${c.model})...`, i, councillors.length);
        const startMs = Date.now();
        try {
          const result = await queryModel(c.model, "Say OK", "Say OK", apiKey, {
            timeoutMs: 10000,
            useCache: false,
          });
          return {
            name: c.name,
            model: c.model,
            role: c.role,
            status: "healthy",
            latencyMs: Date.now() - startMs,
            response: result.content,
          };
        } catch (err) {
          return {
            name: c.name,
            model: c.model,
            role: c.role,
            status: "unhealthy",
            error: err.message,
            latencyMs: Date.now() - startMs,
          };
        }
      })
    );

    let output = "## Council Health Check\n\n";
    for (const r of healthChecks) {
      const result = r.status === "fulfilled" ? r.value : { name: "unknown", model: "unknown", status: "error", error: r.reason?.message };
      const icon = result.status === "healthy" ? "+" : "x";
      output += `[${icon}] ${result.name} (${result.model})\n`;
      if (result.status === "healthy") {
        output += `  Latency: ${(result.latencyMs / 1000).toFixed(1)}s\n\n`;
      } else {
        output += `  Error: ${result.error}\n\n`;
      }
    }

    const healthy = healthChecks.filter((r) => r.status === "fulfilled" && r.value.status === "healthy").length;
    output += `**${healthy}/${councillors.length} models healthy**\n`;

    return { content: [{ type: "text", text: output }] };
  }
);

// ─── F3.3: Cost Estimation Tool ──────────────────────────────────────────────
server.tool(
  "council_estimate",
  "Estimate the cost of a council query before executing. Returns per-model and total estimated cost.",
  {
    prompt: z.string().describe("The question or topic to estimate cost for"),
    rounds: z.number().int().min(1).max(3).optional().default(1)
      .describe("Number of refinement rounds. Default: 1"),
    mode: z.enum(["parallel", "debate", "review", "brainstorm"]).optional().default("parallel")
      .describe("Council interaction mode. Default: parallel"),
    profile: z.string().optional()
      .describe("Named councillor profile. Defaults to standard councillors."),
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
  "council_followup",
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
      return {
        content: [{ type: "text", text: `Error: Session ${sessionId} not found or expired (sessions expire after 30 minutes).` }],
      };
    }

    const councillors = resolveCouncillors(config, null);
    const apiKey = getApiKey();
    if (!apiKey) {
      return { content: [{ type: "text", text: "Error: No OpenRouter API key found." }] };
    }

    await sendLog(extra, "info", `Follow-up query on session ${sessionId}`);
    // Build context from previous results
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
          return {
            name: c.name, model: c.model, role: c.role,
            response: result.content, latencyMs: result.latencyMs, usage: result.usage,
          };
        });
    });

    const settled = await Promise.allSettled(tasks);
    const results = settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { name: councillors[i].name, model: councillors[i].model, role: councillors[i].role,
        response: null, error: r.reason?.message || "unknown", latencyMs: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    });

    // Log history
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
        metadata: {
          timestamp: new Date().toISOString(),
          councillorCount: councillors.length,
        },
      };

      if (format === "json") {
        return { content: [{ type: "text", text: JSON.stringify(jsonData, null, 2) }] };
      }
      output += "\n```json\n" + JSON.stringify(jsonData, null, 2) + "\n```\n";
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
