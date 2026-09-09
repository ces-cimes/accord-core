# accord-core

Multi-model council MCP server — query several AI models in parallel for consensus instead of trusting one, then synthesize a verdict from their answers. Works with any MCP client: Claude Desktop, Cursor, Windsurf, VS Code, OpenCode, MiMoCode, and more.

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

## Quick start

### 1. Get an API key

Get an OpenRouter API key at [openrouter.ai/keys](https://openrouter.ai/keys). If `OPENROUTER_API_KEY` isn't set, accord-core also reads an `openrouter` key from the `auth.json` of OpenCode, MiMoCode, Claude, Cursor, or Windsurf.

### 2. Configure your MCP client

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

#### Any other client

```bash
npm install -g accord-core
```

then point the client at `accord-core` as a stdio MCP server.

### 3. Environment variables

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
| `COUNCIL_HISTORY_DIR` | Directory for run history (default: `~/.local/share/accord-core/history`) | No |
| `COUNCIL_HISTORY_MAX` | Max history entries kept (default: 100) | No |
| `COUNCIL_SYSTEM_TEMPLATE` | Template for the parallel-mode system prompt (`{name}`/`{role}` placeholders) | No |
| `COUNCIL_NO_TUI` | Set to `1` to disable auto-spawning the TUI window | No |

## Tools

### `accord`

Starts a council run. The call returns a `runId` immediately and the job runs in the background, so `rounds > 1` never hits the client's tool timeout. Poll for the result with `accord_job`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | (required) | The question or topic to analyze |
| `rounds` | 1-3 | 1 | Refinement rounds (models see each other's responses) |
| `mode` | enum | `parallel` | Interaction mode: `parallel`, `debate`, `review`, `brainstorm` |
| `format` | enum | `markdown` | Output: `markdown`, `json`, `both`, `compact` |
| `profile` | string | null | Named councillor profile from config |

Each result includes a per-model status, an estimated cost column, an agreement level (Agreement / Mixed / Disagreement), and 2-3 suggested follow-ups. `format: "compact"` returns the summary only, without the full responses.

### `accord_job`

Polls a running council job until it completes. Returns `running` (check again shortly) or the full formatted result.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `runId` | string | — | The run ID returned by `accord` |
| `format` | enum | `markdown` | Output format |

### `accord_health`

Checks which configured models are available and responding.

| Parameter | Type | Description |
|-----------|------|-------------|
| `profile` | string | Optional profile to check |

### `accord_estimate`

Estimates the cost of a query before running it.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | (required) | Topic to estimate cost for |
| `rounds` | 1-3 | 1 | Number of refinement rounds |
| `mode` | enum | `parallel` | Interaction mode |
| `profile` | string | null | Councillor profile |

### `accord_followup`

Continues a previous council consultation with context intact. Sessions expire 30 minutes after the original run.

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Session ID from the previous `accord` call |
| `prompt` | string | Follow-up question |
| `format` | enum | Output format (`markdown`, `json`, `both`, `compact`) |

## Live TUI

Every run streams each model's tokens to `~/.local/share/accord-core/runs/<runId>/<model>.jsonl` and opens a separate terminal window with one live column per model. Reopen it later with:

```
npx accord-tui <runId>
```

The renderer uses OpenTUI under Bun and falls back to a dependency-free ANSI renderer under plain Node, so both runtimes work. Set `COUNCIL_NO_TUI=1` to skip the auto-spawn.

## Council modes

### parallel (default)

All councillors answer the same prompt independently. Fastest, cheapest.

### debate

Councillors take fixed positions: the first argues FOR, the second AGAINST, a third acts as JUDGE; any councillors beyond that are observers.

### review

The first councillor drafts a proposal, the rest critique it.

### brainstorm

Sequential build — each councillor extends what the previous ones contributed.

## Usage

```
accord(prompt="Should we use microservices?", mode="debate", rounds=2)
# → Council run <runId> started in the background.

accord_job(runId="<runId>")
# → Run <runId> is still running (debate, round 1/2). Poll again shortly.

accord_job(runId="<runId>")
# → ## Council Results — 3/3 responded, 12.4s total
```

## Configuration

### Custom councillors

Config is read from `~/.config/accord-core/config.json`, or `accord-core.json` in the working directory:

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

Or override the default councillors via environment:

```bash
export COUNCIL_ALPHA_MODEL="anthropic/claude-sonnet-4"
export COUNCIL_BETA_MODEL="openai/gpt-4o"
export COUNCIL_GAMMA_MODEL="google/gemini-2.5-flash"
```

### Councillor profiles

Named profiles for different use cases:

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

Use via the `profile` parameter or `COUNCIL_PROFILE`:

```
accord(prompt="How to fix this memory leak?", profile="debug")
```

All models are accessed through [OpenRouter](https://openrouter.ai/).

## Development

```bash
git clone https://github.com/ces-cimes/accord-core.git
cd accord-core
npm install
npm test
```

## License

MIT