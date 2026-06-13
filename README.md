# council-mcp

Multi-model council MCP server — query AI models in parallel for consensus. Works with **OpenCode** and **MiMoCode**.

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

## Installation

### OpenCode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "council": {
      "type": "local",
      "command": ["npx", "-y", "council-mcp"],
      "enabled": true
    }
  }
}
```

### MiMoCode

Add to `~/.config/mimocode/mimocode.jsonc`:

```jsonc
{
  "mcp": {
    "council": {
      "type": "local",
      "command": ["npx", "-y", "council-mcp"],
      "enabled": true
    }
  }
}
```

Or install locally:

```bash
npm install -g council-mcp
```

Then config:

```jsonc
{
  "mcp": {
    "council": {
      "type": "local",
      "command": ["council-mcp"],
      "enabled": true
    }
  }
}
```

## Tools

### `council`

Main tool — query multiple models for consensus.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | (required) | The question or topic to analyze |
| `rounds` | 1-3 | 1 | Refinement rounds (models see each other's responses) |
| `mode` | enum | `parallel` | Interaction mode: `parallel`, `debate`, `review`, `brainstorm` |
| `format` | enum | `markdown` | Output: `markdown`, `json`, `both`, `compact` |
| `profile` | string | null | Named councillor profile from config |

### `council_health`

Check which models are available and responding.

| Parameter | Type | Description |
|-----------|------|-------------|
| `profile` | string | Optional profile to check |

### `council_estimate`

Estimate cost before executing.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | (required) | Topic to estimate cost for |
| `rounds` | 1-3 | 1 | Number of refinement rounds |
| `mode` | enum | `parallel` | Interaction mode |
| `profile` | string | null | Councillor profile |

### `council_followup`

Continue a previous council consultation with follow-up questions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Session ID from previous `council` call |
| `prompt` | string | Follow-up question |
| `format` | enum | Output format (`markdown`, `json`, `both`, `compact`) |

## Feedback Features

Every council call returns a summary with:
- **Status indicators**: ✅ OK, ❌ Error, ⚠️ Short response
- **Cost column**: Estimated token cost per model
- **Agreement detection**: Consensus level (Agreement/Mixed/Disagreement)
- **Suggested follow-ups**: 2-3 contextual questions at the end

Use `format: "compact"` for summary-only output (no verbose responses).

## Council Modes

### `parallel` (default)

All models respond independently to the same prompt. Fastest and cheapest.

### `debate`

Models argue opposing sides. First councillor argues FOR, second AGAINST, third provides a JUDGE perspective.

```
council(prompt="Should we use microservices?", mode="debate")
```

### `review`

First model generates a proposal, others critique it.

```
council(prompt="Design a REST API for user management", mode="review")
```

### `brainstorm`

Sequential build — each model extends the previous contributions.

```
council(prompt="Creative features for a chat app", mode="brainstorm")
```

## Configuration

### API Key

The server looks for your OpenRouter API key in this order:

1. `OPENROUTER_API_KEY` environment variable
2. `~/.local/share/opencode/auth.json` (OpenCode)
3. `~/.local/share/mimocode/auth.json` (MiMoCode)

Get a key at [openrouter.ai](https://openrouter.ai/keys).

### Custom Models

Create `~/.config/council-mcp/config.json`:

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
council(prompt="How to fix this memory leak?", profile="debug")
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | API key | (required) |
| `COUNCIL_ALPHA_MODEL` | Override Alpha's model | `deepseek/deepseek-r1` |
| `COUNCIL_BETA_MODEL` | Override Beta's model | `qwen/qwen3-coder-30b-a3b-instruct` |
| `COUNCIL_GAMMA_MODEL` | Override Gamma's model | `xiaomi/mimo-v2.5` |
| `COUNCIL_COUNCILLORS` | Full JSON array override | defaults |
| `COUNCIL_COUNT` | Limit number of councillors | 3 |
| `COUNCIL_TIMEOUT_MS` | Per-model timeout | 30000 |
| `COUNCIL_SYSTEM_TEMPLATE` | Global system prompt | built-in |
| `COUNCIL_PROFILE` | Default profile name | (none) |
| `COUNCIL_CACHE_TTL_MS` | Cache TTL (ms) | 300000 (5min) |
| `COUNCIL_CACHE_MAX` | Max cache entries | 50 |
| `COUNCIL_HISTORY_DIR` | History log directory | `~/.local/share/council-mcp/history` |
| `COUNCIL_HISTORY_MAX` | Max history entries | 100 |

## Default Models

| Councillor | Model | Role |
|------------|-------|------|
| Alpha | `deepseek/deepseek-r1` | Reasoning specialist |
| Beta | `qwen/qwen3-coder-30b-a3b-instruct` | Code-focused analysis |
| Gamma | `xiaomi/mimo-v2.5` | General perspective |

All models are accessed via [OpenRouter](https://openrouter.ai/).

## Development

```bash
git clone https://github.com/ces-cimes/council-mcp.git
cd council-mcp
npm install
npm test
```

## License

MIT
