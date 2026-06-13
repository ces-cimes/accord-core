#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";

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

// ─── API Key Resolution ──────────────────────────────────────────────────────
function getApiKey() {
  // 1. Environment variable
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }

  // 2. MiMoCode auth.json
  const mimocodeAuth = join(homedir(), ".local", "share", "mimocode", "auth.json");
  if (existsSync(mimocodeAuth)) {
    try {
      const auth = JSON.parse(readFileSync(mimocodeAuth, "utf-8"));
      if (auth.openrouter?.key) return auth.openrouter.key;
    } catch {}
  }

  // 3. OpenCode auth (if it exists)
  const opencodeAuth = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (existsSync(opencodeAuth)) {
    try {
      const auth = JSON.parse(readFileSync(opencodeAuth, "utf-8"));
      if (auth.openrouter?.key) return auth.openrouter.key;
    } catch {}
  }

  return "";
}

// ─── Query a Single Model ────────────────────────────────────────────────────
async function queryModel(model, systemPrompt, userPrompt, apiKey) {
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
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "(no response)";
}

// ─── MCP Server ──────────────────────────────────────────────────────────────
const config = loadConfig();
const councillors = config.councillors || DEFAULT_COUNCILLORS;

const server = new McpServer({
  name: "council",
  version: "1.0.0",
});

server.tool(
  "council",
  "Query multiple AI models in parallel for consensus on a question or decision. Returns each model's perspective for synthesis.",
  { prompt: z.string().describe("The question or topic for the council to analyze") },
  async ({ prompt }) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No OpenRouter API key found. Set OPENROUTER_API_KEY env var, or add key to ~/.local/share/mimocode/auth.json or ~/.config/opencode/auth.json",
          },
        ],
      };
    }

    const systemTemplate = (c) =>
      `You are ${c.name}, a ${c.role}. Answer concisely in 2-4 sentences. Be direct and opinionated.`;

    const tasks = councillors.map((c) =>
      queryModel(c.model, systemTemplate(c), prompt, apiKey)
        .then((response) => ({
          name: c.name,
          model: c.model,
          role: c.role,
          response,
        }))
    );

    const results = await Promise.allSettled(tasks);

    let output = "## Council Results\n\n";
    for (let i = 0; i < councillors.length; i++) {
      const c = councillors[i];
      const result = results[i];
      output += `### ${c.name} (${c.model})\n`;
      output += `*Role: ${c.role}*\n\n`;
      if (result.status === "fulfilled") {
        output += `${result.value.response}\n\n`;
      } else {
        output += `*Error: ${result.reason?.message || "unknown"}*\n\n`;
      }
      output += "---\n\n";
    }

    output += "*Synthesize these perspectives into a single verdict.*\n";

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
