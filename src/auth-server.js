/**
 * Local Auth Server for EmblemAI CLI
 *
 * Starts a temporary local HTTP server that serves an auth page and receives
 * the session callback. Ported from hustle-v5/src/auth/local-server.ts
 * and hustle-v5/src/auth/auth-page.ts (combined).
 */

import http from 'http';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

// Resolve the local SDK bundle so the browser loads the exact same version the CLI uses.
let SDK_BUNDLE = null;
let SDK_VERSION = 'unknown';
try {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve('@emblemvault/auth-sdk');
  const sdkRoot = join(dirname(sdkEntry), '..');
  const sdkMinPath = join(sdkRoot, 'dist', 'emblem-auth.min.js');
  SDK_BUNDLE = readFileSync(sdkMinPath, 'utf8');
  SDK_VERSION = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version;
  console.log(`[auth-server] Local SDK bundle loaded (v${SDK_VERSION})`);
} catch (err) {
  console.warn(`[auth-server] Could not load local SDK bundle: ${err.message} — will use CDN fallback`);
}

const DEFAULT_PORT = 18247;
const MAX_PORT_ATTEMPTS = 10;

/**
 * Start the local auth server.
 *
 * The server:
 * - Binds to 127.0.0.1 only (not network-accessible)
 * - Serves the auth page at GET /auth
 * - Receives session at POST /callback
 * - Auto-closes after successful callback
 *
 * @param {{ appId?: string, authUrl?: string, apiUrl?: string, port?: number }} config
 * @param {{ onSession: (session: object) => void, onError: (err: Error) => void }} callbacks
 * @returns {Promise<{ url: string, port: number, close: () => void }>}
 */
export function startAuthServer(config, callbacks) {
  return new Promise((resolve, reject) => {
    let currentPort = config.port || DEFAULT_PORT;
    let attempts = 0;

    const tryStartServer = () => {
      const server = http.createServer((req, res) => {
        // CORS headers for localhost
        res.setHeader('Access-Control-Allow-Origin', `http://localhost:${currentPort}`);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url || '/', `http://localhost:${currentPort}`);
        console.log(`[auth-server] ${req.method} ${url.pathname}`);

        // Serve the local SDK bundle
        if (req.method === 'GET' && url.pathname === '/sdk.js' && SDK_BUNDLE) {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(SDK_BUNDLE);
          return;
        }

        // Serve the auth page
        if (req.method === 'GET' && url.pathname === '/auth') {
           const html = generateAuthPage({
            appId: config.appId || 'emblem-agent-wallet',
            authUrl: config.authUrl || 'https://auth.emblemvault.ai',
            apiUrl: config.apiUrl || 'https://api.emblemvault.ai',
            callbackUrl: `http://localhost:${currentPort}/callback`,
            hasLocalSdk: !!SDK_BUNDLE,
          });

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }

        // Handle session callback
        if (req.method === 'POST' && url.pathname === '/callback') {
          let body = '';

          req.on('data', (chunk) => {
            body += chunk.toString();
          });

          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              const session = data.session;
              console.log(`[auth-server] Callback received — has authToken: ${!!session?.authToken}, has user: ${!!session?.user}`);

              if (!session?.authToken || !session?.user) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid session data' }));
                callbacks.onError(new Error('Invalid session data received'));
                return;
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));

              callbacks.onSession(session);
              console.log(`[auth-server] Session delivered to CLI — closing server in 1s`);

              setTimeout(() => {
                server.close();
              }, 1000);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
              callbacks.onError(new Error('Invalid JSON in callback request'));
            }
          });

          return;
        }

        // 404 for unknown routes
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < MAX_PORT_ATTEMPTS) {
          attempts++;
          currentPort++;
          tryStartServer();
        } else {
          reject(new Error(`Failed to start auth server: ${err.message}`));
        }
      });

      server.listen(currentPort, '127.0.0.1', () => {
        console.log(`[auth-server] Listening on http://localhost:${currentPort} (SDK: ${SDK_BUNDLE ? 'local v' + SDK_VERSION : 'CDN fallback'})`);
        resolve({
          url: `http://localhost:${currentPort}/auth`,
          port: currentPort,
          close: () => server.close(),
        });
      });
    };

    tryStartServer();
  });
}

/**
 * Escape HTML special characters to prevent XSS in injected config values.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate the HTML auth page.
 *
 * @param {{ appId: string, authUrl: string, apiUrl: string, callbackUrl: string }} config
 * @returns {string}
 */
function generateAuthPage(config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EmblemAI - Connect Wallet</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
      color: #fff;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 1rem;
    }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    .logo { font-size: 3rem; margin-bottom: 1rem; }
    h1 {
      font-size: 1.75rem; font-weight: 600; margin-bottom: 0.5rem;
      background: linear-gradient(90deg, #fff, #22d3ee);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle { color: #888; font-size: 0.9rem; margin-bottom: 2rem; }
    .status {
      display: flex; align-items: center; justify-content: center; gap: 0.75rem;
      padding: 1rem 1.5rem; background: rgba(255,255,255,0.05);
      border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);
    }
    .spinner {
      width: 20px; height: 20px;
      border: 2px solid rgba(255,255,255,0.2); border-top-color: #22d3ee;
      border-radius: 50%; animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text { color: #ccc; }
    .success { background: rgba(74,222,128,0.1); border-color: rgba(74,222,128,0.3); }
    .success .status-text { color: #4ade80; }
    .error { background: rgba(248,113,113,0.1); border-color: rgba(248,113,113,0.3); }
    .error .status-text { color: #f87171; }
    .checkmark { color: #4ade80; font-size: 1.25rem; }
    .error-icon { color: #f87171; font-size: 1.25rem; }
    .retry-btn {
      margin-top: 1rem; padding: 0.75rem 1.5rem;
      background: #22d3ee; color: #000; border: none; border-radius: 8px;
      font-size: 0.9rem; cursor: pointer; font-weight: 600; transition: background 0.2s;
    }
    .retry-btn:hover { background: #06b6d4; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">&#x26A1;</div>
    <h1>EmblemAI</h1>
    <p class="subtitle">Connect your wallet to continue</p>
    <div class="status" id="status">
      <div class="spinner" id="spinner"></div>
      <span class="status-text" id="statusText">Opening wallet connection...</span>
    </div>
    <button class="retry-btn hidden" id="retryBtn" onclick="retryAuth()">Try Again</button>
  </div>

  <script type="module">
    const CONFIG = {
      appId: '${escapeHtml(config.appId)}',
      authUrl: '${escapeHtml(config.authUrl)}',
      apiUrl: '${escapeHtml(config.apiUrl)}',
      callbackUrl: '${escapeHtml(config.callbackUrl)}'
    };

    const statusEl = document.getElementById('status');
    const spinnerEl = document.getElementById('spinner');
    const statusTextEl = document.getElementById('statusText');
    const retryBtn = document.getElementById('retryBtn');

    function setStatus(text, type = 'loading') {
      statusTextEl.textContent = text;
      statusEl.className = 'status ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
      spinnerEl.className = type === 'loading' ? 'spinner' : 'hidden';
      if (type === 'success') {
        spinnerEl.outerHTML = '<span class="checkmark">&#x2713;</span>';
      } else if (type === 'error') {
        spinnerEl.outerHTML = '<span class="error-icon">&#x2717;</span>';
        retryBtn.classList.remove('hidden');
      }
    }

    async function sendSessionToCLI(session) {
      console.log('[auth-page] onSuccess fired — sending session to CLI callback');
      setStatus('Sending to CLI...', 'loading');
      try {
        const response = await fetch(CONFIG.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session })
        });
        if (!response.ok) throw new Error('Failed to send session to CLI');
        console.log('[auth-page] Session sent successfully');
        setStatus('Connected! You can close this window.', 'success');
      } catch (err) {
        console.error('[auth-page] Failed to send session:', err);
        setStatus('Failed to connect to CLI: ' + err.message, 'error');
      }
    }

    async function startAuth() {
      try {
        let EmblemAuthSDK;
        console.log('[auth-page] Starting auth — local SDK available:', ${config.hasLocalSdk ? 'true' : 'false'});

        // Prefer the local SDK bundle served by the CLI (exact version match)
        if (${config.hasLocalSdk ? 'true' : 'false'}) {
          try {
            const script = document.createElement('script');
            script.src = '/sdk.js';
            await new Promise((resolve, reject) => {
              script.onload = resolve;
              script.onerror = reject;
              document.head.appendChild(script);
            });
            EmblemAuthSDK = window.EmblemAuth?.EmblemAuthSDK;
            if (EmblemAuthSDK) console.log('[auth-page] Loaded local SDK bundle');
          } catch (e) {
            console.warn('[auth-page] Failed to load local SDK:', e.message);
          }
        }

        // Fallback to CDN
        if (!EmblemAuthSDK) {
          const cdnUrls = [
            'https://esm.sh/@emblemvault/auth-sdk@latest',
            'https://cdn.skypack.dev/@emblemvault/auth-sdk@latest',
            'https://unpkg.com/@emblemvault/auth-sdk@latest/dist/index.mjs'
          ];
          for (const url of cdnUrls) {
            try {
              const module = await import(url);
              EmblemAuthSDK = module.EmblemAuthSDK || module.default?.EmblemAuthSDK;
              if (EmblemAuthSDK) break;
            } catch (e) {
              console.warn('Failed to load from ' + url + ':', e.message);
            }
          }
        }

        if (!EmblemAuthSDK) throw new Error('Could not load auth SDK');

        console.log('[auth-page] SDK loaded — opening auth modal');
        const sdk = new EmblemAuthSDK({
          appId: CONFIG.appId,
          authUrl: CONFIG.authUrl,
          apiUrl: CONFIG.apiUrl,
          onSuccess: sendSessionToCLI,
          onError: (err) => {
            setStatus('Authentication failed: ' + (err.message || 'Unknown error'), 'error');
          },
          onCancel: () => {
            setStatus('Authentication cancelled', 'error');
          }
        });

        sdk.openAuthModal();
      } catch (err) {
        setStatus('Failed to load auth SDK: ' + err.message, 'error');
      }
    }

    window.retryAuth = () => {
      retryBtn.classList.add('hidden');
      location.reload();
    };

    startAuth();
  </script>
</body>
</html>`;
}
