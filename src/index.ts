#!/usr/bin/env node
/**
 * Gate402 MCP server.
 *
 * Exposes Gate402's pay-per-call agent APIs as MCP tools so any MCP client
 * (Claude Desktop, Cursor, Cline, Windsurf, …) can use them directly.
 *
 * Monetization model: free tier first. On first use, if no GATE402_API_KEY is
 * configured, the server self-claims a free-credit key from POST /v1/free-key
 * and caches it on disk. Each tool call is billed against that key's balance via
 * the X-API-Key rail. When the free credit is exhausted the tool returns a
 * top-up link instead of failing silently. Power users can set GATE402_API_KEY
 * (a prepaid/postpaid account) to skip the free tier entirely.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer';
import TurndownService from 'turndown';
import { jsonrepair } from 'jsonrepair';

const BASE_URL = (process.env.GATE402_BASE_URL || 'https://gate402.app').replace(/\/+$/, '');
const CONFIG_DIR = process.env.GATE402_CONFIG_DIR || join(homedir(), '.gate402-mcp');
const KEY_FILE = join(CONFIG_DIR, 'key.json');
const TOP_UP_URL = `${BASE_URL}/ops/billing/checkout`;

/** Resolve a usable API key: explicit env var → cached free key → freshly claimed. */
let cachedKey: string | null = process.env.GATE402_API_KEY?.trim() || null;

async function loadCachedKey(): Promise<string | null> {
  if (cachedKey) return cachedKey;
  try {
    const raw = await readFile(KEY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { apiKey?: string };
    if (parsed.apiKey) {
      cachedKey = parsed.apiKey;
      return cachedKey;
    }
  } catch {
    /* no cached key yet */
  }
  return null;
}

async function claimFreeKey(): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/free-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  const data = (await res.json().catch(() => ({}))) as { apiKey?: string; error?: string; hint?: string };
  if (!res.ok || !data.apiKey) {
    const reason = data.error || `HTTP ${res.status}`;
    throw new Error(
      `Could not obtain a free Gate402 key (${reason}). ${data.hint || `Get a key with credit at ${TOP_UP_URL} and set GATE402_API_KEY.`}`
    );
  }
  cachedKey = data.apiKey;
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(KEY_FILE, JSON.stringify({ apiKey: data.apiKey, claimedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* non-fatal: in-memory key still works for this session */
  }
  return data.apiKey;
}

async function getApiKey(): Promise<string> {
  return (await loadCachedKey()) || (await claimFreeKey());
}

interface CallResult {
  ok: boolean;
  text: string;
}

/**
 * POST a paid Gate402 route with the X-API-Key rail (claiming a free key on
 * first use); map 402 to a friendly top-up message. (Free tools never reach
 * here — they run locally in localFreeTool.)
 */
async function callRoute(route: string, body: unknown): Promise<CallResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'X-API-Key': await getApiKey() };
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  } catch (err) {
    return { ok: false, text: `Gate402 unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = await res.text();

  if (res.status === 402) {
    return {
      ok: false,
      text:
        `Out of Gate402 free credit. Top up to keep calling this tool: ${TOP_UP_URL}\n` +
        `(Or set GATE402_API_KEY to a funded account.)`
    };
  }
  if (res.status === 401) {
    return { ok: false, text: `Gate402 key rejected. Set a valid GATE402_API_KEY, or remove it to claim a fresh free key.` };
  }
  if (!res.ok) {
    return { ok: false, text: `Gate402 returned HTTP ${res.status}: ${payload.slice(0, 500)}` };
  }

  // Try to surface the most useful field for each tool; fall back to raw JSON.
  try {
    const json = JSON.parse(payload);
    if (Array.isArray(json?.content) && json.content[0]?.text) {
      return { ok: true, text: String(json.content[0].text) };
    }
    if (typeof json?.compressed === 'string') {
      const stats = json.stats ? ` (${JSON.stringify(json.stats)})` : '';
      return { ok: true, text: `${json.compressed}${stats}` };
    }
    return { ok: true, text: JSON.stringify(json, null, 2) };
  } catch {
    return { ok: true, text: payload };
  }
}

const TOOLS: Tool[] = [
  {
    name: 'gate402_scrape',
    description:
      'Fetch any public URL, render client-side JS, strip nav/ads, and return clean LLM-ready Markdown. Pay-per-call ($0.002) via Gate402; free tier on first runs.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Public URL to fetch and convert to Markdown.' } },
      required: ['url']
    }
  },
  {
    name: 'gate402_scrape_stealth',
    description:
      'Hardened headless fetch for JS-heavy or lightly bot-protected pages. Use when gate402_scrape is blocked or returns little content. Pay-per-call ($0.05).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Protected URL to scrape.' } },
      required: ['url']
    }
  },
  {
    name: 'gate402_minify',
    description:
      'Compress text to cut downstream LLM token spend (~40%): strips filler, collapses JSON, densifies prose. Pay-per-call ($0.005/10k tokens).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to compress.' },
        format: { type: 'string', enum: ['auto', 'plain', 'markdown', 'json'], description: 'Hint for the compressor (default auto).' },
        aggressive: { type: 'boolean', description: 'Compress harder at some fidelity cost.' }
      },
      required: ['text']
    }
  },
  {
    name: 'gate402_dedup',
    description:
      'Semantic vector-cache lookup: exact-match then 0.88 cosine similarity. Returns a cache hit/miss for a query, sub-10ms. Pay-per-call ($0.001 hit / $0.003 miss).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look up in the cache.' },
        vector: { type: 'array', items: { type: 'number' }, description: 'Optional embedding to store on a miss.' },
        namespace: { type: 'string', description: 'Optional cache namespace.' },
        storeOnMiss: { type: 'boolean', description: 'Store the query on a miss for future hits.' }
      },
      required: ['query']
    }
  },
  {
    name: 'gate402_token_count',
    description:
      'FREE. Estimate the token count of a string (cl100k/o200k tokenizer). Use to budget context windows. No payment required.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to count tokens for.' } },
      required: ['text']
    }
  },
  {
    name: 'gate402_html_to_md',
    description:
      'FREE. Convert an HTML string you already have into clean Markdown. (To FETCH a live page instead, use gate402_scrape.) No payment required.',
    inputSchema: {
      type: 'object',
      properties: { html: { type: 'string', description: 'HTML to convert to Markdown.' } },
      required: ['html']
    }
  },
  {
    name: 'gate402_json_repair',
    description:
      'FREE. Coerce malformed / LLM-mangled JSON (trailing commas, single quotes, unquoted keys) into valid JSON. No payment required.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Broken JSON string to repair.' } },
      required: ['text']
    }
  }
];

/**
 * Free tools run LOCALLY inside this process — pure compute, no network, no key,
 * no public endpoint to abuse. They make the server more useful to install; the
 * paid tools (which do call the gateway) ride along.
 */
const FREE_TOOLS = new Set(['gate402_token_count', 'gate402_html_to_md', 'gate402_json_repair']);

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

function localFreeTool(name: string, args: Record<string, unknown>): CallResult {
  switch (name) {
    case 'gate402_token_count': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) return { ok: false, text: 'Provide { "text": "..." }' };
      let tokens: number;
      try {
        tokens = encode(text).length;
      } catch {
        tokens = Math.ceil(text.length / 4);
      }
      return {
        ok: true,
        text: JSON.stringify({
          tokens,
          chars: text.length,
          note: 'Estimate (cl100k/o200k). Cut these tokens ~40% with the paid gate402_minify tool.'
        })
      };
    }
    case 'gate402_html_to_md': {
      const html = typeof args.html === 'string' ? args.html : '';
      if (!html) return { ok: false, text: 'Provide { "html": "<...>" }' };
      try {
        return {
          ok: true,
          text: JSON.stringify({
            markdown: turndown.turndown(html),
            note: "Converts HTML you already have. To FETCH a live page (JS render / anti-bot), use the paid gate402_scrape tool."
          })
        };
      } catch (err) {
        return { ok: false, text: `Could not convert HTML: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'gate402_json_repair': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) return { ok: false, text: 'Provide { "text": "<broken json>" }' };
      try {
        const repaired = jsonrepair(text);
        return { ok: true, text: JSON.stringify({ repaired: JSON.parse(repaired), repairedString: repaired }) };
      } catch (err) {
        return { ok: false, text: `Unrepairable JSON: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    default:
      return { ok: false, text: `Unknown free tool: ${name}` };
  }
}

function bodyForTool(name: string, args: Record<string, unknown>): { route: string; body: unknown } {
  switch (name) {
    case 'gate402_scrape':
      return { route: '/v1/proxy', body: { arguments: { url: args.url } } };
    case 'gate402_scrape_stealth':
      return { route: '/v1/proxy/stealth', body: { url: args.url } };
    case 'gate402_minify':
      return { route: '/v1/minify', body: { text: args.text, format: args.format, aggressive: args.aggressive } };
    case 'gate402_dedup':
      return {
        route: '/v1/dedup',
        body: { query: args.query, vector: args.vector, namespace: args.namespace, storeOnMiss: args.storeOnMiss }
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'gate402-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const result = FREE_TOOLS.has(name)
      ? localFreeTool(name, args as Record<string, unknown>)
      : await (async () => {
          const { route, body } = bodyForTool(name, args as Record<string, unknown>);
          return callRoute(route, body);
        })();
    return { content: [{ type: 'text', text: result.text }], isError: !result.ok };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP stdio channel.
  console.error(`gate402-mcp running (base: ${BASE_URL})`);
}

main().catch((err) => {
  console.error('gate402-mcp fatal:', err);
  process.exit(1);
});
