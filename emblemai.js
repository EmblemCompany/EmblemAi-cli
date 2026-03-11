#!/usr/bin/env node

/**
 * EmblemAI — Agent Command & Control
 *
 * Interactive mode (default):
 *   emblemai -p "password"
 *   emblemai  # Will prompt for password
 *
 * Agent mode (single message for AI agents):
 *   emblemai --agent -p "password" -m "What are my balances?"
 *
 * PAYG billing:
 *   emblemai --payg on SOL     # Enable with SOL as payment token
 *   emblemai --payg on         # Enable (keeps current token)
 *   emblemai --payg off        # Disable
 *
 * Reset conversation:
 *   emblemai --reset
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import chalk from 'chalk';
import { getPassword, getCredential, authenticate, webLogin, promptPassword, authMenu, readPluginSecrets, migrateLegacyCredentials } from './src/auth.js';
import { saveSession } from './src/session-store.js';
import { processCommand } from './src/commands.js';
import { PluginManager } from './src/plugins/loader.js';
import * as glow from './src/glow.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('./package.json');

// History directory — partitioned by vaultId
const HISTORY_DIR = path.join(os.homedir(), '.emblemai', 'history');

// ── Formatting (hustle-v5 style) ────────────────────────────────────────────

const fmt = {
  brand: chalk.bold.cyan,
  dim: chalk.dim,
  success: (msg) => `${chalk.green('✓')} ${chalk.green(msg)}`,
  error: (msg) => `${chalk.red('✗')} ${chalk.red(msg)}`,
  warning: (msg) => `${chalk.yellow('⚠')} ${chalk.yellow(msg)}`,
  info: (msg) => `${chalk.cyan('ℹ')} ${chalk.cyan(msg)}`,
  thinking: () => `\n${chalk.dim('─── ◈ Thinking... ───')}\n`,
  complete: () => `\n${chalk.dim('─── ◈ Complete ───')}\n`,
  toolCall: (name, args) => {
    const argsStr = args ? formatToolInput(args) : '';
    if (argsStr) return `  ${chalk.dim('[Tool]')} ${chalk.gray(name)} ${chalk.dim('·')} ${chalk.gray(argsStr)}`;
    return `  ${chalk.dim('[Tool]')} ${chalk.gray(name)}`;
  },
};

function formatToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const pairs = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    let v;
    if (typeof value === 'string') {
      v = value.length > 30 ? value.slice(0, 27) + '...' : value;
      v = v.replace(/\n/g, ' ');
    } else if (Array.isArray(value)) {
      v = `[${value.length} items]`;
    } else if (typeof value === 'object') {
      v = '{...}';
    } else {
      v = String(value);
    }
    pairs.push(`${key}=${v}`);
  }
  const result = pairs.join(', ');
  return result.length > 80 ? result.slice(0, 77) + '...' : result;
}

// ── Glow breakpoint detection (smallest renderable markdown unit) ───────────

function _findGlowBreakpoint(text) {
  // Priority 1: paragraph break (double newline)
  const pp = text.indexOf('\n\n');
  if (pp !== -1) return pp + 2;

  // Priority 2: completed block element line at end of buffer
  if (text.endsWith('\n') && text.length > 1) {
    const lines = text.split('\n');
    if (lines.length >= 2) {
      const lastLine = lines[lines.length - 2].trim();
      if (/^#{1,6}\s/.test(lastLine)) return text.length;         // headers
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(lastLine)) return text.length; // HRs
    }
  }

  return -1;
}

// ── CLI Argument Parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flags) => {
  for (const flag of flags) {
    const index = args.indexOf(flag);
    if (index !== -1 && args[index + 1]) return args[index + 1];
  }
  return null;
};
const hasFlag = (flags) => flags.some(f => args.includes(f));

const isAgentMode = hasFlag(['--agent', '-a']);
const isReset = hasFlag(['--reset']);
const initialDebug = hasFlag(['--debug']);
const initialStream = hasFlag(['--stream']);
const initialLog = hasFlag(['--log']);
// --payg on [TOKEN] | --payg off
const paygArg = (() => {
  const idx = args.indexOf('--payg');
  if (idx === -1) return null;
  const action = args[idx + 1];
  if (action === 'on') return { action: 'on', token: args[idx + 2] && !args[idx + 2].startsWith('-') ? args[idx + 2].toUpperCase() : null };
  if (action === 'off') return { action: 'off' };
  return null;
})();
const passwordArg = getArg(['--password', '-p']);
const messageArg = getArg(['--message', '-m']);
const hustleUrlArg = getArg(['--hustle-url']);
const authUrlArg = getArg(['--auth-url']);
const apiUrlArg = getArg(['--api-url']);
const logFileArg = getArg(['--log-file']);
const restoreAuthArg = getArg(['--restore-auth']);

// Endpoint overrides
const hustleApiUrl = hustleUrlArg || process.env.HUSTLE_API_URL || undefined;
const authUrl = authUrlArg || process.env.EMBLEM_AUTH_URL || undefined;
const apiUrl = apiUrlArg || process.env.EMBLEM_API_URL || undefined;

// ── Stream Logger ──────────────────────────────────────────────────────────

const LOG_FILE = logFileArg || path.join(os.homedir(), '.emblemai-stream.log');
let _logEnabled = initialLog;
let _logFd = null;

function logOpen() {
  _logEnabled = true;
  if (_logFd) return;
  _logFd = fs.openSync(LOG_FILE, 'a');
  const sep = `\n${'═'.repeat(60)}\n[${new Date().toISOString()}] Session start\n${'═'.repeat(60)}\n`;
  fs.writeSync(_logFd, sep);
}

function logClose() {
  _logEnabled = false;
  if (!_logFd) return;
  fs.writeSync(_logFd, `[${new Date().toISOString()}] Session end\n`);
  fs.closeSync(_logFd);
  _logFd = null;
}

function log(tag, data) {
  if (!_logEnabled) return;
  if (!_logFd) logOpen();
  const ts = new Date().toISOString();
  let line;
  if (typeof data === 'string') {
    line = `[${ts}] [${tag}] ${data}\n`;
  } else {
    line = `[${ts}] [${tag}] ${JSON.stringify(data)}\n`;
  }
  fs.writeSync(_logFd, line);
}

// ── History Management (per-vault) ───────────────────────────────────────────

function historyPath(vaultId) {
  return path.join(HISTORY_DIR, `${vaultId}.json`);
}

function loadHistory(vaultId) {
  try {
    const fp = historyPath(vaultId);
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
  } catch {}
  return { vaultId, messages: [], created: new Date().toISOString() };
}

function saveHistory(history) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  history.lastUpdated = new Date().toISOString();
  fs.writeFileSync(historyPath(history.vaultId), JSON.stringify(history, null, 2));
}

function clearHistory(vaultId) {
  const fp = historyPath(vaultId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

/** Migrate legacy single-file history into per-vault directory */
function migrateHistory(vaultId) {
  const legacyFile = path.join(os.homedir(), '.emblemai-history.json');
  if (!fs.existsSync(legacyFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    if (data.messages && data.messages.length > 0) {
      data.vaultId = vaultId;
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      fs.writeFileSync(historyPath(vaultId), JSON.stringify(data, null, 2));
    }
    fs.unlinkSync(legacyFile);
  } catch {}
}

function buildMessages(msgs, pluginManager) {
  const sysMsg = pluginManager.getSystemMessage();
  return sysMsg ? [sysMsg, ...msgs] : msgs;
}

// ── Splash Screen ───────────────────────────────────────────────────────────
// Runs blessed in a child process so it never touches our stdin/terminal state.

async function showSplash() {
  try {
    const { execFileSync } = await import('child_process');
    execFileSync(process.execPath, ['-e', `
      const blessed = require('blessed');
      const screen = blessed.screen({ smartCSR: false, fullUnicode: false, warnings: false });
      const box = blessed.box({
        parent: screen, top: 'center', left: 'center',
        width: 56, height: 12, tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, bg: 'black' },
        align: 'center', valign: 'middle',
        content: [
          '', '{bold}{cyan-fg}EMBLEM AI{/}', '',
          '{white-fg}Agent Command & Control{/}',
          '{gray-fg}Powered by Hustle Incognito{/}',
          '', '{gray-fg}Initializing...{/}', '',
        ].join('\\n'),
      });
      screen.render();
      setTimeout(() => { screen.destroy(); process.exit(0); }, 2000);
    `], { stdio: 'inherit', timeout: 5000 });
  } catch {
    // blessed not available or timed out — skip
  }
}

// ── Spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval = null;
let spinnerIndex = 0;

function startSpinner() {
  spinnerIndex = 0;
  process.stdout.write('\x1B[?25l' + chalk.cyan(SPINNER_FRAMES[0]));
  spinnerInterval = setInterval(() => {
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
    process.stdout.write('\b' + chalk.cyan(SPINNER_FRAMES[spinnerIndex]));
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write('\b \b\x1B[?25h');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    // ── Restore auth backup ──────────────────────────────────────────────
    if (restoreAuthArg) {
      const backupPath = path.resolve(restoreAuthArg);
      if (!fs.existsSync(backupPath)) {
        console.error(fmt.error(`Backup file not found: ${backupPath}`));
        process.exit(1);
      }

      try {
        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        if (!backup.env || !backup.envKeys) {
          console.error(fmt.error('Invalid backup file — missing credentials.'));
          process.exit(1);
        }

        const emblemDir = path.join(os.homedir(), '.emblemai');
        fs.mkdirSync(emblemDir, { recursive: true, mode: 0o700 });

        fs.writeFileSync(path.join(emblemDir, '.env'), backup.env, { mode: 0o600 });
        fs.writeFileSync(path.join(emblemDir, '.env.keys'), backup.envKeys, { mode: 0o600 });

        if (backup.secrets) {
          fs.writeFileSync(path.join(emblemDir, 'secrets.json'), backup.secrets, { mode: 0o600 });
        }

        console.log(fmt.success('Auth restored from backup.'));
        console.log(chalk.dim('  Run emblemai to start.'));
      } catch (err) {
        console.error(fmt.error(`Failed to restore: ${err.message}`));
        process.exit(1);
      }
      process.exit(0);
    }

    // ── Migrate legacy credentials ───────────────────────────────────────
    migrateLegacyCredentials();

    // ── Authenticate ──────────────────────────────────────────────────────
    let authSdk;

    if (isAgentMode || isReset || passwordArg) {
      // Agent mode, reset, or explicit -p flag: password auth (unchanged)
      const passwordResult = await getPassword({ password: passwordArg, isAgentMode: isAgentMode || isReset });
      const password = passwordResult.password;

      if (!password || password.length < 16) {
        console.error(fmt.error('Password must be at least 16 characters.'));
        process.exit(1);
      }

      if (passwordResult.generated) {
        const out = isAgentMode ? process.stderr : process.stdout;
        out.write(chalk.yellow('\n⚠ Password auth created a new wallet identity on this machine.\n'));
        out.write(chalk.dim('  Your local credentials were saved for reuse. If this machine is lost and you have no backup, you may lose wallet access.\n'));
        out.write(chalk.dim('  Back up now with /auth → Backup Agent Auth, or restore later with emblemai --restore-auth <path>.\n\n'));
      }

      if (!isAgentMode && !isReset) console.log(chalk.dim('\nAuthenticating with Agent Hustle...'));

      ({ authSdk } = await authenticate(password, { authUrl, apiUrl }));
      // Save session so the ElizaOS plugin can pick it up from ~/.emblemai/session.json
      const sess = authSdk.getSession();
      if (sess) saveSession(sess);
    } else {
      // Interactive mode: try saved credentials before web login
      console.log(chalk.dim('\nChecking for saved session...'));

      // 1. Try saved session (session.json)
      const result = await webLogin({ authUrl, apiUrl, skipBrowser: true });

      if (result) {
        ({ authSdk } = result);
        console.log(fmt.success('Authenticated via saved session'));
      } else {
        // 2. Try stored password credentials (from agent mode or -p)
        const storedPassword = getCredential('EMBLEM_PASSWORD');

        if (storedPassword && storedPassword.length >= 16) {
          try {
            console.log(chalk.dim('Found saved credentials, authenticating...'));
            ({ authSdk } = await authenticate(storedPassword, { authUrl, apiUrl }));
            const sess = authSdk.getSession();
            if (sess) saveSession(sess);
            console.log(fmt.success('Authenticated via saved credentials'));
          } catch {
            // Stored password failed — continue to web login
            authSdk = null;
          }
        }

        // 3. Web login (browser) if nothing else worked
        if (!authSdk) {
          const webResult = await webLogin({ authUrl, apiUrl });

          if (webResult) {
            ({ authSdk } = webResult);
            console.log(fmt.success(webResult.source === 'saved' ? 'Authenticated via saved session' : 'Authenticated via browser'));
          } else {
            // 4. Fall back to password prompt
            console.log(chalk.dim('Falling back to password authentication...'));
            const passwordResult = await getPassword({});
            const password = passwordResult.password;

            if (!password || password.length < 16) {
              console.error(fmt.error('Password must be at least 16 characters.'));
              process.exit(1);
            }

            console.log(chalk.dim('\nAuthenticating with Agent Hustle...'));
            ({ authSdk } = await authenticate(password, { authUrl, apiUrl }));
          }
        }
      }
    }
    const vaultId = authSdk.getSession()?.user?.vaultId;

    // Migrate legacy single-file history to per-vault
    migrateHistory(vaultId);

    // Handle --reset (needs auth to know which vault)
    if (isReset) {
      clearHistory(vaultId);
      console.log('Conversation history cleared.');
      process.exit(0);
    }

    // ── Create Hustle Client ──────────────────────────────────────────────
    const { HustleIncognitoClient } = await import('hustle-incognito');

    const hustleClientConfig = { sdk: authSdk, debug: initialDebug };
    if (hustleApiUrl) hustleClientConfig.hustleApiUrl = hustleApiUrl;

    const client = new HustleIncognitoClient(hustleClientConfig);

    // ── Handle --payg (configure, then continue or exit) ───────────────────
    if (paygArg) {
      try {
        const config = { enabled: paygArg.action === 'on' };
        if (paygArg.token) config.payment_token = paygArg.token;
        const result = await client.configurePayg(config);
        if (result.success) {
          if (paygArg.action === 'on') {
            console.log(fmt.success(`PAYG billing enabled${paygArg.token ? ` (token: ${paygArg.token})` : ''}.`));
          } else {
            console.log(fmt.success('PAYG billing disabled.'));
          }
        } else {
          console.error(fmt.error(`Failed to ${paygArg.action === 'on' ? 'enable' : 'disable'} PAYG.`));
          process.exit(1);
        }
      } catch (err) {
        console.error(fmt.error(`PAYG error: ${err.message}`));
        process.exit(1);
      }
    }

    // ── Settings ──────────────────────────────────────────────────────────
    const settings = {
      debug: initialDebug,
      stream: !initialStream ? true : initialStream,
      retainHistory: true,
      selectedTools: [],
      model: null,
      glowEnabled: glow.detectGlow().installed,
      log: initialLog,
    };

    if (settings.log) logOpen();

    let lastIntentContext = null;
    let history = loadHistory(vaultId);

    // ── Plugin Manager ────────────────────────────────────────────────────
    const pluginManager = new PluginManager(client);

    // Build per-plugin config from env vars
    const pluginSecrets = readPluginSecrets();
    const pluginConfig = {};

    // ══════════════════════════════════════════════════════════════════════
    // AGENT MODE — single message, output, exit
    // ══════════════════════════════════════════════════════════════════════

    if (isAgentMode) {
      if (!messageArg) {
        console.error(fmt.error('Message required in agent mode. Use -m "your message"'));
        process.exit(1);
      }

      await pluginManager.loadAll(pluginConfig, { authSdk, credentials: { secrets: pluginSecrets } });

      process.stdout.write(chalk.dim('Thinking'));
      const progressInterval = setInterval(() => process.stdout.write(chalk.dim('.')), 2000);

      try {
        history.messages.push({ role: 'user', content: messageArg });
        const res = await client.chat(buildMessages(history.messages, pluginManager), { rawResponse: false });
        const response = /** @type {import('hustle-incognito').ProcessedResponse} */ (res);
        clearInterval(progressInterval);
        console.log('');
        history.messages.push({ role: 'assistant', content: response.content });
        saveHistory(history);
        const rendered = settings.glowEnabled ? glow.renderMarkdownSync(response.content) : response.content;
        console.log(rendered);
      } catch (error) {
        clearInterval(progressInterval);
        console.error('\n' + fmt.error(error.message));
        process.exit(1);
      }

      process.exit(0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // INTERACTIVE MODE — splash then readline loop (hustle-v5 style)
    // ══════════════════════════════════════════════════════════════════════

    // Show splash screen
    await showSplash();

    // Show banner after splash
    const W = 59; // inner width between ║ borders
    const pad = (s, visible) => s + ' '.repeat(Math.max(0, W - visible));
    console.log('');
    console.log(fmt.brand('╔' + '═'.repeat(W) + '╗'));
    console.log(fmt.brand('║') + ' '.repeat(W) + fmt.brand('║'));
    const title = `   ⚡ EMBLEM AI v${PKG_VERSION} — Agent Command & Control`;
    const titleLen = title.length + 1; // ⚡ renders as 2 columns
    console.log(fmt.brand('║') + pad(`   ${chalk.bold.white('⚡ EMBLEM AI')} ${chalk.dim(`v${PKG_VERSION} — Agent Command & Control`)}`, titleLen) + fmt.brand('║'));
    console.log(fmt.brand('║') + ' '.repeat(W) + fmt.brand('║'));
    const sub = '   Powered by Hustle Incognito';
    console.log(fmt.brand('║') + pad(`   ${chalk.dim('Powered by Hustle Incognito')}`, sub.length) + fmt.brand('║'));
    console.log(fmt.brand('║') + ' '.repeat(W) + fmt.brand('║'));
    console.log(fmt.brand('╚' + '═'.repeat(W) + '╝'));
    console.log('');

    // Load plugins
    console.log(chalk.dim('  Loading plugins...'));
    await pluginManager.loadAll(pluginConfig, { authSdk, credentials: { secrets: pluginSecrets } });
    const pluginList = pluginManager.list();
    const enabledPlugins = pluginList.filter(p => p.enabled);
    console.log(fmt.success(`${enabledPlugins.length} plugins loaded (${enabledPlugins.map(p => p.name.replace('@agenthustle/', '')).join(', ')})`));

    // Show connection info
    try {
      const vaultInfo = await authSdk.getVaultInfo();
      const evmAddr = vaultInfo.evmAddress;
      const solAddr = vaultInfo.solanaAddress || vaultInfo.address;
      if (evmAddr) console.log(chalk.dim(`  EVM: ${evmAddr.slice(0, 6)}...${evmAddr.slice(-4)}`));
      if (solAddr) console.log(chalk.dim(`  SOL: ${solAddr.slice(0, 4)}...${solAddr.slice(-4)}`));
    } catch {}

    // Show settings
    console.log(chalk.dim(`  Streaming: ${settings.stream ? 'enabled' : 'disabled'}`));
    if (settings.glowEnabled) console.log(chalk.dim('  Glow: enabled (markdown rendering)'));
    console.log('');
    console.log(chalk.dim('  Type /help for commands, /exit to quit.\n'));

    // ── Readline Loop ─────────────────────────────────────────────────────

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line) => {
        const cmds = ['/help', '/plugins', '/tools', '/auth', '/wallet',
          '/portfolio', '/model', '/stream', '/debug', '/history', '/payment',
          '/secrets', '/glow', '/log', '/reset', '/exit', '/settings'];
        const hits = cmds.filter(c => c.startsWith(line));
        return [hits.length ? hits : cmds, line];
      },
    });
    const prompt = () => new Promise(r => rl.question(chalk.cyan('emblem> '), r));

    const ctx = {
      client, settings, pluginManager, history, tui: null, authSdk, glow, saveHistory,
      promptText: (q) => new Promise(r => rl.question(q, r)),
      promptPassword,
      addLog: (type, msg) => {
        if (settings.debug) console.log(chalk.dim(`  [${type}] ${msg}`));
        log(type, msg);
      },
      appendMessage: (_role, content) => console.log(content),
      updateSidebar: () => {},
      log, logOpen, logClose, LOG_FILE,
    };

    // ── Chat Loop ─────────────────────────────────────────────────────────

    while (true) {
      let input;
      try {
        input = await prompt();
      } catch {
        break; // EOF / Ctrl+D
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      // Exit
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        logClose();
        console.log(chalk.dim('\nGoodbye!\n'));
        break;
      }

      log('input', trimmed);

      // Slash commands
      if (trimmed.startsWith('/')) {
        const result = await processCommand(trimmed, ctx);
        if (result.logout) {
          logClose();
          console.log(chalk.dim('\nSession ended. Run emblemai again to log in.\n'));
          break;
        }
        if (result.handled) continue;
      }

      // Build messages
      const msgs = settings.retainHistory ? [...history.messages] : [];
      msgs.push({ role: 'user', content: trimmed });

      let response = '';

      if (settings.stream) {
        // ── Streaming ─────────────────────────────────────────────────────
        log('stream', { mode: 'start', msgCount: msgs.length, model: settings.model });
        console.log(fmt.thinking());
        process.stdout.write('  ');
        startSpinner();
        let firstChunk = false;
        let rawPending = '';      // raw text on screen not yet glow-rendered
        let inCodeBlock = false;  // track code fences to avoid splitting mid-block
        let finishHandled = false; // guard against double finish events

        try {
          const chatMessages = buildMessages(msgs, pluginManager);
          const streamOptions = { messages: chatMessages, processChunks: true };
          if (settings.model) streamOptions.model = settings.model;
          if (settings.selectedTools.length > 0) streamOptions.selectedToolCategories = settings.selectedTools;
          else if (lastIntentContext) streamOptions.intentContext = lastIntentContext;

          const stream = client.chatStream(streamOptions);

          for await (const chunk of stream) {
            if ('type' in chunk) {
              log('chunk', { type: chunk.type, len: chunk.value?.length, preview: typeof chunk.value === 'string' ? chunk.value.slice(0, 80) : undefined });
              switch (chunk.type) {
                case 'text':
                  if (!firstChunk) {
                    stopSpinner();
                    process.stdout.write('\r  '); // clear spinner line
                    firstChunk = true;
                  }
                  response += chunk.value;
                  process.stdout.write(chunk.value); // immediate raw output

                  // Incremental glow: replace completed sections in-place
                  if (settings.glowEnabled) {
                    rawPending += chunk.value;
                    // Track code block fences
                    const fences = chunk.value.match(/^(`{3,}|~{3,})/gm);
                    if (fences) for (const f of fences) inCodeBlock = !inCodeBlock;

                    if (!inCodeBlock) {
                      const bp = _findGlowBreakpoint(rawPending);
                      if (bp !== -1) {
                        const toGlow = rawPending.slice(0, bp);
                        const remaining = rawPending.slice(bp);
                        // Erase all raw pending lines from screen
                        const nlCount = rawPending.split('\n').length - 1;
                        if (nlCount > 0) process.stdout.write(`\x1b[${nlCount}A`);
                        process.stdout.write('\x1b[0G\x1b[0J');
                        // Write glow-rendered section + remaining raw text
                        process.stdout.write(glow.renderMarkdownSync(toGlow));
                        if (remaining) process.stdout.write(remaining);
                        rawPending = remaining;
                      }
                    }
                  }
                  break;

                case 'intent_context':
                  if (chunk.value?.intentContext) {
                    lastIntentContext = chunk.value.intentContext;
                  }
                  break;

                case 'tool_call':
                  if (!firstChunk) { stopSpinner(); process.stdout.write('\r'); firstChunk = true; }
                  // Glow-render any pending raw text before tool output
                  if (settings.glowEnabled && rawPending) {
                    const nlCount = rawPending.split('\n').length - 1;
                    if (nlCount > 0) process.stdout.write(`\x1b[${nlCount}A`);
                    process.stdout.write('\x1b[0G\x1b[0J');
                    process.stdout.write(glow.renderMarkdownSync(rawPending));
                    rawPending = '';
                  }
                  log('tool_call', { tool: chunk.value.toolName, args: chunk.value.args });
                  console.log(fmt.toolCall(chunk.value.toolName || 'unknown', chunk.value.args));
                  break;

                case 'finish':
                  if (finishHandled) {
                    log('finish', 'duplicate finish event — skipped');
                    break;
                  }
                  finishHandled = true;
                  stopSpinner();
                  // Glow-render any remaining raw text
                  if (settings.glowEnabled && rawPending) {
                    const nlCount = rawPending.split('\n').length - 1;
                    if (nlCount > 0) process.stdout.write(`\x1b[${nlCount}A`);
                    process.stdout.write('\x1b[0G\x1b[0J');
                    process.stdout.write(glow.renderMarkdownSync(rawPending));
                    rawPending = '';
                  }
                  log('finish', { responseLen: response.length });
                  console.log(fmt.complete());
                  break;
              }
            }
          }
        } catch (error) {
          stopSpinner();
          if (settings.glowEnabled && rawPending) {
            const nlCount = rawPending.split('\n').length - 1;
            if (nlCount > 0) process.stdout.write(`\x1b[${nlCount}A`);
            process.stdout.write('\x1b[0G\x1b[0J');
            process.stdout.write(glow.renderMarkdownSync(rawPending));
            rawPending = '';
          }
          log('error', { message: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });
          console.error('\n' + fmt.error(error.message));
        }
      } else {
        // ── Non-Streaming ─────────────────────────────────────────────────
        log('chat', { mode: 'non-stream', msgCount: msgs.length, model: settings.model });
        console.log(fmt.thinking());
        try {
          const chatMessages = buildMessages(msgs, pluginManager);
          const chatOptions = { rawResponse: false };
          if (settings.model) chatOptions.model = settings.model;
          if (settings.selectedTools.length > 0) chatOptions.selectedToolCategories = settings.selectedTools;
          else if (lastIntentContext) chatOptions.intentContext = lastIntentContext;

          const res = await client.chat(chatMessages, chatOptions);
          const result = /** @type {import('hustle-incognito').ProcessedResponse} */ (res);
          if (result.intentContext?.intentContext) lastIntentContext = result.intentContext.intentContext;
          response = result.content;
          log('response', { len: response.length, toolCalls: result.toolCalls?.length || 0 });

          const rendered = settings.glowEnabled ? glow.renderMarkdownSync(response) : response;
          console.log(rendered);

          if (result.toolCalls?.length > 0) {
            for (const tc of result.toolCalls) {
              log('tool_call', { tool: tc.toolName, args: tc.args });
              console.log(fmt.toolCall(tc.toolName || 'unknown', tc.args));
            }
          }

          console.log(fmt.complete());
        } catch (error) {
          log('error', { message: error.message });
          console.error('\n' + fmt.error(error.message));
        }
      }

      // Save history
      if (settings.retainHistory && response) {
        history.messages.push({ role: 'user', content: trimmed });
        history.messages.push({ role: 'assistant', content: response });
        saveHistory(history);
      }
    }

    rl.close();
    logClose();
    process.exit(0);

  } catch (error) {
    console.error(fmt.error(error.message));
    if (error.stack && process.argv.includes('--debug')) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
