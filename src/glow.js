/**
 * glow.js - Optional glow markdown rendering integration
 *
 * Integrates with charmbracelet/glow for rich terminal markdown rendering.
 * Falls back to raw markdown when glow is not installed.
 *
 * Note: Uses spawnSync (not exec) intentionally -- spawnSync does not invoke
 * a shell and passes arguments as an array, so it is safe from injection.
 */

import { spawnSync } from 'child_process';
import chalk from 'chalk';

let _glowInfo = null;

/**
 * Render a single header line with chalk styling.
 * @param {number} level - 1–4
 * @param {string} content - Header text (no # prefix)
 * @returns {string}
 */
function formatHeader(level, content) {
  const visLen = Math.max(content.length, 10);
  switch (level) {
    case 1: // H1 — bold bright cyan, uppercase, heavy underline
      return (
        '\n  ' +
        chalk.bold.cyanBright(content.toUpperCase()) +
        '\n  ' +
        chalk.cyan('━'.repeat(visLen + 2)) +
        '\n'
      );
    case 2: // H2 — bold white, thin underline
      return (
        '\n  ' +
        chalk.bold.whiteBright(content) +
        '\n  ' +
        chalk.dim('─'.repeat(visLen)) +
        '\n'
      );
    case 3: // H3 — bold white
      return '\n  ' + chalk.bold.white(content) + '\n';
    case 4: // H4 — bold dim
      return '  ' + chalk.bold(chalk.dim(content)) + '\n';
    default:
      return content;
  }
}

/**
 * Pre-process markdown: extract header lines (#–####), style them with chalk,
 * and return { segments, hasHeaders } for the renderer.
 *
 * Headers are handled by us (chalk) instead of glow because glow injects
 * invisible characters around headers that make post-processing unreliable.
 *
 * Respects code blocks — lines inside ``` fences are never treated as headers.
 *
 * @param {string} markdown
 * @returns {{ segments: Array<{ type: 'header'|'content', value: string }>, hasHeaders: boolean }}
 */
function extractHeaders(markdown) {
  const lines = markdown.split('\n');
  /**
   * @type {Array<{ type: 'header'|'content', value: string }>}
   */
  const segments = [];
  let contentBuf = [];
  let inCode = false;
  let hasHeaders = false;

  const flushContent = () => {
    if (contentBuf.length === 0) return;
    segments.push({ type: 'content', value: contentBuf.join('\n') });
    contentBuf = [];
  };

  for (const line of lines) {
    // Track code fences
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inCode = !inCode;
      contentBuf.push(line);
      continue;
    }

    if (!inCode) {
      const m = line.match(/^(#{1,4})\s+(.+)$/);
      if (m) {
        flushContent();
        const clean = m[2].replace(/\s+$/, '');
        segments.push({ type: 'header', value: formatHeader(m[1].length, clean) });
        hasHeaders = true;
        continue;
      }
    }

    contentBuf.push(line);
  }
  flushContent();

  return { segments, hasHeaders };
}

/**
 * Style markdown headers in plain text (no-glow fallback).
 * Exported for direct use when glow is not involved.
 * @param {string} text
 * @returns {string}
 */
export function styleHeaders(text) {
  const { segments } = extractHeaders(text);
  return segments.map(s => s.value).join('\n');
}

/**
 * Detect whether glow is installed on the system.
 * Result is cached after first call.
 * @returns {{ installed: boolean, version?: string, path?: string }}
 */
export function detectGlow() {
  if (_glowInfo !== null) return _glowInfo;

  try {
    const which = spawnSync('which', ['glow'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (which.status !== 0 || !which.stdout.trim()) {
      _glowInfo = { installed: false };
      return _glowInfo;
    }

    const glowPath = which.stdout.trim();

    let version;
    try {
      const ver = spawnSync(glowPath, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (ver.status === 0 && ver.stdout) {
        version = ver.stdout.trim();
      }
    } catch {
      // version detection is best-effort
    }

    _glowInfo = { installed: true, version, path: glowPath };
  } catch {
    _glowInfo = { installed: false };
  }

  return _glowInfo;
}

/**
 * Pipe text through glow and return the result, or null on failure.
 * @param {string} text
 * @param {{ installed: boolean, path?: string }} info
 * @param {{ style?: string, width?: number }} opts
 * @returns {string|null}
 * @private
 */
function _glowRender(text, info, opts) {
  if (!info.installed || !text.trim()) return null;

  const args = ['-'];
  if (opts.style) args.push('--style', opts.style);
  if (opts.width) args.push('--width', String(opts.width));

  try {
    const result = spawnSync(info.path, args, {
      input: text,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Render markdown synchronously.
 *
 * Headers (#–####) are always styled by chalk (glow mangles them).
 * Everything else goes through glow if installed, raw text otherwise.
 *
 * @param {string} markdown - Markdown text to render
 * @param {{ style?: 'dark'|'light'|'notty'|'auto', width?: number }} opts
 * @returns {string} Rendered output
 */
export function renderMarkdownSync(markdown, opts = {}) {
  const { segments, hasHeaders } = extractHeaders(markdown);
  const info = detectGlow();

  // Fast path: no headers → send entire markdown to glow in one call
  if (!hasHeaders) {
    return _glowRender(markdown, info, opts) || markdown;
  }

  // Headers found: render each segment appropriately
  const rendered = segments.map(seg => {
    if (seg.type === 'header') return seg.value;
    // Content segment → glow
    return _glowRender(seg.value, info, opts) || seg.value;
  });

  return rendered.join('\n');
}

/**
 * Streaming buffer that accumulates markdown text and flushes
 * at safe paragraph/block boundaries through glow.
 *
 * Ported from hustle-v5 src/cli/glow.ts — matches its breakpoint
 * detection so streaming + glow renders incrementally.
 */
export class GlowStreamBuffer {
  constructor() {
    this.buffer = '';
    this.inCodeBlock = false;
    this.codeBlockFence = '';
    this.lastRenderedLength = 0;
  }

  /**
   * Push text into the buffer.
   * Returns rendered string if a safe flush point was reached, null otherwise.
   * @param {string} text
   * @returns {string|null}
   */
  push(text) {
    this.buffer += text;
    return this._tryFlush();
  }

  /**
   * Force-render any remaining buffer content through glow.
   * @returns {string|null}
   */
  flush() {
    if (this.buffer.length === 0) return null;
    const content = this.buffer;
    this.buffer = '';
    this.inCodeBlock = false;
    this.codeBlockFence = '';
    this.lastRenderedLength = 0;

    const info = detectGlow();
    if (!info.installed) return content;
    return renderMarkdownSync(content);
  }

  /**
   * Clear the buffer without rendering.
   */
  reset() {
    this.buffer = '';
    this.inCodeBlock = false;
    this.codeBlockFence = '';
    this.lastRenderedLength = 0;
  }

  /**
   * Check for markdown-safe breakpoints and flush if found.
   * @returns {string|null}
   * @private
   */
  _tryFlush() {
    this._updateCodeBlockState();

    // Don't flush mid-code-block
    if (this.inCodeBlock) return null;

    const breakpoint = this._findBreakpoint();
    if (breakpoint === -1) return null;

    const content = this.buffer.slice(0, breakpoint);
    this.buffer = this.buffer.slice(breakpoint);
    this.lastRenderedLength = this.buffer.length;

    if (content.length === 0) return null;

    const info = detectGlow();
    if (!info.installed) return content;
    return renderMarkdownSync(content);
  }

  /**
   * Update code block tracking state — only scans new content,
   * and matches opening/closing fences by style.
   * @private
   */
  _updateCodeBlockState() {
    const searchStart = this.lastRenderedLength;
    const newContent = this.buffer.slice(searchStart);
    const fenceRegex = /^(```|~~~)/gm;
    const matches = [...newContent.matchAll(fenceRegex)];

    for (const match of matches) {
      const fence = match[1];
      if (!this.inCodeBlock) {
        this.inCodeBlock = true;
        this.codeBlockFence = fence;
      } else if (fence === this.codeBlockFence) {
        this.inCodeBlock = false;
        this.codeBlockFence = '';
      }
    }

    this.lastRenderedLength = this.buffer.length;
  }

  /**
   * Find a safe breakpoint in the buffer.
   * Returns the index after the breakpoint, or -1 if none found.
   * @returns {number}
   * @private
   */
  _findBreakpoint() {
    // Priority 1: Paragraph break (double newline)
    const paragraphBreak = this.buffer.indexOf('\n\n');
    if (paragraphBreak !== -1) {
      return paragraphBreak + 2;
    }

    // Priority 2: End of a complete line that looks like a block element
    // (header, HR) followed by newline at buffer end
    if (this.buffer.endsWith('\n') && this.buffer.length > 1) {
      const lines = this.buffer.split('\n');
      // Need at least 2 elements (last is empty due to trailing \n)
      if (lines.length >= 2) {
        const lastLine = lines[lines.length - 2];
        if (this._isBlockElement(lastLine)) {
          return this.buffer.length;
        }
      }
    }

    return -1;
  }

  /**
   * Check if a line is a standalone block element that's safe to render.
   * @param {string} line
   * @returns {boolean}
   * @private
   */
  _isBlockElement(line) {
    const trimmed = line.trim();
    // Headers
    if (/^#{1,6}\s/.test(trimmed)) return true;
    // Horizontal rules
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true;
    return false;
  }
}

export default { detectGlow, renderMarkdownSync, styleHeaders, GlowStreamBuffer };
