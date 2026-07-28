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
    if (route === '/v1/market/infer') {
      return {
        ok: false,
        text:
          `The Gate402 GPU marketplace is x402-native — it settles on-chain per call (escrow-on-success), so the free-tier / X-API-Key rail cannot pay it. ` +
          `Call POST ${BASE_URL}/v1/market/infer with an x402 payment client, or browse supply with gate402_providers. ` +
          `(The first-party gate402_infer and gate402_compute tools DO work on the free tier.)`
      };
    }
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
    // Inference: surface the completion + a compact usage/billing line.
    if (typeof json?.text === 'string' && json?.usage) {
      const u = json.usage;
      return {
        ok: true,
        text: `${json.text}\n\n— ${json.model} · ${u.promptTokens}+${u.completionTokens} tok · billed $${json.billedUsdc} (credit $${json.creditUsdc}) · receipt ${String(json.receipt?.sig || '').slice(0, 16)}…`
      };
    }
    // Compute: surface a run summary instead of the full receipt blob.
    if (json?.jobId) {
      return {
        ok: true,
        text: `job ${json.jobId} · ${json.node} (${json.gpu}) · exit ${json.exitCode} · billed ${json.billedSec}s of ${json.requestedSec}s (credit ${json.creditSec}s) · $${json.priceUsdc}\n${(json.logsTail || []).join('\n')}`
      };
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
    name: 'gate402_onchain',
    description:
      'On-chain wallet & token intelligence on Base: native ETH + ERC-20 balances, EOA/contract detection, tx count, and token metadata. Pay-per-call ($0.01).',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Base address — a wallet or an ERC-20 token contract (0x-hex).' },
        tokens: { type: 'array', items: { type: 'string' }, description: 'Optional extra ERC-20 contract addresses to check balances for.' }
      },
      required: ['address']
    }
  },
  {
    name: 'gate402_dex',
    description:
      'Live DEX price, liquidity, and 24h volume for a Base token across its trading pairs. Pay-per-call ($0.01).',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Base ERC-20 token contract address (0x-hex).' } },
      required: ['address']
    }
  },
  {
    name: 'gate402_news',
    description:
      'Recent news headlines + heuristic bull/bear sentiment for a ticker, company, or topic. Pay-per-call ($0.02).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Ticker, company, or topic (e.g. "NVDA", "ethereum ETF").' },
        limit: { type: 'number', description: 'Max headlines (1–25, default 10).' }
      },
      required: ['query']
    }
  },
  {
    name: 'gate402_edgar',
    description:
      'Latest SEC EDGAR filings (10-K/10-Q/8-K) for a US ticker or CIK, with direct document links. Pay-per-call ($0.02).',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'US stock ticker, e.g. AAPL (ticker or cik required).' },
        cik: { type: 'string', description: 'SEC CIK number (alternative to ticker).' },
        form: { type: 'string', description: 'Optional filing-type filter, e.g. "10-K", "8-K".' },
        limit: { type: 'number', description: 'Max filings (1–40, default 10).' }
      }
    }
  },
  {
    name: 'gate402_token_risk',
    description:
      'Rug/tradeability risk VERDICT for a Base token: a 0-100 score and SAFE/CAUTION/AVOID from liquidity depth, a live honeypot/sell-tax sim, holder concentration, DEX diversity, and pool age. The pre-trade safety check. Pay-per-call ($0.03).',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Base ERC-20 token contract address (0x-hex).' } },
      required: ['address']
    }
  },
  {
    name: 'gate402_momentum',
    description:
      'Factual momentum + order-flow signal for a Base token: price trend (5m-24h), buy/sell pressure, volume trend, classified RISING/FALLING/FLAT + ACCUMULATION/DISTRIBUTION and honeypot-gated. The read, not a prediction. Pay-per-call ($0.02).',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Base ERC-20 token contract address (0x-hex).' } },
      required: ['address']
    }
  },
  {
    name: 'gate402_best_swap',
    description:
      'Best-execution intel for a Base token: which DEX pool to trade on and the estimated price impact + total cost for a given trade size, ranked across pools with a split suggestion. Pay-per-call ($0.02).',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Base ERC-20 token contract address (0x-hex).' },
        sizeUsd: { type: 'number', description: 'Trade size in USD (default 1000).' }
      },
      required: ['address']
    }
  },
  {
    name: 'gate402_launches',
    description:
      'Radar of the freshest Base token launches (newest DEX pools), lightly pre-screened by liquidity/age/flow. Top-of-funnel discovery — pair with gate402_token_risk, gate402_momentum, gate402_best_swap. Pay-per-call ($0.02).',
    inputSchema: {
      type: 'object',
      properties: {
        minLiquidityUsd: { type: 'number', description: 'Minimum pool liquidity to include (default 1000).' },
        limit: { type: 'number', description: 'Max launches to return (default 15, cap 30).' }
      }
    }
  },
  {
    name: 'gate402_infer',
    description:
      'Run open-model LLM inference (Llama 3.1 8B/70B, Qwen 2.5, Mistral) and get a completion, paid per-token via Gate402 over x402. Prepay is on prompt + max_tokens; you are billed on actual token usage with the rest credited, and get a signed usage receipt. Free tier on first runs.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt / question.' },
        model: { type: 'string', enum: ['llama-3.1-8b', 'llama-3.1-70b', 'qwen-2.5-7b', 'mistral-small'], description: 'Open model to run (default llama-3.1-8b).' },
        system: { type: 'string', description: 'Optional system instruction.' },
        max_tokens: { type: 'number', description: 'Max completion tokens (default 512, cap 2048). Prepaid; unused is credited.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'gate402_compute',
    description:
      'Rent metered GPU/CPU compute to run a container job, paid per-second via Gate402 over x402. Scheduling prefers nodes with the model already warm; returns logs + a signed, verifiable execution receipt. Free tier on first runs.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'OCI container image to run (its entrypoint is the job).' },
        gpu: { type: 'string', enum: ['cpu', 'rtx4090', 'rtx5090', 'a100', 'h100'], description: 'GPU/CPU class to rent.' },
        durationSec: { type: 'number', description: 'Max wall-seconds to pre-pay for; unused time is refunded as credit.' },
        model: { type: 'string', description: 'Optional model id; scheduling prefers nodes with it already warm.' },
        cmd: { type: 'array', items: { type: 'string' }, description: 'Optional command override.' }
      },
      required: ['image', 'gpu', 'durationSec']
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
  },
  {
    name: 'gate402_market_infer',
    description:
      'Run LLM inference through the Gate402 GPU marketplace — routed to the cheapest healthy third-party provider, with escrow-on-success (you are only charged if the provider delivers). x402-native: it settles on-chain per call, so it needs an x402 payment client — the free-tier key does NOT pay the marketplace. Browse available supply/models/prices first with gate402_providers.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'A model offered by an active provider (see gate402_providers).' },
        prompt: { type: 'string', description: 'The user prompt / question.' },
        system: { type: 'string', description: 'Optional system instruction.' },
        max_tokens: { type: 'number', description: 'Max completion tokens.' }
      },
      required: ['model', 'prompt']
    }
  },
  {
    name: 'gate402_providers',
    description:
      'FREE. Browse the Gate402 GPU marketplace: list active third-party compute/inference providers with their model, per-call price (USDC), and reliability. Use to find supply before gate402_market_infer, or to check your own listing. No payment required.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'gate402_become_provider',
    description:
      'FREE. Get the exact steps to LIST your own GPU/compute as a Gate402 provider and earn per call — you keep 85%, paid out on-chain in USDC on Base (escrow-on-success). Pass your { endpointUrl, payoutWallet, model, priceUsdc } and it returns the EIP-191 message to sign with that wallet plus the ready-to-send registration request. No payment required.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointUrl: { type: 'string', description: 'Your OpenAI-compatible endpoint base URL, e.g. https://host/v1' },
        payoutWallet: { type: 'string', description: 'Base wallet address to receive payouts (0x…).' },
        model: { type: 'string', description: 'The model id you serve (e.g. llama-3.1-8b).' },
        priceUsdc: { type: 'number', description: 'Your price per call in USDC.' }
      }
    }
  }
];

/**
 * Free tools run LOCALLY inside this process — pure compute, no network, no key,
 * no public endpoint to abuse. They make the server more useful to install; the
 * paid tools (which do call the gateway) ride along.
 */
const FREE_TOOLS = new Set(['gate402_token_count', 'gate402_html_to_md', 'gate402_json_repair', 'gate402_become_provider']);

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
    case 'gate402_become_provider': {
      const endpointUrl = typeof args.endpointUrl === 'string' ? args.endpointUrl : '';
      const payoutWallet = typeof args.payoutWallet === 'string' ? args.payoutWallet : '';
      const model = typeof args.model === 'string' ? args.model : '';
      const priceUsdc = typeof args.priceUsdc === 'number' ? args.priceUsdc : undefined;
      if (!endpointUrl || !payoutWallet || !model || priceUsdc === undefined) {
        return { ok: false, text: 'Provide { endpointUrl, payoutWallet, model, priceUsdc } to generate your provider registration.' };
      }
      // The gateway verifies ownership by recovering this exact EIP-191 message.
      const ts = Date.now();
      const message = `Gate402 provider registration\nwallet: ${payoutWallet}\nendpoint: ${endpointUrl}\nmodel: ${model}\nts: ${ts}`;
      const body = { endpointUrl, payoutWallet, model, priceUsdc, ts, signature: '<sign the message above with this wallet>' };
      return {
        ok: true,
        text: JSON.stringify({
          how: 'You keep 85% of each call; Gate402 takes 15%. Payouts settle on-chain in USDC on Base, escrow-on-success (you are paid only when your endpoint delivers).',
          step1_signThisMessage: message,
          step2_postTo: `${BASE_URL}/v1/providers/register`,
          step2_body: body,
          note: 'Sign step1 with the payoutWallet private key (EIP-191 personal_sign / viem signMessage), put the signature in step2_body.signature, then POST step2_body. Verify your listing with gate402_providers.'
        }, null, 2)
      };
    }
    default:
      return { ok: false, text: `Unknown free tool: ${name}` };
  }
}

/** FREE marketplace browse — GET /v1/providers (public, no key, no payment). */
async function listMarketProviders(): Promise<CallResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/providers`, { headers: { accept: 'application/json' } });
  } catch (err) {
    return { ok: false, text: `Gate402 unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const payload = await res.text();
  if (!res.ok) return { ok: false, text: `Gate402 returned HTTP ${res.status}: ${payload.slice(0, 300)}` };
  let json: { providers?: Array<Record<string, unknown>>; feeBps?: number };
  try {
    json = JSON.parse(payload);
  } catch {
    return { ok: true, text: payload };
  }
  const provs = json.providers || [];
  if (provs.length === 0) {
    return {
      ok: true,
      text: 'No active providers in the Gate402 GPU marketplace yet. List yours with gate402_become_provider to be the first — you keep 85% of every call, paid on-chain in USDC.'
    };
  }
  const lines = provs.map((p) => {
    const calls = Number(p.calls || 0);
    const failures = Number(p.failures || 0);
    const ok = calls ? Math.round(((calls - failures) / calls) * 100) : 100;
    const avg = p.avgMs != null ? ` · ~${p.avgMs}ms` : '';
    return `- ${p.id}: ${p.model} · $${p.priceUsdc}/call · ${calls} calls, ${ok}% ok${avg}`;
  });
  return { ok: true, text: `Gate402 marketplace — ${provs.length} active provider(s):\n${lines.join('\n')}\n\nBuy with gate402_market_infer (x402-native).` };
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
    case 'gate402_onchain':
      return { route: '/v1/onchain', body: { address: args.address, tokens: args.tokens } };
    case 'gate402_dex':
      return { route: '/v1/dex', body: { address: args.address } };
    case 'gate402_news':
      return { route: '/v1/news', body: { query: args.query, limit: args.limit } };
    case 'gate402_edgar':
      return { route: '/v1/edgar', body: { ticker: args.ticker, cik: args.cik, form: args.form, limit: args.limit } };
    case 'gate402_token_risk':
      return { route: '/v1/token-risk', body: { address: args.address } };
    case 'gate402_momentum':
      return { route: '/v1/momentum', body: { address: args.address } };
    case 'gate402_best_swap':
      return { route: '/v1/best-swap', body: { address: args.address, sizeUsd: args.sizeUsd } };
    case 'gate402_launches':
      return { route: '/v1/launches', body: { minLiquidityUsd: args.minLiquidityUsd, limit: args.limit } };
    case 'gate402_infer': {
      const messages: Array<{ role: string; content: string }> = [];
      if (typeof args.system === 'string' && args.system.trim()) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: typeof args.prompt === 'string' ? args.prompt : '' });
      return { route: '/v1/infer', body: { model: args.model || 'llama-3.1-8b', messages, max_tokens: args.max_tokens } };
    }
    case 'gate402_compute':
      return { route: '/v1/compute', body: { image: args.image, gpu: args.gpu, durationSec: args.durationSec, model: args.model, cmd: args.cmd } };
    case 'gate402_market_infer': {
      const messages: Array<{ role: string; content: string }> = [];
      if (typeof args.system === 'string' && args.system.trim()) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: typeof args.prompt === 'string' ? args.prompt : '' });
      return { route: '/v1/market/infer', body: { model: args.model, messages, max_tokens: args.max_tokens } };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'gate402-mcp', version: '0.8.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const result = FREE_TOOLS.has(name)
      ? localFreeTool(name, args as Record<string, unknown>)
      : name === 'gate402_providers'
        ? await listMarketProviders()
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
