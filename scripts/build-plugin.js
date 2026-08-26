#!/usr/bin/env node

/**
 * Build script for the DSH Completion Reminder plugin.
 *
 * 1. Compiles TypeScript source with tsc (ESM → lib/).
 * 2. Reads the compiled client ESM module and wraps it in the
 *    window.__ModuleLoader__.load({…}) format that DSH expects.
 * 3. Emits a standalone dist bundle for `<script>`-tag usage.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_CLIENT = resolve(ROOT, 'src/client.ts');
const SRC_INDEX = resolve(ROOT, 'src/index.ts');
const LIB_DIR = resolve(ROOT, 'lib');
const LIB_CLIENT = resolve(LIB_DIR, 'client.js');
const LIB_INDEX = resolve(LIB_DIR, 'index.js');
const DIST_DIR = resolve(ROOT, 'dist');

// ── Step 1: tsc ────────────────────────────────────────────────────────────

console.log('[build] Compiling TypeScript…');
execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });

// ── Step 2: verify compiled output exists ──────────────────────────────────

if (!existsSync(LIB_CLIENT)) {
  console.error('[build] lib/client.js not found after tsc — compilation may have failed');
  process.exit(1);
}

// ── Step 3: wrap client.js in __ModuleLoader__ format ──────────────────────

const compiledCode = readFileSync(LIB_CLIENT, 'utf-8');
const LIB_TYPES = resolve(LIB_DIR, 'types.js');

/**
 * Which runtime bindings does client.js import from './types.js'?
 * Captured BEFORE the import lines are stripped below, so the inlined
 * types module can destructure exactly what the client needs - new
 * exports in types.ts flow through automatically.
 */
function typesImportsFrom(source) {
  const names = [];
  const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]\.\/types\.js['"]/g;
  for (const m of source.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const binding = part.trim();
      if (!binding) continue;
      const asMatch = binding.match(/^(\w+)\s+as\s+(\w+)$/);
      names.push(asMatch ? `${asMatch[1]}: ${asMatch[2]}` : binding);
    }
  }
  return names;
}

/**
 * Turn compiled ESM (lib/types.js) into plain CJS-ish statements that
 * assign onto a local `exports`. tsc emits inline `export const x = …`
 * declarations (no trailing export list), so capture each declared name
 * and emit `exports.<name> = <name>;` after it. types.ts imports
 * nothing; interface/type exports vanish in JS output naturally.
 */
function transformTypesEsm(code) {
  const names = [];
  const out = code
    .replace(
      /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      (_, kind, name) => {
        names.push(name);
        return `${kind} ${name}`;
      },
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (names.length === 0) {
    throw new Error('[build] no exported runtime bindings found in lib/types.js');
  }
  const assigns = names.map((n) => `exports.${n} = ${n};`).join('\n');
  return `${out}\n${assigns}`;
}


// Transform the compiled ESM.
//
// Rules:
//   1. `import * as X from "react"`        -> `var X = require("react");`
//      `import { a, b as c } from "react"` -> `var { a, b: c } = require("react");`
//      `import X from "react"`             -> `var X = require("react");`
//      `import "./types.js"`               -> removed (types are inlined above)
//      `import type ...`                   -> removed
//      `import "react/jsx-runtime"`        -> no-op (`react/jsx-runtime` is
//         bundled as a side-effect import by tsc; we don't use it because
//         the source code uses React.createElement directly)
//   2. `export { a, b as c }`              -> `exports.a = a; exports.c = b;`
//   3. `export function/const/... X`       -> drop the `export` keyword
//   4. `export default`                     -> drop the keyword
let factoryCode = compiledCode;

// (1a) Side-effect-only imports: drop them.
factoryCode = factoryCode.replace(
  /^import\s+['"][^'"]+['"]\s*;?\s*$/gm,
  '',
);

// (1b) Default + named imports from "react" or "react/jsx-runtime":
// rewrite to `var X = require("…")` so DSH's runtime module table can
// resolve them. tsc compiles `import * as React from "react"` to
// `import * as React from "react";` which we capture with the
// namespace pattern below.
factoryCode = factoryCode.replace(
  /^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
  (_m, name, spec) => `var ${name} = require(${JSON.stringify(spec)});`,
);
factoryCode = factoryCode.replace(
  /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
  (_m, name, spec) => `var ${name} = require(${JSON.stringify(spec)});`,
);
factoryCode = factoryCode.replace(
  /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
  (_m, names, spec) => {
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
    const bindings = parts.map((p) => {
      const m = p.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (!m) return p;
      return m[2] ? `${m[1]}: ${m[2]}` : m[1];
    });
    return `var { ${bindings.join(', ')} } = require(${JSON.stringify(spec)});`;
  },
);

// (1c) Anything left over (e.g. local relative imports) — drop.
// Specifically, `import {...} from './types.js'` and the resulting
// `var {...} = require("./types.js")` need to be removed because
// the wrapper above inlines the types module.
factoryCode = factoryCode.replace(
  /^import\s+.*?from\s+['"]\.\/types\.js['"]\s*;?\s*$/gm,
  '',
);
factoryCode = factoryCode.replace(
  /^var\s+\{[^}]*\}\s*=\s*require\(\s*['"]\.\/types\.js['"]\s*\)\s*;?\s*$/gm,
  '',
);

// (1d) Any other leftover imports — drop.
factoryCode = factoryCode.replace(
  /^import\s+.*?from\s+['"][^'"]+['"]\s*;?\s*$/gm,
  '',
);

// (1e) Pure type imports — drop.
factoryCode = factoryCode.replace(/^import\s+type\s+.*$/gm, '');

// (2-4) Exports
factoryCode = factoryCode.replace(
  /^export\s+\{([^}]+)\}\s*;?\s*$/m,
  (_, exportsList) => {
    const exports = exportsList.split(',').map((s) => s.trim()).filter(Boolean);
    return exports.map((e) => {
      const parts = e.split(/\s+as\s+/);
      if (parts.length === 2) {
        return `exports.${parts[1].trim()} = ${parts[0].trim()};`;
      }
      return `exports.${parts[0].trim()} = ${parts[0].trim()};`;
    }).join('\n');
  },
);
factoryCode = factoryCode.replace(
  /^export\s+(function|const|class|let|var|interface|type)\s+/gm,
  '$1 ',
);
factoryCode = factoryCode.replace(/^export\s+default\s+/gm, '');

factoryCode = factoryCode
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// ── Build the final __ModuleLoader__ wrapper ────────────────────────────────

// Inlined types module: auto-extracted from lib/types.js instead of a
// hand-maintained copy. The hand copy drifted twice (missing
// showSettingsPanel, then missing STORAGE_KEY - which silently broke
// persistence in every released version). Never hand-write it again.
if (!existsSync(LIB_TYPES)) {
  console.error('[build] lib/types.js not found after tsc');
  process.exit(1);
}
const typeBindings = typesImportsFrom(compiledCode);
const typesBlock = [
  '    var __types = (function () {',
  '      var module = { exports: {} };',
  '      var exports = module.exports;',
  ...transformTypesEsm(readFileSync(LIB_TYPES, 'utf-8'))
    .split('\n')
    .map((l) => '      ' + l),
  '      return module.exports;',
  '    })();',
  `    var { ${typeBindings.join(', ')} } = __types;`,
].join('\n');

const pluginId = 'dsh-completion-reminder';

const bundleContent = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pluginId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── inlined types (auto-generated from lib/types.js) ───────────
${typesBlock}

    // ── compiled client code ────────────────────────────────────────
${factoryCode.split('\n').map((l) => '    ' + l).join('\n')}

    // ── export fallback (guard against stripped 'export { ... }' lists) ──
    if (typeof exports.apply !== 'function' && typeof apply === 'function') {
      exports.apply = apply;
    }
    if (typeof exports.configure !== 'function' && typeof configure === 'function') {
      exports.configure = configure;
    }
    if (typeof exports.activate !== 'function' && typeof activate === 'function') {
      exports.activate = activate;
    }
    if (typeof exports.deactivate !== 'function' && typeof deactivate === 'function') {
      exports.deactivate = deactivate;
    }
    if (typeof exports.requestBrowserPermission !== 'function' && typeof requestBrowserPermission === 'function') {
      exports.requestBrowserPermission = requestBrowserPermission;
    }

    return module.exports;
  }
});
`;

writeFileSync(LIB_CLIENT, bundleContent, 'utf-8');
console.log('[build] Wrote', LIB_CLIENT);

// ── Step 4: verify lib/index.js ────────────────────────────────────────────

if (!existsSync(LIB_INDEX)) {
  const fallback = `export function apply(ctx) { /* dsh-completion-reminder host stub */ }\n`;
  writeFileSync(LIB_INDEX, fallback, 'utf-8');
  console.log('[build] Created fallback', LIB_INDEX);
}

// ── Step 5: standalone dist bundle ─────────────────────────────────────────

mkdirSync(DIST_DIR, { recursive: true });

const standaloneDist = `/**
 * DSH Completion Reminder — standalone bundle
 *
 * Load this file as a regular <script> tag in the DSH Web GUI page
 * to receive a browser/system notification when the agent finishes.
 *
 * Usage:
 *   <script src="dsh-completion-reminder.js"></script>
 *   <script>
 *     DSHCompletionReminder.configure({
 *       provider: 'telegram',
 *       providers: { telegramBotToken: '…', telegramChatId: '…' },
 *     });
 *     DSHCompletionReminder.activate();
 *   </script>
 */
(function () {
  'use strict';

  // ── options ────────────────────────────────────────────────────────
  var DEFAULTS = {
    provider: 'browser',
    autoRequestPermission: true,
    notifyOnSuccess: true,
    notifyOnStopped: true,
    notifyOnError: true,
    suppressWhenFocused: true,
    cooldownMs: 5000,
    providers: {},
    clickUrl: '',
    iconUrl: '',
    showSettingsPanel: true,
    onNotify: function () { return undefined; },
    onError: function (err) { try { console.warn('[dsh-completion-reminder]', err); } catch (_e) {} },
    titleTemplate: function (ctx) {
      if (ctx.status === 'success') return '✅ DSH Agent 已完成';
      if (ctx.status === 'stopped') return '⏹ DSH Agent 已停止';
      return '⚠️ DSH Agent 出错';
    },
    bodyTemplate: function (ctx) {
      var parts = [];
      if (ctx.agent) parts.push('Agent: ' + ctx.agent);
      if (ctx.model) parts.push('Model: ' + ctx.model);
      if (typeof ctx.durationMs === 'number') {
        if (ctx.durationMs < 1000) parts.push('用时: ' + Math.round(ctx.durationMs) + 'ms');
        else {
          var total = Math.round(ctx.durationMs / 1000);
          if (total >= 3600) parts.push('用时: ' + Math.floor(total / 3600) + 'h ' + Math.floor((total % 3600) / 60) + 'm');
          else if (total >= 60) parts.push('用时: ' + Math.floor(total / 60) + 'm ' + (total % 60) + 's');
          else parts.push('用时: ' + total + 's');
        }
      }
      if (!parts.length) return '代理任务已结束，点击查看详情。';
      return parts.join(' · ');
    },
  };

  var CSS_VARS = {
    bgModule: 'var(--dsw-alias-bg-module-platform)',
    borderL3: 'var(--dsw-alias-border-l3)',
    labelPrimary: 'var(--dsw-alias-label-primary)',
    labelSecondary: 'var(--dsw-alias-label-secondary)',
    labelTertiary: 'var(--dsw-alias-label-tertiary)',
    shadowLv3: 'var(--dsw-shadow-lv3)',
  };

  var TOOLBAR_BUTTON_SELECTORS = [
    'button[aria-label*="send" i]',
    'button[aria-label*="stop" i]',
    'button[aria-label*="停止" i]',
    'button[aria-label*="发送" i]',
    'button[aria-label*="取消" i]',
    'button[aria-label*="中止" i]',
    'button[aria-label*="abort" i]',
    'button[aria-label*="cancel" i]',
    'form button[type="submit"]',
    'textarea + * button',
    'textarea ~ button',
  ];

  var RUNNING_TOKENS = ['stop', 'stop generating', '停止', '中止', '取消生成', 'abort', 'cancel', 'pause', '暂停', 'interrupt'];
  var SUCCESS_TOKENS = ['send', '发送', 'submit', '提交'];

  var CONVERSATION_SELECTORS = [
    '[data-conversation-id]',
    '[data-conversation]',
    'main [class*="conversation"]',
    'main [class*="chat"]',
    'main [class*="message"]',
  ];

  var opts = Object.assign({}, DEFAULTS);
  var state = {
    observer: null,
    runStartedAt: null,
    lastModel: null,
    lastAgent: null,
    inFlight: false,
    lastNotifiedAt: 0,
    isActive: false,
    permission: detectPermission(),
    unbinder: [],
  };

  function detectPermission() {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  function toError(value) {
    if (value instanceof Error) return value;
    return new Error(typeof value === 'string' ? value : JSON.stringify(value));
  }

  function safeText(res) {
    return res.text().then(function (t) { return t.slice(0, 500); }).catch(function () { return ''; });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) return safeText(res).then(function (t) {
        throw new Error('POST ' + url + ' → ' + res.status + ': ' + (t || res.statusText));
      });
      return res;
    });
  }

  function postForm(url, fields) {
    var form = new URLSearchParams();
    for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) form.set(k, fields[k]);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }).then(function (res) {
      if (!res.ok) return safeText(res).then(function (t) {
        throw new Error('POST ' + url + ' → ' + res.status + ': ' + (t || res.statusText));
      });
      return res;
    });
  }

  function escapeMd(s) {
    return s.replace(/[_*[\\]()~\`>#+\\-=|{}.!\\\\]/g, function (m) { return '\\\\' + m; });
  }

  function isInsideToolbar(el) {
    return !!el.closest('form, [class*="composer" i], [class*="toolbar" i], [class*="input" i], [class*="chat-input" i]');
  }

  function matchesAny(btn, tokens) {
    var text = (btn.textContent || '').trim().toLowerCase();
    var aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
    var title = (btn.getAttribute('title') || '').trim().toLowerCase();
    var cls = (btn.getAttribute('class') || '').toLowerCase();
    var hay = text + ' ' + aria + ' ' + title + ' ' + cls;
    return tokens.some(function (tok) { return hay.indexOf(tok) !== -1; });
  }

  function collectToolbarButtons() {
    var out = [];
    var forms = document.querySelectorAll('form, [class*="composer" i], [class*="toolbar" i]');
    forms.forEach(function (f) {
      f.querySelectorAll('button').forEach(function (b) {
        if (b.offsetParent !== null || b.getClientRects().length) out.push(b);
      });
    });
    TOOLBAR_BUTTON_SELECTORS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (b) {
        if ((b.offsetParent !== null || b.getClientRects().length) && out.indexOf(b) === -1) {
          out.push(b);
        }
      });
    });
    return out;
  }

  function findLastAssistantMessage() {
    for (var i = 0; i < CONVERSATION_SELECTORS.length; i++) {
      var all = document.querySelectorAll(CONVERSATION_SELECTORS[i]);
      for (var j = all.length - 1; j >= 0; j--) {
        var el = all[j];
        var role = (el.getAttribute('data-role') || el.getAttribute('data-author') || '').toLowerCase();
        if (role.indexOf('assistant') !== -1 || role.indexOf('agent') !== -1 || role.indexOf('model') !== -1) {
          return el;
        }
      }
    }
    var main = document.querySelector('main');
    var last = main && main.lastElementChild;
    return last || null;
  }

  function determineStatus() {
    var last = findLastAssistantMessage();
    if (!last) return 'success';
    var text = (last.textContent || '').toLowerCase();
    if (/(error|exception|failed|traceback|错误|失败|异常)/.test(text) &&
        !/no error|没有错误|successfully|成功/.test(text)) {
      return 'error';
    }
    if (/(stopped by user|user stopped|手动停止|已停止|已取消)/.test(text)) return 'stopped';
    return 'success';
  }

  function readModelFromHeader() {
    var candidates = document.querySelectorAll('[data-model], [data-testid*="model" i], [class*="model" i]');
    for (var i = 0; i < candidates.length; i++) {
      var t = (candidates[i].textContent || '').trim();
      if (t && t.length < 80) return t;
    }
    return null;
  }

  function readAgentFromHeader() {
    var candidates = document.querySelectorAll('[data-agent], [data-testid*="agent" i]');
    for (var i = 0; i < candidates.length; i++) {
      var t = (candidates[i].textContent || '').trim();
      if (t && t.length < 80) return t;
    }
    return null;
  }

  function captureRunMetadata() {
    var m = readModelFromHeader();
    if (m) state.lastModel = m;
    var a = readAgentFromHeader();
    if (a) state.lastAgent = a;
  }

  function pageIsFocused() {
    if (typeof document === 'undefined') return true;
    if (document.visibilityState === 'hidden') return false;
    if (document.hasFocus && !document.hasFocus()) return false;
    return true;
  }

  function evaluateToolbar() {
    var buttons = collectToolbarButtons();
    if (!buttons.length) return;
    var running = buttons.find(function (b) { return matchesAny(b, RUNNING_TOKENS); });
    captureRunMetadata();
    if (running && !state.inFlight) {
      state.inFlight = true;
      state.runStartedAt = Date.now();
      return;
    }
    if (!running && state.inFlight) {
      state.inFlight = false;
      var startedAt = state.runStartedAt || Date.now();
      var durationMs = Date.now() - startedAt;
      state.runStartedAt = null;
      completeRun(determineStatus(), durationMs);
    }
  }

  function handleMutations(mutations) {
    if (!state.isActive) return;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'attributes' || m.type === 'characterData') {
        var target = m.target;
        if (target && isInsideToolbar(target)) evaluateToolbar();
      }
      m.addedNodes.forEach(function (node) {
        if (!(node instanceof HTMLElement)) return;
        var selList = TOOLBAR_BUTTON_SELECTORS.join(',');
        if (node.matches && node.matches(selList)) {
          evaluateToolbar();
        } else if (node.querySelector && node.querySelector(selList)) {
          evaluateToolbar();
        }
      });
    }
  }

  function startObserver() {
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(handleMutations);
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'aria-pressed', 'data-state', 'data-status', 'class', 'disabled'],
    });
    evaluateToolbar();
  }

  function stopObserver() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
  }

  function bindVisibilityEvents() {
    if (typeof document === 'undefined') return;
    var onVis = function () {};
    document.addEventListener('visibilitychange', onVis);
    state.unbinder.push(function () { document.removeEventListener('visibilitychange', onVis); });
    var onFocus = function () {};
    window.addEventListener('focus', onFocus);
    state.unbinder.push(function () { window.removeEventListener('focus', onFocus); });
  }

  function requestBrowserPermission() {
    if (state.permission === 'unsupported') return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') {
      state.permission = Notification.permission;
      return Promise.resolve(Notification.permission);
    }
    return Notification.requestPermission().then(function (result) {
      state.permission = result;
      return result;
    }).catch(function (err) {
      opts.onError(toError(err), 'browser');
      return state.permission;
    });
  }

  function shouldNotify(status) {
    if (status === 'success') return opts.notifyOnSuccess;
    if (status === 'stopped') return opts.notifyOnStopped;
    if (status === 'error') return opts.notifyOnError;
    return true;
  }

  function showInPageToast(payload, hint) {
    if (typeof document === 'undefined') return;
    var root = ensureToastRoot();
    var card = document.createElement('div');
    card.className = 'dsh-reminder-toast';
    card.setAttribute('role', 'status');
    card.innerHTML = '<div class="dsh-reminder-toast-title"></div><div class="dsh-reminder-toast-body"></div>' + (hint ? '<div class="dsh-reminder-toast-hint"></div>' : '');
    card.querySelector('.dsh-reminder-toast-title').textContent = payload.title;
    card.querySelector('.dsh-reminder-toast-body').textContent = payload.body;
    if (hint) card.querySelector('.dsh-reminder-toast-hint').textContent = hint;
    card.addEventListener('click', function () {
      if (payload.url) { try { window.open(payload.url, '_self'); } catch (_e) {} }
      card.remove();
    });
    root.appendChild(card);
    setTimeout(function () { card.classList.add('dsh-reminder-toast-leave'); }, 4500);
    setTimeout(function () { card.remove(); }, 5200);
  }

  var toastRoot = null;
  function ensureToastRoot() {
    if (toastRoot && document.body.contains(toastRoot)) return toastRoot;
    if (document.getElementById('dsh-completion-reminder-toast-style')) {
      // styles already injected
    } else {
      var style = document.createElement('style');
      style.id = 'dsh-completion-reminder-toast-style';
      style.textContent =
        '.dsh-reminder-toast-root{position:fixed;top:20px;right:20px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:360px;}' +
        '.dsh-reminder-toast{pointer-events:auto;background:' + CSS_VARS.bgModule + ';color:' + CSS_VARS.labelPrimary + ';border:1px solid ' + CSS_VARS.borderL3 + ';border-radius:10px;box-shadow:' + CSS_VARS.shadowLv3 + ';padding:12px 14px;font-size:13px;line-height:1.4;cursor:pointer;transition:opacity .25s ease,transform .25s ease;}' +
        '.dsh-reminder-toast-title{font-weight:600;margin-bottom:4px;}' +
        '.dsh-reminder-toast-body{color:' + CSS_VARS.labelSecondary + ';white-space:pre-wrap;word-break:break-word;}' +
        '.dsh-reminder-toast-hint{color:' + CSS_VARS.labelTertiary + ';font-size:12px;margin-top:6px;}' +
        '.dsh-reminder-toast-leave{opacity:0;transform:translateY(-4px);}';
      document.head.appendChild(style);
    }
    var root = document.createElement('div');
    root.id = 'dsh-completion-reminder-toasts';
    root.className = 'dsh-reminder-toast-root';
    document.body.appendChild(root);
    toastRoot = root;
    return root;
  }

  function deliverBrowser(payload) {
    return Promise.resolve().then(function () {
      if (state.permission === 'unsupported') {
        showInPageToast(payload);
        return;
      }
      if (state.permission !== 'granted') {
        if (opts.autoRequestPermission) {
          return requestBrowserPermission().then(function (next) {
            if (next !== 'granted') {
              showInPageToast(payload, '未授予通知权限，已改为页面内提示。');
              return;
            }
            fire();
          });
        }
        showInPageToast(payload, '未授予通知权限，已改为页面内提示。');
        return;
      }
      fire();

      function fire() {
        try {
          var n = new Notification(payload.title, {
            body: payload.body,
            icon: payload.iconUrl,
            tag: 'dsh-completion-reminder',
            requireInteraction: false,
          });
          n.onclick = function () {
            try {
              if (typeof window !== 'undefined' && payload.url) {
                window.focus();
                window.open(payload.url, '_self');
              }
            } catch (_e) {}
            n.close();
          };
        } catch (err) {
          showInPageToast(payload, '系统通知失败，已改为页面内提示。');
          opts.onError(toError(err), 'browser');
        }
      }
    });
  }

  function deliverTelegram(payload) {
    var p = opts.providers || {};
    if (!p.telegramBotToken || !p.telegramChatId) {
      return Promise.reject(new Error('Telegram provider requires telegramBotToken and telegramChatId'));
    }
    var url = 'https://api.telegram.org/bot' + encodeURIComponent(p.telegramBotToken) + '/sendMessage';
    return postJson(url, {
      chat_id: p.telegramChatId,
      text: '*' + escapeMd(payload.title) + '*\\n' + escapeMd(payload.body),
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  }

  function deliverBark(payload) {
    var p = opts.providers || {};
    if (!p.barkKey) return Promise.reject(new Error('Bark provider requires barkKey'));
    var server = (p.barkServer || 'https://api.day.app').replace(/\\/$/, '');
    var url = server + '/' + encodeURIComponent(p.barkKey) + '/' +
      encodeURIComponent(payload.title) + '/' + encodeURIComponent(payload.body) +
      (payload.url ? '?url=' + encodeURIComponent(payload.url) : '') +
      (payload.iconUrl ? (payload.url ? '&' : '?') + 'icon=' + encodeURIComponent(payload.iconUrl) : '');
    return fetch(url, { method: 'GET' }).then(function (res) {
      if (!res.ok) return safeText(res).then(function (t) {
        throw new Error('Bark ' + res.status + ': ' + (t || res.statusText));
      });
      return res;
    });
  }

  function deliverPushover(payload) {
    var p = opts.providers || {};
    if (!p.pushoverToken || !p.pushoverUserKey) {
      return Promise.reject(new Error('Pushover provider requires pushoverToken and pushoverUserKey'));
    }
    var fields = {
      token: p.pushoverToken,
      user: p.pushoverUserKey,
      title: payload.title,
      message: payload.body,
      url: payload.url,
      url_title: 'Open DSH',
    };
    if (p.pushoverDevice) fields.device = p.pushoverDevice;
    return postForm('https://api.pushover.net/1/messages.json', fields);
  }

  function deliverServerChan(payload) {
    var p = opts.providers || {};
    if (!p.serverchanSendKey) return Promise.reject(new Error('Server酱 provider requires serverchanSendKey'));
    return postForm('https://sctapi.ftqq.com/' + encodeURIComponent(p.serverchanSendKey) + '.send', {
      title: payload.title,
      desp: payload.body + (payload.url ? '\\n\\n[打开 DSH](' + payload.url + ')' : ''),
    });
  }

  function deliverDiscord(payload) {
    var p = opts.providers || {};
    if (!p.discordWebhookUrl) return Promise.reject(new Error('Discord provider requires discordWebhookUrl'));
    return postJson(p.discordWebhookUrl, {
      content: '**' + payload.title + '**\\n' + payload.body + (payload.url ? '\\n' + payload.url : ''),
      username: 'DSH Reminder',
    });
  }

  function deliverSlack(payload) {
    var p = opts.providers || {};
    if (!p.slackWebhookUrl) return Promise.reject(new Error('Slack provider requires slackWebhookUrl'));
    return postJson(p.slackWebhookUrl, {
      text: '*' + payload.title + '*\\n' + payload.body + (payload.url ? '\\n<' + payload.url + '|Open DSH>' : ''),
    });
  }

  function deliverWebhook(payload) {
    var p = opts.providers || {};
    if (!p.webhookUrl) return Promise.reject(new Error('Webhook provider requires webhookUrl'));
    var body = p.webhookPayload ? p.webhookPayload(payload) : payload;
    return postJson(p.webhookUrl, body);
  }

  function deliverCustom(payload) {
    var p = opts.providers || {};
    if (!p.customSend) return Promise.reject(new Error('Custom provider requires providers.customSend'));
    return Promise.resolve(p.customSend(payload));
  }

  function dispatch(payload) {
    var provider = opts.provider;
    if (provider === 'browser') return deliverBrowser(payload);
    if (provider === 'telegram') return deliverTelegram(payload);
    if (provider === 'bark') return deliverBark(payload);
    if (provider === 'pushover') return deliverPushover(payload);
    if (provider === 'serverchan') return deliverServerChan(payload);
    if (provider === 'discord') return deliverDiscord(payload);
    if (provider === 'slack') return deliverSlack(payload);
    if (provider === 'webhook') return deliverWebhook(payload);
    if (provider === 'custom') return deliverCustom(payload);
    return Promise.reject(new Error('Unknown provider: ' + provider));
  }

  function completeRun(status, durationMs) {
    if (!shouldNotify(status)) return Promise.resolve();
    if (opts.suppressWhenFocused && pageIsFocused()) return Promise.resolve();
    var now = Date.now();
    if (now - state.lastNotifiedAt < opts.cooldownMs) return Promise.resolve();
    state.lastNotifiedAt = now;
    var ctx = {
      status: status,
      model: state.lastModel || undefined,
      agent: state.lastAgent || undefined,
      durationMs: durationMs,
      completedAt: new Date().toISOString(),
      url: opts.clickUrl || (typeof location !== 'undefined' ? location.href : ''),
    };
    var payload = {
      title: opts.titleTemplate(ctx),
      body: opts.bodyTemplate(ctx),
      url: ctx.url,
      iconUrl: opts.iconUrl || undefined,
      status: status,
      model: ctx.model,
      agent: ctx.agent,
      durationMs: durationMs,
      completedAt: ctx.completedAt,
    };
    return dispatch(payload).then(function () {
      opts.onNotify(payload, opts.provider);
    }).catch(function (err) {
      opts.onError(toError(err), opts.provider);
    });
  }

  var api = {
    DEFAULTS: DEFAULTS,
    configure: function (options) {
      if (options) {
        for (var k in options) {
          if (Object.prototype.hasOwnProperty.call(options, k) && Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
            opts[k] = options[k];
          }
        }
        if (options.providers) opts.providers = Object.assign({}, DEFAULTS.providers, options.providers);
      }
    },
    activate: function () {
      if (state.isActive) return;
      state.isActive = true;
      if (opts.provider === 'browser' && opts.autoRequestPermission && state.permission === 'default') {
        requestBrowserPermission();
      }
      startObserver();
      bindVisibilityEvents();
    },
    deactivate: function () {
      state.isActive = false;
      stopObserver();
      for (var i = 0; i < state.unbinder.length; i++) {
        try { state.unbinder[i](); } catch (_e) {}
      }
      state.unbinder = [];
      state.runStartedAt = null;
      state.inFlight = false;
    },
    requestBrowserPermission: requestBrowserPermission,
    apply: function (ctx, options) {
      if (options) api.configure(options);
      api.activate();
    },
  };

  window.DSHCompletionReminder = api;
})();
`;

writeFileSync(resolve(DIST_DIR, 'dsh-completion-reminder.js'), standaloneDist, 'utf-8');
console.log('[build] Wrote', resolve(DIST_DIR, 'dsh-completion-reminder.js'));

console.log('[build] Done');
