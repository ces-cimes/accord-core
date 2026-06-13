# council-mcp

Multi-model council MCP server — query 3 AI models in parallel for consensus. Works with **MiMoCode** and **OpenCode**.

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

## Configuration

### API Key

The server looks for your OpenRouter API key in this order:

1. `OPENROUTER_API_KEY` environment variable
2. `~/.local/share/mimocode/auth.json` (MiMoCode)
3. `~/.config/opencode/auth.json` (OpenCode)

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

## Usage

Once configured, the `council` tool appears in your MCP tools list.

### Via Slash Command (MiMoCode)

```
/council Should we use SQLite or PostgreSQL for a SaaS app?
```

### Via Skill

Load the `compose:council` skill, then call:

```
council(prompt="Your question here")
```

### Direct Tool Call

The MCP tool accepts a single `prompt` parameter and returns formatted perspectives from all councillors.

## Default Models

| Councillor | Model | Role |
|------------|-------|------|
| Alpha | `deepseek/deepseek-r1` | Reasoning specialist |
| Beta | `qwen/qwen3-coder-30b-a3b-instruct` | Code-focused analysis |
| Gamma | `xiaomi/mimo-v2.5` | General perspective |

All models are accessed via [OpenRouter](https://openrouter.ai/).

## Development

```bash
git clone https://github.com/your-user/council-mcp.git
cd council-mcp
npm install
npm test
```

## License

MIT
