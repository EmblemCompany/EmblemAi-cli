/**
 * x402.js — x402 Payment Plugin for Emblem Agent Wallet CLI
 *
 * Discovery via XGate (https://api.xgate.run)
 * Payment via x402 protocol (PAYMENT-SIGNATURE header for v2, X-PAYMENT for v1)
 * Signing via auth-sdk (toViemAccount, toSolanaWeb3Signer)
 *
 * SECURITY: Auth tokens (JWT) are NEVER sent to external services.
 * Only passed to the configured local Hustle server for wallet-access tools.
 *
 * COMPATIBILITY: Handles both x402 v1 (X-PAYMENT header, bare network names like "base")
 * and x402 v2 (PAYMENT-SIGNATURE header, CAIP-2 network names like "eip155:8453").
 * The @x402/core SDK auto-selects the correct header based on paymentPayload.x402Version.
 *
 * PULL.md / strict v2 servers:
 *   - Hard-reject X-PAYMENT and X-Payment with HTTP 410.
 *   - Require X-WALLET-ADDRESS on both the initial 402 probe and the paid retry.
 *   - Require the `accepted` field in the submitted payload (exact copy of accepts[0]).
 *   - The SDK already writes `accepted` for v2 payloads — no manual work needed there.
 *   - We inject X-WALLET-ADDRESS when the signer address is available.
 *
 * v1 servers (Coinbase x402, most early implementors):
 *   - Expect X-PAYMENT header with base64(JSON) payload.
 *   - Network names are bare strings: "base", "base-sepolia", etc.
 *   - The SDK registerV1 path handles this automatically.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const XGATE_BASE = 'https://api.xgate.run';
const DEFAULT_HUSTLE_URL = 'https://agenthustle.ai';
const EMBLEMAI_DIR = process.env.EMBLEMAI_DIR || path.join(os.homedir(), '.emblemai');
const FAVORITES_FILE = path.join(EMBLEMAI_DIR, 'x402-favorites.json');

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
  //
  // FIX #1 — Signer address cache for X-WALLET-ADDRESS injection.
  // We cache the EVM wallet address here so executeCall() can attach it
  // to both the initial 402 probe and the paid retry without calling the
  // auth-sdk again on every request. Strict v2 servers (e.g. PULL.md)
  // require X-WALLET-ADDRESS on BOTH requests; omitting it from the probe
  // causes the server to return a wallet-agnostic quote which later fails
  // the "accepted" matching check.
  let _evmWalletAddress = null;

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
      // Cache address for X-WALLET-ADDRESS header injection
      _evmWalletAddress = evmSigner.address || null;
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

  // ── Helper: detect x402 version from a parsed paymentRequired object ─
  //
  // FIX #2 — Explicit version detection for diagnostic logging.
  // The SDK handles routing internally, but we log which wire format was
  // negotiated so callers can understand why a particular server accepted
  // or rejected the payment.
  function detectProtocolVersion(paymentRequired) {
    return paymentRequired?.x402Version ?? 'unknown';
  }

  // ── Helper: detect whether the server is a known strict v2 server ────
  //
  // FIX #3 — Heuristic detection of strict v2 servers that hard-reject v1
  // headers (returning HTTP 410 for X-PAYMENT / X-Payment). We detect this
  // by inspecting the paymentRequired object: v2 payloads always use CAIP-2
  // network strings and include a `resource` object. v1 payloads use bare
  // names and store `resource` as a plain URL string.
  //
  // This flag is informational. The SDK already routes to the correct header
  // via encodePaymentSignatureHeader(), which switches on x402Version. The
  // risk is only if a server reports x402Version 1 but actually rejects
  // X-PAYMENT — that case is undefined behavior per the spec.
  function isStrictV2Server(paymentRequired) {
    return paymentRequired?.x402Version === 2;
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
      description: 'Call any x402 payment-gated resource URL. Automatically handles 402 negotiation, payment signing, and settlement. Works with v1 servers (X-PAYMENT header) and strict v2 servers (PAYMENT-SIGNATURE header, e.g. PULL.md). For servers requiring wallet binding send walletAddress explicitly.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the x402 resource to call' },
          body: { type: 'string', description: 'JSON string of request body / tool parameters' },
          method: { type: 'string', description: 'HTTP method (default: POST)' },
          passAuth: { type: 'string', description: 'Set "true" to pass wallet auth (ONLY works for local Hustle server, ignored for external)' },
          // FIX #4 — walletAddress parameter exposed to the AI.
          // Strict v2 servers (PULL.md) require X-WALLET-ADDRESS on both the
          // initial 402 probe and the paid retry for wallet binding and
          // re-download continuity. The agent can pass the buyer wallet address
          // explicitly here; when omitted we fall back to the signer address
          // captured during client initialization. Either way the header is
          // sent on every request.
          walletAddress: { type: 'string', description: 'Buyer EVM wallet address (0x...). Sent as X-WALLET-ADDRESS for wallet-binding on strict v2 servers (e.g. PULL.md). Auto-detected from signer when omitted.' },
          // FIX #5 — clientMode parameter for strict headless agent mode.
          // PULL.md sends X-CLIENT-MODE: agent to suppress browser recovery
          // branches, default re-download session API, and REDOWNLOAD-SESSION
          // header acceptance. Without this, strict servers may return 410 for
          // deprecated session APIs if the agent accidentally triggers them.
          clientMode: { type: 'string', description: 'Set "agent" to enable strict headless agent mode (X-CLIENT-MODE: agent). Recommended for PULL.md and similar strict v2 servers.' },
          preferredNetwork: { type: 'string', description: 'Preferred payment network: "solana" for SOL USDC, "base" or "evm" for Base USDC. When set, only matching payment options are considered. If no match is found, falls back to all options.' },
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

    // ── Initialize client early so _evmWalletAddress is populated ───────
    // FIX #6 — We must call getHttpClient() before building headers so that
    // _evmWalletAddress is set by the EVM scheme registration inside it.
    // Previously this was only called after the first fetch, meaning the
    // wallet address was not available when constructing the initial probe
    // headers. Strict v2 servers use the wallet address from the probe to
    // bind the quote — the signed payment must come from the same address.
    const httpClient = await getHttpClient();

    // ── Resolve effective wallet address ──────────────────────────────────
    // FIX #7 — Resolve the effective wallet address from (in priority order):
    //   1. args.walletAddress — explicitly provided by the agent/user
    //   2. _evmWalletAddress — captured from the EVM signer during init
    //   3. undefined — omit the header; server may work without it (v1 servers)
    const effectiveWalletAddress = args.walletAddress || _evmWalletAddress || null;

    // ── Build base headers ────────────────────────────────────────────────
    // FIX #8 — Build headers that satisfy both v1 and strict v2 servers.
    //
    // Header matrix:
    //   Content-Type        → required by all servers for POST/PUT bodies.
    //   X-WALLET-ADDRESS    → required by strict v2 servers (PULL.md) on ALL
    //                         requests (probe + paid retry). Optional for v1.
    //                         We send it whenever we have an address — v1
    //                         servers ignore unknown headers, so this is safe.
    //   X-CLIENT-MODE       → optional but recommended for strict v2. Tells the
    //                         server we are a headless agent (suppress browser
    //                         recovery branches, disable session API fallback).
    //                         Safe to omit for v1 servers; they ignore it.
    //
    // Note: we deliberately do NOT pre-send X-PAYMENT or PAYMENT-SIGNATURE
    // on the probe. The probe must be header-free so the server returns a
    // fresh 402 with current pricing and nonce. The correct payment header
    // is attached only on the paid retry (Step 5), chosen by the SDK via
    // encodePaymentSignatureHeader() which switches on paymentPayload.x402Version.
    const headers = { 'Content-Type': 'application/json' };
    if (effectiveWalletAddress) {
      headers['X-WALLET-ADDRESS'] = effectiveWalletAddress;
    }
    if (args.clientMode === 'agent') {
      headers['X-CLIENT-MODE'] = 'agent';
    }

    const fetchOpts = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(bodyObj);
    }

    // Step 1: Initial request (no payment)
    const initialRes = await fetch(url, fetchOpts);

    // FIX #9 — Detect hard-deprecated header response (HTTP 410).
    // PULL.md and future strict v2 servers return 410 (Gone) when they
    // receive the deprecated X-PAYMENT or X-Payment headers. We detect this
    // and surface a clear diagnostic rather than silently returning the body.
    // In normal operation this should never trigger because we never pre-send
    // payment headers on the probe. It may trigger if the caller or a proxy
    // injects one, or if the server is quirky about its 410 use.
    if (initialRes.status === 410) {
      const body410 = await initialRes.json().catch(() => ({}));
      return {
        error: 'Server rejected request with HTTP 410 (Gone). This usually means a deprecated payment header (X-PAYMENT or X-Payment) was sent. Strict v2 servers hard-reject these headers.',
        status: 410,
        raw: body410,
      };
    }

    // Not a 402 — return directly
    if (initialRes.status !== 402) {
      const data = await initialRes.json().catch(() => ({ status: initialRes.status, statusText: initialRes.statusText }));
      return { status: initialRes.status, data };
    }

    // Step 2: Parse 402 payment requirements
    // FIX #10 — Robust body reading for multi-format 402 responses.
    //
    // v1 servers: paymentRequired lives in the response BODY as JSON with
    //   { x402Version: 1, accepts: [...] }. The body is the authoritative source.
    //
    // v2 servers: paymentRequired lives in the PAYMENT-REQUIRED response
    //   header as base64(JSON). The body is typically empty or contains
    //   supplementary info (e.g. PULL.md uses the body for copy-paste
    //   helpers and auth_message_template). We still read the body because:
    //     a) getPaymentRequiredResponse() uses it as fallback for v1.
    //     b) We may want to extract body diagnostics on failure.
    //
    // We must read the body BEFORE passing getHeader() to the SDK because
    // the Response body stream can only be read once. We capture body402
    // here regardless of whether the PAYMENT-REQUIRED header exists.
    const body402 = await initialRes.json().catch(() => null);

    let paymentRequired;
    try {
      paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => initialRes.headers.get(name),
        body402,
      );
    } catch (err) {
      // FIX #11 — Surface the raw body alongside the parse error.
      // Before this fix the raw body was shown but the error message gave
      // no hint about whether the server is v1 or v2. Now we include
      // explicit version-detection guidance in the error.
      const hasPaymentRequiredHeader = !!initialRes.headers.get('PAYMENT-REQUIRED');
      const hasLegacyHeader = !!(
        initialRes.headers.get('X-PAYMENT-REQUIRED') ||
        initialRes.headers.get('WWW-Authenticate')
      );
      return {
        error: 'Failed to parse 402 response',
        details: err.message,
        raw: body402,
        diagnostics: {
          hasPaymentRequiredHeader,
          hasLegacyHeader,
          hint: hasPaymentRequiredHeader
            ? 'v2 PAYMENT-REQUIRED header found but could not be decoded. The header value may be malformed base64 JSON.'
            : hasLegacyHeader
              ? 'Legacy header found but SDK does not support it. Server may be using a pre-standard x402 format.'
              : 'No recognized payment header found. Verify this URL is an x402 endpoint.',
        },
      };
    }

    // FIX #12 — Detect and log protocol version for diagnostics.
    const protocolVersion = detectProtocolVersion(paymentRequired);
    const strictV2 = isStrictV2Server(paymentRequired);

    // Log payment info
    const accepts = paymentRequired.accepts || [];
    const firstAccept = accepts[0];
    const priceUsd = firstAccept?.extra?.priceUsd;
    const tokenSymbol = firstAccept?.extra?.tokenSymbol;
    const network = firstAccept?.network;
    const assetTransferMethod = firstAccept?.extra?.assetTransferMethod || 'eip3009';
    console.log(`[x402] Protocol v${protocolVersion}${strictV2 ? ' (strict v2)' : ''} — Payment required: $${priceUsd?.toFixed(4) || '?'} USD (${tokenSymbol || network || '?'})`);
    console.log(`[x402] ${accepts.length} payment option(s) available, transfer method: ${assetTransferMethod}`);

    // FIX #13 — Warn when v1 server returns "base" as network.
    // The v2 EVM signer uses parseInt(network.split(":")[1]) to extract
    // the chain ID. If network is "base" (v1), it falls to the v1 path
    // via EVM_NETWORK_CHAIN_ID_MAP — that's fine. But if a misconfigured
    // v2 server erroneously advertises "base" in a v2 payload, payment
    // will fail with a schema error. We log this so it's diagnosable.
    if (strictV2 && network && !network.includes(':')) {
      console.warn(`[x402] WARNING: v2 server returned non-CAIP-2 network "${network}". Expected format: "eip155:8453". Payment may fail with "network mismatch".`);
    }

    // Step 3: Create payment payload (builds + signs tx)
    // If preferredNetwork is set, filter accepts to only matching network.
    if (args.preferredNetwork) {
      const pref = args.preferredNetwork.toLowerCase();
      const filtered = accepts.filter(a => {
        const net = (a.network || '').toLowerCase();
        if (pref === 'solana' || pref === 'sol') return net.includes('solana');
        if (pref === 'base' || pref === 'evm') return net === 'base' || net.includes('eip155:8453');
        return net.includes(pref);
      });
      if (filtered.length > 0) {
        paymentRequired.accepts = filtered;
        console.log(`[x402] Filtered to ${filtered.length} ${pref} payment option(s)`);
      } else {
        console.warn(`[x402] No "${pref}" payment options found, using all ${accepts.length} options`);
      }
    }

    let paymentPayload;
    try {
      paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    } catch (err) {
      return {
        error: 'Failed to create payment — check wallet balance',
        details: err.message,
        accepts: accepts.map(a => ({ network: a.network, asset: a.asset, amount: a.amount || a.maxAmountRequired })),
        // FIX #14 — Include transfer method in failure diagnostics.
        // When payment creation fails it's often because the signer does not
        // support the required transfer method (e.g. permit2 disabled). Surfacing
        // assetTransferMethod lets the agent know whether to retry with eip3009.
        assetTransferMethod,
      };
    }

    console.log('[x402] Payment signed, sending...');

    // Step 4: Encode payment header
    // The SDK returns the correct header name based on paymentPayload.x402Version:
    //   v2 → { 'PAYMENT-SIGNATURE': <base64> }   (accepted by PULL.md, etc.)
    //   v1 → { 'X-PAYMENT': <base64> }            (accepted by Coinbase x402 and similar)
    // This is the single point that prevents v1 headers from ever reaching strict v2 servers.
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    // FIX #15 — Log which wire header is being used.
    // This is critical for debugging compatibility issues. If a strict v2 server
    // returns a 410 on the paid retry, the agent knows exactly which header was sent.
    const paymentHeaderName = Object.keys(paymentHeaders)[0];
    console.log(`[x402] Sending payment via header: ${paymentHeaderName}`);

    // Step 5: Retry with payment
    // FIX #16 — Re-attach X-WALLET-ADDRESS and X-CLIENT-MODE on the paid retry.
    // Strict v2 servers (PULL.md) require X-WALLET-ADDRESS on BOTH the initial
    // 402 probe AND the paid retry. If X-WALLET-ADDRESS is missing from the
    // paid retry, the server cannot correlate the payment to the wallet that
    // received the quote, and the response body won't include X-PURCHASE-RECEIPT.
    // We spread `headers` (which already includes X-WALLET-ADDRESS and
    // X-CLIENT-MODE) before spreading paymentHeaders so the payment header
    // always wins if there is a name collision.
    const paidRes = await fetch(url, {
      method,
      headers: { ...headers, ...paymentHeaders },
      body: method !== 'GET' && method !== 'HEAD' ? JSON.stringify(bodyObj) : undefined,
    });

    // FIX #17 — Detect 410 on paid retry explicitly.
    // If the server returns 410 here, the payment header name itself is deprecated
    // (i.e. we ended up on the v1 path for a strict v2 server). This should not
    // happen in practice because the SDK routes v2 paymentRequired to PAYMENT-SIGNATURE
    // and v1 to X-PAYMENT. But if a server mis-reports its version we catch it here.
    if (paidRes.status === 410) {
      const body410 = await paidRes.json().catch(() => ({}));
      return {
        error: `Server rejected paid retry with HTTP 410 (Gone) for header "${paymentHeaderName}". The server is a strict v2 server that hard-rejects the payment header we sent. This indicates the server reported x402Version ${protocolVersion} but behaves as a strict v2 server. Report this as a server misconfiguration.`,
        status: 410,
        raw: body410,
      };
    }

    // Step 6: Parse result
    // FIX #18 — Capture X-PURCHASE-RECEIPT from response headers.
    // PULL.md (and any compliant strict v2 server) issues X-PURCHASE-RECEIPT
    // in the 200 response to a successful payment. This receipt must be stored
    // and reused for no-repay re-downloads. We surface it in the return value
    // so the caller can persist it. It is marked as sensitive.
    const purchaseReceipt = paidRes.headers.get('X-PURCHASE-RECEIPT') || null;
    if (purchaseReceipt) {
      console.log('[x402] X-PURCHASE-RECEIPT received — persist this securely for re-downloads.');
    }

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
      // Settlement header may not be present (some v1 servers omit PAYMENT-RESPONSE)
    }

    return {
      status: paidRes.status,
      data: result,
      settlement: settlement || undefined,
      paid: {
        priceUsd,
        tokenSymbol,
        network,
        assetTransferMethod,
        protocolVersion,
      },
      // FIX #19 — Surface purchase receipt in return value.
      // Keep this field name clearly labelled as sensitive so the calling
      // layer knows to persist it securely (not in logs or transcripts).
      purchaseReceipt: purchaseReceipt || undefined,
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
    version: '1.2.0',
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
        console.log(`[x402] Plugin loaded v1.2.0 (v1+v2 universal). Hustle server: ${hustleUrl}.${favMsg}`);
      },
    },
  };
}
