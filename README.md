# accord-core

Multi-model council MCP server — query AI models in parallel for consensus. Works with **any MCP client** (Claude Desktop, Cursor, Windsurf, VS Code, OpenCode, MiMoCode, and more).

## What It Does

Instead of relying on a single model, Council dispatches your question to multiple models simultaneously and returns all perspectives. You then synthesize a verdict from the diverse viewpoints.

```
Your question
     │
     ├──→ Alpha (deepseek-r1)      ──→ Reasoning perspective
     ├──→ Beta (qwen3-coder)       ──→ Code-focused perspective
     └──→ Gamma (mimo-v2.5)        ──→ General perspective
                                           │
                                           ▼
                                    Synthesized verdict
```

## Quick Start

### 1. Get an API Key

Get an OpenRouter API key at [openrouter.ai/keys](https://openrouter.ai/keys).

### 2. Configure Your MCP Client

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "accord-core": {
      "command": "npx",
      "args": ["-y", "accord-core"],
      "env": {
        "OPENROUTER_API_KEY": "your-key-here"
      }
    }
  }
}
```

#### Cursor / Windsurf

Add to MCP settings (Settings → MCP):

```json
{
  "accord-core": {
    "command": "npx",
    "args": ["-y", "accord-core"],
    "env": {
      "OPENROUTER_API_KEY": "your-key-here"
    }
  }
}
```

#### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "accord-core": {
      "command": "npx",
      "args": ["-y", "accord-core"],
      "env": {
        "OPENROUTER_API_KEY": "your-key-here"
      }
    }
  }
}
```

#### OpenCode / MiMoCode

Add to `~/.config/opencode/opencode.jsonc` or `mimocode.jsonc`:

```json
{
  "mcp": {
    "accord-core": {
      "type": "local",
      "command": ["npx", "-y", "accord-core"],
      "enabled": true
    }
  }
}
```

#### Universal (any MCP client)

```bash
npm install -g accord-core
```

Then configure your client to run `accord-core` as a stdio MCP server.

### 3. Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key | Yes |
| `COUNCIL_ALPHA_MODEL` | Override Alpha's model | No |
| `COUNCIL_BETA_MODEL` | Override Beta's model | No |
| `COUNCIL_GAMMA_MODEL` | Override Gamma's model | No |
| `COUNCIL_COUNCILLORS` | Full JSON array override | No |
| `COUNCIL_COUNT` | Limit number of councillors | No |
| `COUNCIL_TIMEOUT_MS` | Per-model timeout (default: 30000) | No |
| `COUNCIL_PROFILE` | Default profile name | No |
| `COUNCIL_CACHE_TTL_MS` | Cache TTL in ms (default: 300000) | No |
| `COUNCIL_CACHE_MAX` | Max cache entries (default: 50) | No |
| `COUNCIL_RUNS_DIR` | Directory for live run streams (default: `~/.local/share/accord-core/runs`) | No |
| `COUNCIL_NO_TUI` | Set to `1` to disable auto-spawning the TUI window | No |

## Tools

### `accord`

Main tool — query multiple models for consensus.

**Async by design.** `accord` starts a job and returns a `runId` immediately (it never blocks the tool call), so `rounds > 1` no longer hits the client's tool timeout. Fetch the final result with `accord_job`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | (required) | The question or topic to analyze |
| `rounds` | 1-3 | 1 | Refinement rounds (models see each other's responses) |
| `mode` | enum | `parallel` | Interaction mode: `parallel`, `debate`, `review`, `brainstorm` |
| `format` | enum | `markdown` | Output: `markdown`, `json`, `both`, `compact` |
| `profile` | string | null | Named councillor profile from config |

### `accord_job`

Poll a running council job (runId returned by `accord`) until it completes. **Non-blocking** — returns `running` immediately if the job isn't done, or the full formatted result once complete. Callers poll this repeatedly.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `runId` | string | — | The run ID returned by `accord` |
| `format` | enum | `markdown` | Output format |

### Live TUI

Every `accord` run streams each model's tokens to disk (`~/.local/share/accord-core/runs/<runId>/<model>.jsonl`) and auto-spawns a separate terminal window with one live column per model. To open it manually:

```
bun <install>/src/accord-tui.js <runId>
```

Uses **OpenTUI** when running under Bun ≥ 1.3 (its native binding isn't shipped for Node), and automatically falls back to a dependency-free ANSI renderer under plain Node — so `accord-tui <runId>` and the auto-spawned window work on Node or Bun. Set `COUNCIL_NO_TUI=1` (or run under CI) to disable the auto-spawn.

### `accord_health`

Check which models are available and responding.

| Parameter | Type | Description |
|-----------|------|-------------|
| `profile` | string | Optional profile to check |

### `accord_estimate`

Estimate cost before executing.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | (required) | Topic to estimate cost for |
| `rounds` | 1-3 | 1 | Number of refinement rounds |
| `mode` | enum | `parallel` | Interaction mode |
| `profile` | string | null | Councillor profile |

### `accord_followup`

Continue a previous council consultation with follow-up questions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Session ID from previous `accord` call |
| `prompt` | string | Follow-up question |
| `format` | enum | Output format (`markdown`, `json`, `both`, `compact`) |

## Council Modes

### `parallel` (default)

All models respond independently to the same prompt. Fastest and cheapest.

### `debate`

Models argue opposing sides. First councillor argues FOR, second AGAINST, third provides a JUDGE perspective.

```
accord(prompt="Should we use microservices?", mode="debate")
```

### `review`

First model generates a proposal, others critique it.

```
accord(prompt="Design a REST API for user management", mode="review")
```

### `brainstorm`

Sequential build — each model extends the previous contributions.

```
accord(prompt="Creative features for a chat app", mode="brainstorm")
```

## Usage

`accord` returns a `runId` immediately. To get the assembled result, call `accord_job(runId)` and keep polling until it no longer says "running":

```
accord(prompt="Should we use microservices?", mode="debate", rounds=2)
# → "Council run a1b2c3d4e5f6 started in the background..."

accord_job(runId="a1b2c3d4e5f6")
# → "running..."  (keep polling)
# → "## Council Results — ..." (once complete)
```

## Feedback Features

Every council call returns a summary with:
- **Status indicators**: ✅ OK, ❌ Error, ⚠️ Short response
- **Cost column**: Estimated token cost per model
- **Agreement detection**: Consensus level (Agreement/Mixed/Disagreement)
- **Suggested follow-ups**: 2-3 contextual questions at the end

Use `format: "compact"` for summary-only output (no verbose responses).

## Configuration

### Custom Models

Create `~/.config/accord-core/config.json`:

```json
{
  "councillors": [
    {
      "name": "Alpha",
      "role": "reasoning specialist",
      "model": "deepseek/deepseek-r1"
    },
    {
      "name": "Beta",
      "role": "code-focused analyst",
      "model": "qwen/qwen3-coder-30b-a3b-instruct"
    },
    {
      "name": "Gamma",
      "role": "general perspective analyst",
      "model": "xiaomi/mimo-v2.5"
    }
  ]
}
```

Or set models via environment variables:

```bash
export COUNCIL_ALPHA_MODEL="anthropic/claude-sonnet-4"
export COUNCIL_BETA_MODEL="openai/gpt-4o"
export COUNCIL_GAMMA_MODEL="google/gemini-2.5-flash"
```

### Councillor Profiles

Define named profiles for different use cases:

```json
{
  "councillors": [ /* default */ ],
  "profiles": {
    "debug": [
      { "name": "Debugger", "role": "bug hunter", "model": "deepseek/deepseek-r1" },
      { "name": "Reviewer", "role": "code reviewer", "model": "qwen/qwen3-coder-30b-a3b-instruct" }
    ],
    "arch": [
      { "name": "Architect", "role": "system design", "model": "anthropic/claude-sonnet-4" },
      { "name": "Pragmatist", "role": "practical constraints", "model": "xiaomi/mimo-v2.5" }
    ]
  }
}
```

Use via `profile` parameter or `COUNCIL_PROFILE` env var:

```
accord(prompt="How to fix this memory leak?", profile="debug")
```

## Default Models

| Councillor | Model | Role |
|------------|-------|------|
| Alpha | `deepseek/deepseek-r1` | Reasoning specialist |
| Beta | `qwen/qwen3-coder-30b-a3b-instruct` | Code-focused analysis |
| Gamma | `xiaomi/mimo-v2.5` | General perspective |

All models are accessed via [OpenRouter](https://openrouter.ai/).

## Development

```bash
git clone https://github.com/ces-cimes/accord-core.git
cd accord-core
npm install
npm test
```

## License

MIT
