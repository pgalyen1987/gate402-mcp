# gate402-mcp

MCP server for **[Gate402](https://gate402.app)** — pay-per-call agent APIs over HTTP 402 (x402 / USDC on Base). Gives any MCP client four tools with **no signup and a free tier on first runs**:

| Tool | What it does | Price |
|---|---|---|
| `gate402_scrape` | Fetch any public URL, render JS, strip nav/ads → clean LLM-ready Markdown | $0.002 |
| `gate402_scrape_stealth` | Hardened headless fetch for JS-heavy / bot-protected pages | $0.05 |
| `gate402_minify` | Compress text to cut downstream LLM token spend (~40%) | $0.005 / 10k tok |
| `gate402_dedup` | Semantic vector-cache lookup (exact + cosine) | $0.001 hit / $0.003 miss |
| `gate402_onchain` | On-chain wallet/token intel on Base (balances, EOA/contract, tx count, token metadata) | $0.01 |

…plus three **free** tools that run **locally in this process** (pure compute — no payment, no key, no network):

| Tool | What it does |
|---|---|
| `gate402_token_count` | Estimate the token count of a string (budget your context window) |
| `gate402_html_to_md` | Convert an HTML string you already have into clean Markdown |
| `gate402_json_repair` | Coerce malformed / LLM-mangled JSON into valid JSON |

## How billing works

On first use the server self-claims a **free-credit API key** from Gate402 and caches it at `~/.gate402-mcp/key.json`. Calls draw down that credit. When it runs out, tools return a top-up link instead of failing. To skip the free tier, set `GATE402_API_KEY` to a funded account ([top up](https://gate402.app/ops/billing/checkout)).

The payment *is* the auth — there are no accounts to create.

## Install

```bash
npm install -g gate402-mcp
```

Or run without installing via `npx gate402-mcp`.

## Configure your MCP client

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `claude mcp add`):

```json
{
  "mcpServers": {
    "gate402": {
      "command": "npx",
      "args": ["-y", "gate402-mcp"]
    }
  }
}
```

### Cursor / Cline / Windsurf

Same shape — point the MCP server `command` at `npx -y gate402-mcp`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `GATE402_API_KEY` | _(unset)_ | Use a funded account instead of the free tier. |
| `GATE402_BASE_URL` | `https://gate402.app` | Override the gateway (self-hosting / testing). |
| `GATE402_CONFIG_DIR` | `~/.gate402-mcp` | Where the cached free key is stored. |

## Develop

```bash
npm install
npm run build
npm start          # or: npm run dev
```

## License

MIT
