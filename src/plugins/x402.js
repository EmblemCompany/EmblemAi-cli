/**
 * x402.js — x402 Payment Plugin for Emblem Agent Wallet CLI
 *
 * Discovery via XGate (https://api.xgate.run)
 * Payment via x402 protocol (PAYMENT-SIGNATURE header)
 * Signing via auth-sdk (toViemAccount, toSolanaWeb3Signer)
 *
 * SECURITY: Auth tokens (JWT) are NEVER sent to external services.
 * Only passed to the configured local Hustle server for wallet-access tools.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const XGATE_BASE = 'https://api.xgate.run';
const DEFAULT_HUSTLE_URL = 'https://agenthustle.ai';
const FAVORITES_FILE = path.join(os.homedir(), '.emblemai', 'x402-favorites.json');

/**
 * @param {{ authSdk: object, hustleUrl?: string }} config
 * @returns {import('hustle-incognito').HustlePlugin}
 */
// ── Favorites persistence ──────────────────────────────────────────────────

function loadFavorites() {
  try {
    if (fs.existsSync(FAVORITES_FILE)) {
      return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveFavorites(favs) {
  const dir = path.dirname(FAVORITES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favs, null, 2));
}

export function createX402Plugin(config = {}) {
  const hustleUrl = config.hustleUrl || process.env.X402_HUSTLE_URL || DEFAULT_HUSTLE_URL;
  let _httpClient = null;

  // ── Lazy x402 client initialization ──────────────────────────────────

  async function getHttpClient() {
    if (_httpClient) return _httpClient;

    const { x402Client, x402HTTPClient } = await import('@x402/core/client');
    const client = new x402Client();

    // Register EVM scheme (Base USDC)
    try {
      const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
      const { createEvmSigner } = await import('./x402-signer.js');
      const evmSigner = await createEvmSigner(config.authSdk);
      registerExactEvmScheme(client, { signer: evmSigner });
    } catch (err) {
      console.warn('[x402] EVM scheme registration failed:', err.message);
    }

    // Register SVM scheme (Solana USDC)
    try {
      const { registerExactSvmScheme } = await import('@x402/svm/exact/client');
      const { createSvmSigner } = await import('./x402-signer.js');
      const svmSigner = await createSvmSigner(config.authSdk);
      registerExactSvmScheme(client, { signer: svmSigner });
    } catch (err) {
      console.warn('[x402] SVM scheme registration failed:', err.message);
    }

    _httpClient = new x402HTTPClient(client);
    return _httpClient;
  }

  // ── Helper: check if a URL is our own Hustle server ──────────────────

  function isLocalServer(url) {
    try {
      const u = new URL(url);
      const h = new URL(hustleUrl);
      return u.hostname === h.hostname;
    } catch {
      return false;
    }
  }

  // ── Tool definitions ─────────────────────────────────────────────────

  const tools = [
    {
      name: 'x402_search',
      description: 'Search x402 payment-gated services via XGate. Find paid APIs, tools, and AI services across the ecosystem.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free text search (e.g. "trending tokens", "swap", "AI agent")' },
          network: { type: 'string', description: 'Network filter: base, ethereum, polygon, solana (comma-separated)' },
          asset: { type: 'string', description: 'Asset filter (comma-separated asset names)' },
          limit: { type: 'number', description: 'Max results (1-50, default 10)' },
        },
      },
    },
    {
      name: 'x402_agents',
      description: 'Search AI agents registered on-chain via XGate. Find agents by capability, protocol, or description.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free text search' },
          protocols: { type: 'string', description: 'Protocol filter: A2A, MCP (comma-separated)' },
          skills: { type: 'string', description: 'Required skill names (comma-separated)' },
          limit: { type: 'number', description: 'Max results (1-50, default 10)' },
        },
      },
    },
    {
      name: 'x402_call',
      description: 'Call any x402 payment-gated resource URL. Automatically handles 402 negotiation, payment signing, and settlement. Works with any x402-compatible server.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the x402 resource to call' },
          body: { type: 'string', description: 'JSON string of request body / tool parameters' },
          method: { type: 'string', description: 'HTTP method (default: POST)' },
          passAuth: { type: 'string', description: 'Set "true" to pass wallet auth (ONLY works for local Hustle server, ignored for external)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'x402_stats',
      description: 'Get x402 ecosystem statistics from XGate — total agents, services, feedback, and chains.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'x402_favorites',
      description: 'Manage favorite x402 services. List, add, remove, or update notes on saved services.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action: list, add, remove, note (default: list)' },
          url: { type: 'string', description: 'Service URL (required for add/remove/note)' },
          note: { type: 'string', description: 'Note text (for add or note actions)' },
          name: { type: 'string', description: 'Display name (for add action, auto-detected if omitted)' },
          tags: { type: 'string', description: 'Comma-separated tags (for add action)' },
        },
      },
    },
  ];

  // ── Executors ────────────────────────────────────────────────────────

  async function executeSearch(args) {
    const params = new URLSearchParams();
    if (args.query) params.set('q', args.query);
    if (args.network) params.set('network', args.network);
    if (args.asset) params.set('asset', args.asset);
    params.set('limit', String(args.limit || 10));

    const res = await fetch(`${XGATE_BASE}/services?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { error: `XGate search failed (${res.status})`, details: err };
    }
    return res.json();
  }

  async function executeAgents(args) {
    const params = new URLSearchParams();
    if (args.query) params.set('q', args.query);
    if (args.protocols) params.set('protocols', args.protocols);
    if (args.skills) params.set('a2a_skills', args.skills);
    params.set('limit', String(args.limit || 10));

    const res = await fetch(`${XGATE_BASE}/agents?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { error: `XGate agent search failed (${res.status})`, details: err };
    }
    return res.json();
  }

  async function executeStats() {
    const res = await fetch(`${XGATE_BASE}/services/stats`);
    if (!res.ok) return { error: `XGate stats failed (${res.status})` };
    return res.json();
  }

  async function executeCall(args) {
    const url = args.url;
    const method = (args.method || 'POST').toUpperCase();
    let bodyObj = {};
    if (args.body) {
      try { bodyObj = JSON.parse(args.body); } catch { bodyObj = {}; }
    }

    // Auth passthrough: ONLY for our own Hustle server
    if (args.passAuth === 'true' && isLocalServer(url)) {
      try {
        const session = config.authSdk.getSession();
        const jwt = session?.authToken || session?.accessToken;
        if (jwt) {
          if (!bodyObj.params) bodyObj.params = {};
          if (typeof bodyObj.params === 'object') {
            bodyObj.params.emblemJwt = jwt;
          } else {
            bodyObj.emblemJwt = jwt;
          }
        }
      } catch (e) {
        console.warn('[x402] Could not inject auth:', e.message);
      }
    } else if (args.passAuth === 'true' && !isLocalServer(url)) {
      console.warn('[x402] Auth passthrough blocked — external URL:', url);
    }

    const headers = { 'Content-Type': 'application/json' };
    const fetchOpts = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(bodyObj);
    }

    // Step 1: Initial request (no payment)
    const initialRes = await fetch(url, fetchOpts);

    // Not a 402 — return directly
    if (initialRes.status !== 402) {
      const data = await initialRes.json().catch(() => ({ status: initialRes.status, statusText: initialRes.statusText }));
      return { status: initialRes.status, data };
    }

    // Step 2: Parse 402 payment requirements
    const httpClient = await getHttpClient();
    const body402 = await initialRes.json().catch(() => null);

    let paymentRequired;
    try {
      paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => initialRes.headers.get(name),
        body402,
      );
    } catch (err) {
      return { error: 'Failed to parse 402 response', details: err.message, raw: body402 };
    }

    // Log payment info
    const accepts = paymentRequired.accepts || [];
    const firstAccept = accepts[0];
    const priceUsd = firstAccept?.extra?.priceUsd;
    const tokenSymbol = firstAccept?.extra?.tokenSymbol;
    const network = firstAccept?.network;
    console.log(`[x402] Payment required: $${priceUsd?.toFixed(4) || '?'} USD (${tokenSymbol || network || '?'})`);
    console.log(`[x402] ${accepts.length} payment option(s) available`);

    // Step 3: Create payment payload (builds + signs tx)
    let paymentPayload;
    try {
      paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    } catch (err) {
      return {
        error: 'Failed to create payment — check wallet balance',
        details: err.message,
        accepts: accepts.map(a => ({ network: a.network, asset: a.asset, amount: a.amount })),
      };
    }

    console.log('[x402] Payment signed, sending...');

    // Step 4: Encode payment header
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    // Step 5: Retry with payment
    const paidRes = await fetch(url, {
      method,
      headers: { ...headers, ...paymentHeaders },
      body: method !== 'GET' && method !== 'HEAD' ? JSON.stringify(bodyObj) : undefined,
    });

    // Step 6: Parse result
    const result = await paidRes.json().catch(() => ({ status: paidRes.status }));

    // Step 7: Check settlement
    let settlement = null;
    try {
      settlement = httpClient.getPaymentSettleResponse(
        (name) => paidRes.headers.get(name),
      );
      if (settlement?.success) {
        console.log(`[x402] Settled! tx: ${settlement.transaction || 'pending'}`);
      }
    } catch {
      // Settlement header may not be present
    }

    return {
      status: paidRes.status,
      data: result,
      settlement: settlement || undefined,
      paid: {
        priceUsd,
        tokenSymbol,
        network,
      },
    };
  }

  // ── Favorites executor ──────────────────────────────────────────────

  async function executeFavorites(args) {
    const action = (args.action || 'list').toLowerCase();
    const favs = loadFavorites();

    if (action === 'list') {
      const entries = Object.entries(favs);
      if (entries.length === 0) return { favorites: [], message: 'No favorites saved yet.' };
      return {
        favorites: entries.map(([url, data]) => ({
          url,
          name: data.name || url,
          note: data.note || null,
          tags: data.tags || [],
          addedAt: data.addedAt,
          lastUsed: data.lastUsed || null,
          useCount: data.useCount || 0,
        })),
        count: entries.length,
      };
    }

    if (!args.url) {
      return { error: `Action "${action}" requires a url parameter.` };
    }

    const key = args.url;

    if (action === 'add') {
      favs[key] = {
        name: args.name || key.split('/').pop() || key,
        note: args.note || null,
        tags: args.tags ? args.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        addedAt: new Date().toISOString(),
        lastUsed: null,
        useCount: 0,
      };
      saveFavorites(favs);
      return { success: true, message: `Saved "${favs[key].name}" to favorites.`, favorite: favs[key] };
    }

    if (action === 'remove') {
      if (!favs[key]) return { error: `Not in favorites: ${key}` };
      const removed = favs[key];
      delete favs[key];
      saveFavorites(favs);
      return { success: true, message: `Removed "${removed.name}" from favorites.` };
    }

    if (action === 'note') {
      if (!favs[key]) {
        // Auto-add if not a favorite yet
        favs[key] = {
          name: args.name || key.split('/').pop() || key,
          note: args.note || '',
          tags: [],
          addedAt: new Date().toISOString(),
          lastUsed: null,
          useCount: 0,
        };
      } else {
        favs[key].note = args.note || '';
      }
      saveFavorites(favs);
      return { success: true, message: `Note updated for "${favs[key].name}".`, favorite: favs[key] };
    }

    return { error: `Unknown action: ${action}. Use list, add, remove, or note.` };
  }

  // ── Track favorite usage on x402_call ─────────────────────────────

  const _originalCall = executeCall;
  async function executeCallWithTracking(args) {
    const result = await _originalCall(args);
    // Update usage stats if this URL is a favorite
    if (args.url) {
      const favs = loadFavorites();
      if (favs[args.url]) {
        favs[args.url].lastUsed = new Date().toISOString();
        favs[args.url].useCount = (favs[args.url].useCount || 0) + 1;
        saveFavorites(favs);
      }
    }
    return result;
  }

  // ── Plugin object ────────────────────────────────────────────────────

  return {
    name: 'hustle-x402',
    version: '1.1.0',
    tools,
    executors: {
      x402_search: executeSearch,
      x402_agents: executeAgents,
      x402_call: executeCallWithTracking,
      x402_stats: executeStats,
      x402_favorites: executeFavorites,
    },
    hooks: {
      onRegister: () => {
        const favCount = Object.keys(loadFavorites()).length;
        const favMsg = favCount > 0 ? ` ${favCount} favorites loaded.` : '';
        console.log(`[x402] Plugin loaded. Hustle server: ${hustleUrl}.${favMsg}`);
      },
    },
  };
}
