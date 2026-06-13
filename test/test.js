// Quick test — run with: node test/test.js
// Requires OPENROUTER_API_KEY env var or auth.json

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function getApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

  const authPath = join(homedir(), ".local", "share", "mimocode", "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      if (auth.openrouter?.key) return auth.openrouter.key;
    } catch {}
  }
  return "";
}

async function testCouncil() {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("No API key found. Set OPENROUTER_API_KEY or add to auth.json");
    process.exit(1);
  }

  console.log("Testing council with: What is 2+2?\n");

  const models = [
    { name: "Alpha", model: "deepseek/deepseek-r1" },
    { name: "Beta", model: "qwen/qwen3-coder-30b-a3b-instruct" },
    { name: "Gamma", model: "xiaomi/mimo-v2.5" },
  ];

  const tasks = models.map(async (m) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: m.model,
        messages: [{ role: "user", content: "What is 2+2?" }],
        max_tokens: 100,
      }),
    });
    const data = await res.json();
    return {
      name: m.name,
      model: m.model,
      response: data.choices?.[0]?.message?.content || "(no response)",
    };
  });

  const results = await Promise.all(tasks);
  for (const r of results) {
    console.log(`${r.name} (${r.model}):`);
    console.log(`  ${r.response}\n`);
  }

  console.log("✓ Council test passed");
}

testCouncil().catch(console.error);
