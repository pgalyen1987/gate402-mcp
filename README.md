# gate402-mcp

MCP server for **[Gate402](https://gate402.app)** — pay-per-call agent APIs over HTTP 402 (x402 / USDC on Base). Gives any MCP client four tools with **no signup and a free tier on first runs**:

| Tool | What it does | Price |
|---|---|---|
| `gate402_scrape` | Fetch any public URL, render JS, strip nav/ads → clean LLM-ready Markdown | $0.002 |
| `gate402_scrape_stealth` | Hardened headless fetch for JS-heavy / bot-protected pages | $0.05 |
| `gate402_minify` | Compress text to cut downstream LLM token spend (~40%) | $0.005 / 10k tok |
| `gate402_dedup` | Semantic vector-cache lookup (exact + cosine) | $0.001 hit / $0.003 miss |
| `gate402_onchain` | On-chain wallet/token intel on Base (balances, EOA/contract, tx count, token metadata) | $0.01 |
| `gate402_dex` | Live DEX price / liquidity / 24h volume for a Base token | $0.01 |
| `gate402_news` | Recent news headlines + bull/bear sentiment for a ticker/topic | $0.02 |
| `gate402_edgar` | Latest SEC EDGAR filings (10-K/10-Q/8-K) for a US ticker | $0.02 |

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

### Agent frameworks (LangChain, CrewAI, LlamaIndex)

gate402 is a standard stdio MCP server, so any framework with an MCP adapter can load all 11 tools:

**LangChain / LangGraph** (`langchain-mcp-adapters`):
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({"gate402": {"command": "npx", "args": ["-y", "gate402-mcp"], "transport": "stdio"}})
tools = await client.get_tools()   # feed into your agent
```

**CrewAI** (`MCPServerAdapter`):
```python
from crewai_tools import MCPServerAdapter
from mcp import StdioServerParameters
params = StdioServerParameters(command="npx", args=["-y", "gate402-mcp"])
with MCPServerAdapter(params) as tools:
    ...  # pass tools to your Crew
```

**LlamaIndex** (`McpToolSpec`):
```python
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec
tools = McpToolSpec(client=BasicMCPClient("npx", args=["-y", "gate402-mcp"])).to_tool_list()
```

Once wired, the agent calls the tools autonomously; the free-credit key is claimed on first use, and paid tools draw down from it.

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
