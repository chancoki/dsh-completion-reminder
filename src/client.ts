/**
 * DSH Completion Reminder — client half (v1.2).
 *
 * Strategy:
 *   1. Detect agent-completion lifecycle by watching the DSH composer
 *      primary button's `aria-label` (which flips between "Stop
 *      generating" / "停止生成" and "Send message" / "发送消息") inside
 *      `[data-composer-card]`. The `data-phase` attribute on the
 *      conversation root helps disambiguate active / settling / hero.
 *
 *   2. Register a settings section in DSH's own settings dialog via
 *      `ctx.slots.inject('settings.section', ...)` so the user finds the
 *      configuration alongside General / Models / Plugins rather than as
 *      an extra floating widget.
 *
 *   3. Filter credential fields by the currently selected provider so the
 *      panel stays compact (Telegram shows 2 fields, Bark shows 1, etc.).
 *
 *   4. Persist configuration to `localStorage` and re-load on activation.
 *
 * The plugin is packaged as a DSH client plugin (`dsh.client` in
 * package.json) and loaded through `window.__ModuleLoader__`.
 */

import * as React from 'react';

import type {
  AgentRunStatus,
  CompletionReminderOptions,
  NotificationPayload,
  PersistedConfig,
  ProviderConfig,
  ProviderId,
  TitleContext,
} from './types.js';
import {
  DEFAULT_OPTIONS,
  DSH_CSS_VARS,
  STORAGE_KEY,
  formatDuration,
} from './types.js';

// ──── State ────────────────────────────────────────────────────────────────

type ResolvedOptions = typeof DEFAULT_OPTIONS & {
  providers: ProviderConfig;
};

let config: ResolvedOptions = { ...DEFAULT_OPTIONS };

const state: {
  observer: MutationObserver | null;
  runStartedAt: number | null;
  lastModel: string | null;
  lastAgent: string | null;
  inFlight: boolean;
  lastNotifiedAt: number;
  isActive: boolean;
  permission: NotificationPermission | 'unsupported';
  unbinder: Array<() => void>;
  panelHostEl: HTMLElement | null;
  panelRendered: boolean;
  hintEl: HTMLElement | null;
} = {
  observer: null,
  runStartedAt: null,
  lastModel: null,
  lastAgent: null,
  inFlight: false,
  lastNotifiedAt: 0,
  isActive: false,
  permission: detectPermission(),
  unbinder: [],
  panelHostEl: null,
  panelRendered: false,
  hintEl: null,
};

// ──── DOM signals we look at ───────────────────────────────────────────────

const COMPOSER_CARD_SELECTOR = '[data-composer-card]';
const CONVERSATION_ROOT_SELECTOR = '[data-conversation-scroll], [data-composer-seat]';

const RUNNING_TOKENS = [
  'stop generating', '停止生成', '停止', 'stop',
  'abort', 'cancel generating', 'cancel',
];

const IDLE_TOKENS = [
  'send message', '发送消息', 'send', '发送',
];

// ──── Public API ───────────────────────────────────────────────────────────

function configure(opts?: CompletionReminderOptions): void {
  const persisted = loadPersisted();
  const merged: CompletionReminderOptions = { ...persisted, ...(opts ?? {}) };
  if (!opts || opts.providers === undefined) {
    merged.providers = { ...(persisted.providers ?? {}), ...(opts?.providers ?? {}) };
  }
  config = {
    ...DEFAULT_OPTIONS,
    ...merged,
    providers: { ...DEFAULT_OPTIONS.providers, ...(merged.providers ?? {}) },
  };
  if (state.isActive) {
    // Re-render the open panel with new values.
    rerenderPanel();
  }
}

function activate(): void {
  if (state.isActive) return;
  state.isActive = true;

  // NOTE: we intentionally do NOT call Notification.requestPermission()
  // here. Browsers ignore permission prompts outside a user gesture, and
  // the failed call poisons our cached permission state. Permission is
  // requested from the settings panel's 「请求权限」 button instead.

  startObserver();
  bindVisibilityEvents();
}

function deactivate(): void {
  state.isActive = false;
  stopObserver();
  for (const off of state.unbinder.splice(0)) {
    try { off(); } catch { /* noop */ }
  }
  removeHint();
  state.runStartedAt = null;
  state.inFlight = false;
  // Clear the panel host so the next activation rebuilds it.
  if (state.panelHostEl) {
    state.panelHostEl.innerHTML = '';
    state.panelHostEl = null;
  }
  state.panelRendered = false;
}

// ──── Persistence ──────────────────────────────────────────────────────────

function loadPersisted(): PersistedConfig {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function savePersisted(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const out: PersistedConfig = {
      provider: config.provider,
      autoRequestPermission: config.autoRequestPermission,
      notifyOnSuccess: config.notifyOnSuccess,
      notifyOnStopped: config.notifyOnStopped,
      notifyOnError: config.notifyOnError,
      suppressWhenFocused: config.suppressWhenFocused,
      cooldownMs: config.cooldownMs,
      providers: config.providers,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // localStorage may be disabled — silently ignore.
  }
}

// ──── Permission handling ──────────────────────────────────────────────────

function detectPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

async function requestBrowserPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (state.permission === 'unsupported') return 'unsupported';
  if (Notification.permission !== 'default') {
    state.permission = Notification.permission;
    return Notification.permission;
  }
  try {
    const result = await Notification.requestPermission();
    state.permission = result;
    return result;
  } catch (err) {
    config.onError(toError(err), 'browser');
    return state.permission;
  }
}

// ──── DOM observation ──────────────────────────────────────────────────────

function startObserver(): void {
  if (state.observer) state.observer.disconnect();

  state.observer = new MutationObserver(handleMutations);
  state.observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-disabled', 'data-phase', 'data-state', 'class', 'disabled'],
  });
  evaluateNow();
}

function stopObserver(): void {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
}

function handleMutations(mutations: MutationRecord[]): void {
  if (!state.isActive) return;
  for (const m of mutations) {
    if (m.type === 'attributes') {
      const target = m.target as Element | null;
      if (target && isInsideComposer(target)) {
        evaluateNow();
        continue;
      }
    }
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (
        node.matches?.(COMPOSER_CARD_SELECTOR) ||
        node.querySelector?.(COMPOSER_CARD_SELECTOR)
      ) {
        evaluateNow();
      }
    }
  }
}

function isInsideComposer(el: Element): boolean {
  return !!el.closest(COMPOSER_CARD_SELECTOR);
}

function evaluateNow(): void {
  const primary = findPrimaryButton();
  captureRunMetadata();

  const isRunning = !!primary && isRunningButton(primary);
  if (isRunning && !state.inFlight) {
    state.inFlight = true;
    state.runStartedAt = Date.now();
    return;
  }
  if (!isRunning && state.inFlight) {
    state.inFlight = false;
    const startedAt = state.runStartedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    state.runStartedAt = null;
    void completeRun(determineStatus(), durationMs);
  }
}

function findPrimaryButton(): HTMLButtonElement | null {
  const card = document.querySelector<HTMLElement>(COMPOSER_CARD_SELECTOR);
  if (!card) return null;
  const buttons = card.querySelectorAll<HTMLButtonElement>('button[type="button"]');
  for (const b of buttons) {
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    if (
      RUNNING_TOKENS.some((t) => aria.includes(t)) ||
      IDLE_TOKENS.some((t) => aria.includes(t))
    ) {
      return b;
    }
  }
  if (buttons.length === 1) return buttons[0];
  return null;
}

function isRunningButton(btn: HTMLButtonElement): boolean {
  const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
  return RUNNING_TOKENS.some((t) => aria.includes(t));
}

function determineStatus(): AgentRunStatus {
  const root = document.querySelector<HTMLElement>(CONVERSATION_ROOT_SELECTOR);
  const phase = root?.getAttribute('data-phase');
  if (phase === 'settling') return 'success';

  const lastAssistant = findLastAssistantTurn();
  if (lastAssistant) {
    const cls = (lastAssistant.getAttribute('class') ?? '').toLowerCase();
    const ds = (lastAssistant.getAttribute('data-state') ?? '').toLowerCase();
    if (ds === 'interrupted' || cls.includes('interrupt') || cls.includes('stop')) {
      return 'stopped';
    }
    if (ds === 'error' || cls.includes('error') || cls.includes('fail')) {
      return 'error';
    }
    const text = (lastAssistant.textContent ?? '').toLowerCase();
    if (/(error|exception|failed|traceback|错误|失败|异常)/.test(text) &&
        !/no error|没有错误|successfully|成功/.test(text)) {
      return 'error';
    }
    if (/(stopped by user|user stopped|手动停止|已停止|已取消)/.test(text)) {
      return 'stopped';
    }
  }
  return 'success';
}

function findLastAssistantTurn(): HTMLElement | null {
  const scroll = document.querySelector<HTMLElement>(CONVERSATION_ROOT_SELECTOR);
  if (!scroll) return null;
  const candidates = scroll.querySelectorAll<HTMLElement>(
    '[data-role="assistant"], [data-author="assistant"], [data-author="model"]',
  );
  if (candidates.length) return candidates[candidates.length - 1];
  let last: HTMLElement | null = null;
  for (const child of Array.from(scroll.children)) {
    if (child instanceof HTMLElement) last = child;
  }
  return last;
}

function captureRunMetadata(): void {
  const modelCandidates = document.querySelectorAll<HTMLElement>(
    '[data-model], [data-testid*="model" i]',
  );
  for (const el of modelCandidates) {
    const text = (el.textContent ?? '').trim();
    if (text && text.length < 80) { state.lastModel = text; break; }
  }
  const agentCandidates = document.querySelectorAll<HTMLElement>(
    '[data-agent], [data-testid*="agent" i]',
  );
  for (const el of agentCandidates) {
    const text = (el.textContent ?? '').trim();
    if (text && text.length < 80) { state.lastAgent = text; break; }
  }
}

// ──── Visibility / focus suppression ───────────────────────────────────────

function bindVisibilityEvents(): void {
  if (typeof document === 'undefined') return;
  const onVis = () => { /* noop */ };
  document.addEventListener('visibilitychange', onVis);
  state.unbinder.push(() => document.removeEventListener('visibilitychange', onVis));
  const onFocus = () => { /* noop */ };
  window.addEventListener('focus', onFocus);
  state.unbinder.push(() => window.removeEventListener('focus', onFocus));
  // Keep multiple DSH tabs of the same origin in sync: a settings change
  // in tab B re-loads config in tab A.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) configure();
  };
  window.addEventListener('storage', onStorage);
  state.unbinder.push(() => window.removeEventListener('storage', onStorage));
}

/**
 * Probe localStorage availability so the panel can warn when settings
 * cannot possibly persist (private mode, disabled storage, ...).
 */
function storageStatus(): { ok: boolean; detail: string } {
  try {
    const k = `${STORAGE_KEY}:probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return { ok: true, detail: typeof location !== 'undefined' ? location.origin : '' };
  } catch {
    return { ok: false, detail: 'localStorage 不可用（无痕模式或已禁用站点数据），设置将无法保存' };
  }
}

function pageIsFocused(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState === 'hidden') return false;
  if (document.hasFocus && !document.hasFocus()) return false;
  return true;
}

// ──── Completion orchestration ─────────────────────────────────────────────

async function completeRun(status: AgentRunStatus, durationMs: number): Promise<void> {
  if (!shouldNotify(status)) return;
  if (config.suppressWhenFocused && pageIsFocused()) return;

  const now = Date.now();
  if (now - state.lastNotifiedAt < config.cooldownMs) return;
  state.lastNotifiedAt = now;

  const ctx: TitleContext = {
    status,
    model: state.lastModel ?? undefined,
    agent: state.lastAgent ?? undefined,
    durationMs,
    completedAt: new Date().toISOString(),
    url: config.clickUrl || (typeof location !== 'undefined' ? location.href : ''),
  };

  const payload: NotificationPayload = {
    title: config.titleTemplate(ctx),
    body: config.bodyTemplate(ctx),
    url: ctx.url,
    iconUrl: config.iconUrl || undefined,
    status,
    model: ctx.model,
    agent: ctx.agent,
    durationMs,
    completedAt: ctx.completedAt,
  };

  try {
    await dispatch(payload);
    config.onNotify(payload, config.provider);
  } catch (err) {
    const e = toError(err);
    config.onError(e, config.provider);
    // Surface delivery failures visibly — a silent catch here is exactly
    // how "配置了却不提醒" mysteries happen.
    showInPageToast(payload, `渠道发送失败：${e.message}`);
  }
}

function shouldNotify(status: AgentRunStatus): boolean {
  if (status === 'success') return config.notifyOnSuccess;
  if (status === 'stopped') return config.notifyOnStopped;
  if (status === 'error') return config.notifyOnError;
  return true;
}

// ──── Provider dispatch ────────────────────────────────────────────────────

async function dispatch(payload: NotificationPayload): Promise<void> {
  const provider = config.provider;
  switch (provider) {
    case 'browser':   return deliverBrowser(payload);
    case 'telegram':  return deliverTelegram(payload);
    case 'bark':      return deliverBark(payload);
    case 'pushover':  return deliverPushover(payload);
    case 'serverchan':return deliverServerChan(payload);
    case 'dingtalk':  return deliverDingTalk(payload);
    case 'feishu':    return deliverFeishu(payload);
    case 'wecom':     return deliverWecom(payload);
    case 'discord':   return deliverDiscord(payload);
    case 'slack':     return deliverSlack(payload);
    case 'webhook':   return deliverWebhook(payload);
    case 'custom':    return deliverCustom(payload);
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${exhaustive as string}`);
    }
  }
}

async function deliverBrowser(payload: NotificationPayload): Promise<void> {
  // Read LIVE permission every time — the cached state.permission can go
  // stale (user can grant/deny from the browser's site settings at any
  // moment, and boot-time non-gesture requests silently fail).
  const live: NotificationPermission | 'unsupported' =
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported';
  state.permission = live;

  if (live === 'unsupported') {
    showInPageToast(payload, '此浏览器不支持通知 API，已改为页面内提示。');
    return;
  }
  if (live !== 'granted') {
    showInPageToast(
      payload,
      live === 'denied'
        ? '通知权限已被拒绝。请在浏览器地址栏左侧的站点设置里恢复，或改用其他通知渠道。'
        : '尚未授予通知权限：打开 设置 → 完成提醒，点击「请求权限」。本次先以页面内提示代替。',
    );
    return;
  }
  try {
    const n = new Notification(payload.title, {
      body: payload.body,
      icon: payload.iconUrl,
      tag: 'dsh-completion-reminder',
      requireInteraction: false,
    });
    n.onclick = () => {
      try {
        if (typeof window !== 'undefined' && payload.url) {
          window.focus();
          window.open(payload.url, '_self');
        }
      } catch { /* noop */ }
      n.close();
    };
  } catch (err) {
    showInPageToast(payload, '系统通知创建失败（检查系统勿扰/通知设置），已改为页面内提示。');
    config.onError(toError(err), 'browser');
  }
}

function showInPageToast(payload: NotificationPayload, hint?: string): void {
  if (typeof document === 'undefined') return;
  const root = ensureToastRoot();
  const card = document.createElement('div');
  card.className = 'dsh-reminder-toast';
  card.setAttribute('role', 'status');
  card.innerHTML = `
    <div class="dsh-reminder-toast-title"></div>
    <div class="dsh-reminder-toast-body"></div>
    ${hint ? `<div class="dsh-reminder-toast-hint"></div>` : ''}
  `;
  const titleEl = card.querySelector('.dsh-reminder-toast-title') as HTMLElement;
  const bodyEl = card.querySelector('.dsh-reminder-toast-body') as HTMLElement;
  const hintEl = card.querySelector('.dsh-reminder-toast-hint') as HTMLElement | null;
  titleEl.textContent = payload.title;
  bodyEl.textContent = payload.body;
  if (hintEl) hintEl.textContent = hint ?? '';
  card.addEventListener('click', () => {
    if (payload.url) {
      try { window.open(payload.url, '_self'); } catch { /* noop */ }
    }
    card.remove();
  });
  root.appendChild(card);
  setTimeout(() => card.classList.add('dsh-reminder-toast-leave'), 4500);
  setTimeout(() => card.remove(), 5200);
}

let toastRoot: HTMLElement | null = null;
function ensureToastRoot(): HTMLElement {
  if (toastRoot && document.body.contains(toastRoot)) return toastRoot;
  injectToastStyles();
  const root = document.createElement('div');
  root.id = 'dsh-completion-reminder-toasts';
  root.className = 'dsh-reminder-toast-root';
  document.body.appendChild(root);
  toastRoot = root;
  return root;
}

const TOAST_STYLE_ID = 'dsh-completion-reminder-toast-style';
function injectToastStyles(): void {
  if (document.getElementById(TOAST_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TOAST_STYLE_ID;
  style.textContent = `
.dsh-reminder-toast-root {
  position: fixed; top: 20px; right: 20px; z-index: 2147483647;
  display: flex; flex-direction: column; gap: 8px; pointer-events: none; max-width: 360px;
}
.dsh-reminder-toast {
  pointer-events: auto;
  background: ${DSH_CSS_VARS.bgModule}; color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL3}; border-radius: 10px;
  box-shadow: ${DSH_CSS_VARS.shadowLv3};
  padding: 12px 14px; font-size: 13px; line-height: 1.4; cursor: pointer;
  transition: opacity .25s ease, transform .25s ease;
}
.dsh-reminder-toast-title { font-weight: 600; margin-bottom: 4px; color: ${DSH_CSS_VARS.labelPrimary}; }
.dsh-reminder-toast-body { color: ${DSH_CSS_VARS.labelSecondary}; white-space: pre-wrap; word-break: break-word; }
.dsh-reminder-toast-hint { color: ${DSH_CSS_VARS.labelTertiary}; font-size: 12px; margin-top: 6px; }
.dsh-reminder-toast-leave { opacity: 0; transform: translateY(-4px); }
`;
  document.head.appendChild(style);
}

async function postJson(url: string, body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`POST ${url} → ${res.status}: ${text || res.statusText}`);
  }
  return res;
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`POST ${url} → ${res.status}: ${text || res.statusText}`);
  }
  return res;
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 500); } catch { return ''; }
}

async function deliverTelegram(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    throw new Error('Telegram provider requires telegramBotToken and telegramChatId');
  }
  const url = `https://api.telegram.org/bot${encodeURIComponent(cfg.telegramBotToken)}/sendMessage`;
  const text = `*${escapeMd(payload.title)}*\n${escapeMd(payload.body)}`;
  await postJson(url, {
    chat_id: cfg.telegramChatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

async function deliverBark(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.barkKey) throw new Error('Bark provider requires barkKey');
  const server = (cfg.barkServer || 'https://api.day.app').replace(/\/$/, '');
  const url = `${server}/${encodeURIComponent(cfg.barkKey)}/${encodeURIComponent(
    payload.title,
  )}/${encodeURIComponent(payload.body)}${
    payload.url ? `?url=${encodeURIComponent(payload.url)}` : ''
  }${payload.iconUrl ? `${payload.url ? '&' : '?'}icon=${encodeURIComponent(payload.iconUrl)}` : ''}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Bark ${res.status}: ${text || res.statusText}`);
  }
}

async function deliverPushover(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.pushoverToken || !cfg.pushoverUserKey) {
    throw new Error('Pushover provider requires pushoverToken and pushoverUserKey');
  }
  const fields: Record<string, string> = {
    token: cfg.pushoverToken,
    user: cfg.pushoverUserKey,
    title: payload.title,
    message: payload.body,
    url: payload.url,
    url_title: 'Open DSH',
  };
  if (cfg.pushoverDevice) fields.device = cfg.pushoverDevice;
  await postForm('https://api.pushover.net/1/messages.json', fields);
}

async function deliverServerChan(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.serverchanSendKey) throw new Error('Server酱 provider requires serverchanSendKey');
  await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(cfg.serverchanSendKey)}.send`, {
    title: payload.title,
    desp: payload.body + (payload.url ? `\n\n[打开 DSH](${payload.url})` : ''),
  });
}

// ──── 国内渠道：钉钉 / 飞书 / 企业微信 ─────────────────────────────────────
//
// 三家的机器人 webhook 都不支持 CORS 预检所需的 OPTIONS 应答，因此统一用
// 「text/plain 简单请求 + JSON 字符串体」发送（三家服务端都按 JSON 解析原始
// body）。这是浏览器端调用群机器人的通行做法；响应若因 CORS 不可读，只要
// fetch 未 reject 即视为投递成功。

async function postJsonAsText(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(body),
  }).catch((err) => {
    throw new Error(`网络请求失败（检查 URL / 网络）：${toError(err).message}`);
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && typeof j.errmsg === 'string') detail += `: ${j.errmsg}`;
    } catch { /* opaque or non-json — keep status only */ }
    throw new Error(detail);
  }
}

async function hmacSha256Base64(keyStr: string, msgStr: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('当前环境无 Web Crypto（需 localhost/https），无法计算签名');
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msgStr));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function deliverDingTalk(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  const url0 = (cfg.dingtalkWebhookUrl ?? '').trim();
  if (!url0) throw new Error('钉钉渠道需要填写机器人 Webhook 地址');
  let url = url0;
  const secret = (cfg.dingtalkSecret ?? '').trim();
  if (secret) {
    // 官方加签算法：sign = base64(hmac_sha256(key=secret, data=`${ts}\n${secret}`))
    const ts = Date.now();
    const sign = await hmacSha256Base64(secret, `${ts}\n${secret}`);
    url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  await postJsonAsText(url, {
    msgtype: 'markdown',
    markdown: {
      title: `${payload.title} DSH`,
      text: `### ${payload.title}\n${payload.body}${payload.url ? `\n\n[${payload.url}](${payload.url})` : ''}`,
    },
  });
}

async function deliverFeishu(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  const url0 = (cfg.feishuWebhookUrl ?? '').trim();
  if (!url0) throw new Error('飞书渠道需要填写机器人 Webhook 地址');
  const secret = (cfg.feishuSecret ?? '').trim();
  const ts = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    msg_type: 'text',
    content: { text: `${payload.title}\n${payload.body}${payload.url ? `\n${payload.url}` : ''}` },
  };
  if (secret) {
    // 飞书签名校验：key = `${ts}\n${secret}`，message 为空串，base64 输出
    body.timestamp = ts;
    body.sign = await hmacSha256Base64(`${ts}\n${secret}`, '');
  }
  await postJsonAsText(url0, body);
}

async function deliverWecom(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.wecomWebhookUrl) throw new Error('企业微信渠道需要填写机器人 Webhook 地址');
  await postJsonAsText(cfg.wecomWebhookUrl, {
    msgtype: 'markdown',
    markdown: {
      content: `**${payload.title}**\n${payload.body}${payload.url ? `\n[打开 DSH](${payload.url})` : ''}`,
    },
  });
}

async function deliverDiscord(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.discordWebhookUrl) throw new Error('Discord provider requires discordWebhookUrl');
  await postJson(cfg.discordWebhookUrl, {
    content: `**${payload.title}**\n${payload.body}${payload.url ? `\n${payload.url}` : ''}`,
    username: 'DSH Reminder',
  });
}

async function deliverSlack(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.slackWebhookUrl) throw new Error('Slack provider requires slackWebhookUrl');
  await postJson(cfg.slackWebhookUrl, {
    text: `*${payload.title}*\n${payload.body}${payload.url ? `\n<${payload.url}|Open DSH>` : ''}`,
  });
}

async function deliverWebhook(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.webhookUrl) throw new Error('Webhook provider requires webhookUrl');
  const body = cfg.webhookPayload ? cfg.webhookPayload(payload) : payload;
  await postJson(cfg.webhookUrl, body);
}

async function deliverCustom(payload: NotificationPayload): Promise<void> {
  const fn = config.providers.customSend;
  if (!fn) throw new Error('Custom provider requires providers.customSend');
  await fn(payload);
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

// ──── Settings dialog integration ──────────────────────────────────────────

/**
 * Map a provider id to the credential fields it needs. Used to filter
 * the panel so users only see the fields relevant to their choice.
 */
const PROVIDER_FIELDS: Record<ProviderId, Array<{
  key: keyof ProviderConfig;
  label: string;
  placeholder: string;
  multiline?: boolean;
}>> = {
  browser: [],
  telegram: [
    { key: 'telegramBotToken', label: 'Bot Token', placeholder: '123456:ABC…' },
    { key: 'telegramChatId', label: 'Chat ID', placeholder: '123456789' },
  ],
  bark: [
    { key: 'barkKey', label: 'Bark Key', placeholder: 'iPhone Bark 设备 Key' },
    { key: 'barkServer', label: 'Bark Server（可选）', placeholder: 'https://api.day.app' },
  ],
  pushover: [
    { key: 'pushoverToken', label: 'App Token', placeholder: 'a…' },
    { key: 'pushoverUserKey', label: 'User Key', placeholder: 'u…' },
    { key: 'pushoverDevice', label: 'Device（可选）', placeholder: '留空推送到所有设备' },
  ],
  serverchan: [
    { key: 'serverchanSendKey', label: 'Server酱 SendKey', placeholder: 'SCT…' },
  ],
  dingtalk: [
    { key: 'dingtalkWebhookUrl', label: '钉钉机器人 Webhook', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
    { key: 'dingtalkSecret', label: '加签密钥（可选）', placeholder: 'SEC… 开启「加签」安全设置时填写' },
  ],
  feishu: [
    { key: 'feishuWebhookUrl', label: '飞书机器人 Webhook', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
    { key: 'feishuSecret', label: '签名校验密钥（可选）', placeholder: '开启「签名校验」时填写' },
  ],
  wecom: [
    { key: 'wecomWebhookUrl', label: '企业微信机器人 Webhook', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' },
  ],
  discord: [
    { key: 'discordWebhookUrl', label: 'Discord Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' },
  ],
  slack: [
    { key: 'slackWebhookUrl', label: 'Slack Webhook URL', placeholder: 'https://hooks.slack.com/services/…' },
  ],
  webhook: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://your-service.example/notify' },
  ],
  custom: [
    { key: 'webhookUrl', label: 'Custom provider 占位字段', placeholder: '可填任意值' },
  ],
};

const PROVIDER_LABELS: Array<[ProviderId, string]> = [
  ['browser', '浏览器通知'],
  ['serverchan', 'Server酱'],
  ['dingtalk', '钉钉机器人'],
  ['feishu', '飞书机器人'],
  ['wecom', '企业微信机器人'],
  ['bark', 'Bark (iOS)'],
  ['pushover', 'Pushover'],
  ['telegram', 'Telegram'],
  ['discord', 'Discord'],
  ['slack', 'Slack'],
  ['webhook', '通用 Webhook'],
  ['custom', '自定义'],
];

const PANEL_STYLE_ID = 'dsh-completion-reminder-panel-style';

/**
 * Where the panel currently lives. Used to avoid re-rendering the panel
 * when React re-attaches the same host element (inline callback refs are
 * re-invoked on every render).
 */
let lastPanelHostEl: HTMLElement | null = null;

/**
 * Mount/unmount the settings panel into a host element.
 *
 * This is the callback-ref body shared by every slot component we
 * register: React calls it with the element on mount (and on every
 * re-render), and with `null` on unmount.
 */
function mountPanelRef(el: HTMLElement | null): void {
  if (el) {
    state.panelHostEl = el;
    if (lastPanelHostEl !== el) {
      lastPanelHostEl = el;
      injectPanelInto(el);
    }
    return;
  }
  // Unmount: drop our references. React removes the subtree itself.
  if (state.panelHostEl) {
    state.panelHostEl.innerHTML = '';
    state.panelHostEl = null;
  }
  lastPanelHostEl = null;
}

/**
 * Build a slot component in the style dshmarket uses: a plain function
 * component that renders one div whose callback ref hands the element to
 * the vanilla-DOM panel renderer. No hooks, no forwardRef — the least
 * surface area production React can't break.
 */
function makeSlotComponent(): () => React.ReactElement {
  return function ReminderSlotHost() {
    return React.createElement('div', {
      className: 'dsh-reminder-host',
      'data-reminder-host': '',
      ref: mountPanelRef,
    });
  };
}

/**
 * Cordis service dependencies. The loader waits for these services
 * before invoking `apply`, so `ctx.slots` is guaranteed to exist here.
 *
 * This mirrors dshmarket (`inject = ['slots', 'locale', 'theme']`)
 * — without this declaration apply() can run before the slots service is
 * provided and the settings entry silently never appears.
 */
const pluginInject: string[] = ['slots'];

/**
 * Plugin display name for the cordis Loader.
 */
const pluginName = 'dsh-completion-reminder';

/**
 * Plugin entry point invoked by the DSH Cordis Loader.
 *
 * Registers two entries (both via the declaration-waiting `slots.inject`,
 * exactly like dshmarket does):
 *   1. `settings.plugins.tab` id=reminder — a "🔔 完成提醒" tab inside the
 *      Plugins section, next to the built-in 可配置 tab.
 *   2. `settings.section`    id=reminder — a top-level nav section, so the
 *      configuration is also reachable from the dialog's left navigation.
 */
function apply(ctx: any, opts?: CompletionReminderOptions): void {
  configure(opts);
  activate();

  const diag: Record<string, unknown> = { ts: Date.now(), hasSlots: false };
  try { (globalThis as any).__DSH_COMPLETION_REMINDER_DEBUG = diag; } catch { /* noop */ }

  if (!ctx || !ctx.slots) {
    diag.hasSlots = false;
    diag.error = 'ctx.slots is undefined even though inject:["slots"] was declared';
    try { console.warn('[dsh-completion-reminder]', diag.error); } catch { /* noop */ }
    return;
  }
  diag.hasSlots = true;

  const slots = ctx.slots;

  // ──── primary: a tab inside the Plugins section ────────────────────────
  try {
    slots.inject('settings.plugins.tab', () => slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'reminder',
        order: 100,
        label: () => '完成提醒',
        locale: '@dsh-completion-reminder',
        inject: () => ({}),
      },
      makeSlotComponent(),
    ));
    diag.pluginsTab = 'ok';
  } catch (err) {
    diag.pluginsTab = String(err);
    try { console.warn('[dsh-completion-reminder] settings.plugins.tab registration failed:', err); } catch { /* noop */ }
  }

  // ──── secondary: a top-level section in the dialog's left nav ─────────
  try {
    slots.inject('settings.section', () => slots.register(
      {
        name: 'settings.section',
        id: 'reminder',
        order: 45,
        label: () => '完成提醒',
        locale: '@dsh-completion-reminder',
        inject: () => ({}),
      },
      makeSlotComponent(),
    ));
    diag.section = 'ok';
  } catch (err) {
    diag.section = String(err);
    try { console.warn('[dsh-completion-reminder] settings.section registration failed:', err); } catch { /* noop */ }
  }
}

/**
 * Show a single, dismissable hint that points the user to the DSH
 * settings dialog. We only show it once and only when the section
 * registration failed (older host, no slots service, etc.).
 */
function showFirstRunHint(suffix?: string): void {
  if (state.hintEl || hasPersistedConfig()) return;
  injectHintStyles();
  const el = document.createElement('div');
  el.className = 'dsh-reminder-hint';
  const msg = suffix || '已激活。请在 DSH 设置里配置通知渠道。';
  el.innerHTML = `
    <span>🔔 DSH Completion Reminder ${escapeHtml(msg)}</span>
    <button type="button" data-reminder-hint-dismiss>知道了</button>
  `;
  el.querySelector('[data-reminder-hint-dismiss]')?.addEventListener('click', () => {
    el.remove();
    state.hintEl = null;
  });
  document.body.appendChild(el);
  state.hintEl = el;
  setTimeout(() => {
    el.classList.add('dsh-reminder-hint-leave');
    setTimeout(() => { el.remove(); state.hintEl = null; }, 600);
  }, 12000);
}

function removeHint(): void {
  if (state.hintEl) {
    state.hintEl.remove();
    state.hintEl = null;
  }
}

function hasPersistedConfig(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return !!localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
}

const HINT_STYLE_ID = 'dsh-completion-reminder-hint-style';
function injectHintStyles(): void {
  if (document.getElementById(HINT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HINT_STYLE_ID;
  style.textContent = `
.dsh-reminder-hint {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 2147483600;
  display: flex; align-items: center; gap: 10px;
  background: ${DSH_CSS_VARS.bgModule}; color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL3}; border-radius: 999px;
  box-shadow: ${DSH_CSS_VARS.shadowLv3};
  padding: 8px 8px 8px 14px;
  font-size: 13px; line-height: 1.2;
  transition: opacity .4s, transform .4s;
}
.dsh-reminder-hint button {
  background: ${DSH_CSS_VARS.buttonInfoFill}; color: #fff;
  border: none; border-radius: 999px; padding: 4px 10px;
  font-size: 12px; cursor: pointer; font-family: inherit;
}
.dsh-reminder-hint-leave { opacity: 0; transform: translate(-50%, 12px); }
`;
  document.head.appendChild(style);
}

// ──── Panel rendering (vanilla DOM inside the DSH settings dialog) ─────────

/**
 * Provider descriptions shown next to the picker.
 */
const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  browser: '使用浏览器原生通知 API，首次使用需用户授权。',
  telegram: '通过 Telegram Bot 推送到你的聊天 / 频道 / 群组。',
  bark: '通过 Bark HTTP API 推送到 iPhone。',
  pushover: '通过 Pushover 推送到 Android / iOS / 桌面。',
  serverchan: '推送到微信（sct.ftqq.com，SendKey）。',
  dingtalk: '钉钉群自定义机器人。安全设置建议用「加签」，或至少设一个自定义关键词（如 DSH）。',
  feishu: '飞书群自定义机器人。开启「签名校验」时需填密钥。',
  wecom: '企业微信群机器人。群设置里添加机器人后复制 Webhook 地址。',
  discord: '通过 Discord Webhook 推送到频道。',
  slack: '通过 Slack Incoming Webhook 推送到频道。',
  webhook: 'POST JSON 到你提供的 URL。',
  custom: '通过 customSend(payload) 函数自己实现。',
};

function injectPanelInto(host: HTMLElement): void {
  state.panelHostEl = host;
  renderPanelInto(host);
}

function rerenderPanel(): void {
  if (state.panelHostEl) {
    renderPanelInto(state.panelHostEl);
  }
}

function renderPanelInto(host: HTMLElement): void {
  injectPanelStyles();
  state.permission = detectPermission();
  host.innerHTML = buildPanelHtml();
  wirePanelEvents(host);
}

function buildPanelHtml(): string {
  // Provider picker: a radio group instead of a <select>. Native select
  // popups are rendered by the UA and can end up white-on-white inside
  // the themed dialog; radios style fully via CSS variables.
  const providerRadios = PROVIDER_LABELS
    .map(([id, label]) => `
      <label class="dsh-reminder-radio">
        <input type="radio" name="dsh-reminder-provider" data-reminder-input="provider" value="${id}" ${config.provider === id ? 'checked' : ''} />
        <span>${escapeHtml(label)}</span>
      </label>
    `)
    .join('');

  const p = config.providers;
  const fields = PROVIDER_FIELDS[config.provider] ?? [];
  const fieldsHtml = fields.length === 0
    ? `<p class="dsh-reminder-panel-hint">此渠道无需凭证，保存即可使用。</p>`
    : fields.map((f) => {
        const value = (p[f.key] as string | undefined) ?? '';
        return `
          <label class="dsh-reminder-panel-field">
            <span class="dsh-reminder-panel-label">${escapeHtml(f.label)}</span>
            <input type="text" data-reminder-field="${escapeAttr(f.key as string)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(f.placeholder)}" autocomplete="off" spellcheck="false" />
          </label>
        `;
      }).join('');

  const desc = PROVIDER_DESCRIPTIONS[config.provider] ?? '';

  return `
    <div class="dsh-reminder-panel">
      <header class="dsh-reminder-panel-header">
        <strong>Agent 完成提醒</strong>
        <span class="dsh-reminder-panel-sub">配置通知渠道，agent 完成后通知你</span>
      </header>

      <section class="dsh-reminder-panel-section">
        <header class="dsh-reminder-panel-section-title">通知渠道</header>
        <div class="dsh-reminder-radio-group" data-reminder-provider-group>${providerRadios}</div>
        <p class="dsh-reminder-panel-hint">${escapeHtml(desc)}</p>
      </section>

      <section class="dsh-reminder-panel-section">
        <header class="dsh-reminder-panel-section-title">凭证（仅当前渠道需要）</header>
        ${fieldsHtml}
      </section>

      <section class="dsh-reminder-panel-section">
        <header class="dsh-reminder-panel-section-title">行为</header>
        <label class="dsh-reminder-panel-row">
          <input type="checkbox" data-reminder-input="notifyOnSuccess" ${config.notifyOnSuccess ? 'checked' : ''} />
          <span>成功完成时通知</span>
        </label>
        <label class="dsh-reminder-panel-row">
          <input type="checkbox" data-reminder-input="notifyOnStopped" ${config.notifyOnStopped ? 'checked' : ''} />
          <span>用户主动停止时通知</span>
        </label>
        <label class="dsh-reminder-panel-row">
          <input type="checkbox" data-reminder-input="notifyOnError" ${config.notifyOnError ? 'checked' : ''} />
          <span>Agent 出错时通知</span>
        </label>
        <label class="dsh-reminder-panel-row">
          <input type="checkbox" data-reminder-input="suppressWhenFocused" ${config.suppressWhenFocused ? 'checked' : ''} />
          <span>前台静默 — DSH 标签页可见且聚焦时不通知（后台跑 agent 想被提醒就关掉这个）</span>
        </label>
        <label class="dsh-reminder-panel-field">
          <span class="dsh-reminder-panel-label">冷却（ms）— 防止连续完成时刷屏</span>
          <input type="number" min="0" step="500" data-reminder-input="cooldownMs" value="${config.cooldownMs}" />
        </label>
      </section>

      <section class="dsh-reminder-panel-section dsh-reminder-panel-perm" data-reminder-perm-row ${config.provider === 'browser' ? '' : 'hidden'}>
        <span>通知权限：<strong data-reminder-perm>${permissionLabel(state.permission)}</strong></span>
        <button type="button" data-reminder-action="request-permission">请求权限</button>
      </section>

      <footer class="dsh-reminder-panel-actions">
        <button type="button" class="primary" data-reminder-action="test">发送测试通知</button>
        <button type="button" data-reminder-action="reset">重置</button>
        <span class="dsh-reminder-panel-status" data-reminder-status></span>
      </footer>
      <p class="dsh-reminder-panel-hint">${escapeHtml(storageFooterText())}</p>
    </div>
  `;
}

function storageFooterText(): string {
  const st = storageStatus();
  const base = '配置只保存在本浏览器，不会上传任何服务器。';
  if (!st.ok) return `${base} ⚠️ ${st.detail}`;
  return `${base} 当前站点：${st.detail}（注意：localhost 和 127.0.0.1 算不同站点，配置互不相通）`;
}

function wirePanelEvents(host: HTMLElement): void {
  const root = host.querySelector('.dsh-reminder-panel') as HTMLElement | null;
  if (!root) return;

  root.addEventListener('change', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target instanceof HTMLInputElement) {
      const name = target.dataset.reminderInput;
      if (!name) return;

      // Provider radios swap the credentials section, so they get their
      // own branch before the generic boolean/number parsing below.
      if (name === 'provider') {
        if (target.type !== 'radio' || !target.checked) return;
        config.provider = target.value as ProviderId;
        savePersisted();
        // Re-render so credentials + permission row match the channel.
        renderPanelInto(host);
        return;
      }

      const value = target.type === 'checkbox' ? target.checked
        : target.type === 'number' ? Number(target.value) || 0
        : target.value;
      if (name === 'notifyOnSuccess')       config.notifyOnSuccess = !!value;
      else if (name === 'notifyOnStopped')  config.notifyOnStopped = !!value;
      else if (name === 'notifyOnError')    config.notifyOnError = !!value;
      else if (name === 'suppressWhenFocused') config.suppressWhenFocused = !!value;
      else if (name === 'autoRequestPermission') config.autoRequestPermission = !!value;
      else if (name === 'cooldownMs') config.cooldownMs = Number(value) || 0;
      savePersisted();
    }
  });

  root.addEventListener('input', (ev) => {
    const target = ev.target as HTMLInputElement | null;
    if (!target) return;
    const key = target.dataset.reminderField;
    if (key) {
      (config.providers as Record<string, string>)[key] = target.value;
      savePersisted();
    }
  });

  root.querySelector('[data-reminder-action="reset"]')?.addEventListener('click', () => {
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
    }
    configure();
    renderPanelInto(host);
    setPanelStatus(root, '已重置 ✓');
  });

  root.querySelector('[data-reminder-action="request-permission"]')
    ?.addEventListener('click', async () => {
      const result = await requestBrowserPermission();
      const permEl = root.querySelector('[data-reminder-perm]');
      if (permEl) permEl.textContent = permissionLabel(result);
      setPanelStatus(root, result === 'granted' ? '权限已授予' : '权限状态：' + permissionLabel(result));
    });

  root.querySelector('[data-reminder-action="test"]')
    ?.addEventListener('click', async () => {
      try {
        const ctx: TitleContext = {
          status: 'success',
          durationMs: 4321,
          completedAt: new Date().toISOString(),
          url: typeof location !== 'undefined' ? location.href : '',
        };
        const payload: NotificationPayload = {
          title: '【测试】DSH 完成提醒',
          body: `这是 ${config.provider} 渠道的测试通知。Agent 完成后将使用相同的方式推送。`,
          url: ctx.url,
          status: 'success',
          durationMs: ctx.durationMs,
          completedAt: ctx.completedAt,
        };
        await dispatch(payload);
        config.onNotify(payload, config.provider);
        setPanelStatus(root, '测试通知已发送，请查收。');
      } catch (err) {
        const e = toError(err);
        config.onError(e, config.provider);
        setPanelStatus(root, '测试失败：' + e.message, true);
      }
    });
}

function setPanelStatus(panel: HTMLElement, text: string, isError = false): void {
  const el = panel.querySelector('[data-reminder-status]');
  if (!el) return;
  el.textContent = text;
  (el as HTMLElement).style.color = isError
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-state-success-primary)';
  setTimeout(() => {
    if (el.textContent === text) el.textContent = '';
  }, 5000);
}

function permissionLabel(p: NotificationPermission | 'unsupported'): string {
  if (p === 'granted') return '已授予';
  if (p === 'denied') return '已拒绝';
  if (p === 'unsupported') return '不支持';
  return '未询问';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function injectPanelStyles(): void {
  if (document.getElementById(PANEL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PANEL_STYLE_ID;
  // All controls use explicit colors from DSH CSS variables plus
  // `color-scheme: light dark` so UA-rendered bits (radio/checkbox
  // glyphs) follow the dialog theme. There are no native <select>
  // popups anywhere — those were the white-on-white offenders.
  style.textContent = `
.dsh-reminder-host { color: inherit; }
.dsh-reminder-host,
.dsh-reminder-host * { box-sizing: border-box; }
.dsh-reminder-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  color: ${DSH_CSS_VARS.labelPrimary};
  font-size: 13px;
  line-height: 1.5;
  padding: 4px 4px 24px;
}
.dsh-reminder-panel-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-bottom: 1px solid ${DSH_CSS_VARS.borderL1};
  padding-bottom: 12px;
}
.dsh-reminder-panel-header strong { font-size: 15px; font-weight: 600; }
.dsh-reminder-panel-sub { color: ${DSH_CSS_VARS.labelTertiary}; font-size: 12px; }

.dsh-reminder-panel-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsh-reminder-panel-section-title {
  font-size: 12px;
  color: ${DSH_CSS_VARS.labelSecondary};
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.dsh-reminder-panel-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-reminder-panel-label {
  color: ${DSH_CSS_VARS.labelSecondary};
  font-size: 12px;
}
.dsh-reminder-panel-field input[type="text"],
.dsh-reminder-panel-field input[type="number"] {
  color-scheme: light dark;
  width: 100%;
  background: transparent;
  color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL2};
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.dsh-reminder-panel-field input[type="text"]:focus,
.dsh-reminder-panel-field input[type="number"]:focus {
  border-color: ${DSH_CSS_VARS.stateBusinessPrimary};
  box-shadow: 0 0 0 2px color-mix(in srgb, ${DSH_CSS_VARS.stateBusinessPrimary} 25%, transparent);
}

/* Provider picker — radio group (no native popup, theme-safe). */
.dsh-reminder-radio-group {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 4px 12px;
}
.dsh-reminder-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  color: ${DSH_CSS_VARS.labelPrimary};
  font-size: 13px;
}
.dsh-reminder-radio:hover { background: ${DSH_CSS_VARS.borderL1}; }
.dsh-reminder-radio input[type="radio"] {
  accent-color: ${DSH_CSS_VARS.buttonInfoFill};
  color-scheme: light dark;
  margin: 0;
  flex: none;
}

.dsh-reminder-panel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.dsh-reminder-panel-row > input[type="checkbox"] {
  accent-color: ${DSH_CSS_VARS.buttonInfoFill};
  color-scheme: light dark;
}

.dsh-reminder-panel-hint {
  color: ${DSH_CSS_VARS.labelTertiary};
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}

.dsh-reminder-panel-perm {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed ${DSH_CSS_VARS.borderL2};
  border-radius: 6px;
  color: ${DSH_CSS_VARS.labelSecondary};
  font-size: 12px;
}
.dsh-reminder-panel-perm strong { color: ${DSH_CSS_VARS.labelPrimary}; }
.dsh-reminder-panel-perm button {
  background: transparent;
  color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL2};
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}
.dsh-reminder-panel-perm button:hover { background: ${DSH_CSS_VARS.borderL1}; }

.dsh-reminder-panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-reminder-panel-actions button {
  padding: 6px 14px;
  border: 1px solid ${DSH_CSS_VARS.borderL2};
  background: transparent;
  color: ${DSH_CSS_VARS.labelPrimary};
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.dsh-reminder-panel-actions button:hover { background: ${DSH_CSS_VARS.borderL1}; }
.dsh-reminder-panel-actions button.primary {
  background: ${DSH_CSS_VARS.buttonInfoFill};
  color: #fff;
  border-color: transparent;
}
.dsh-reminder-panel-actions button.primary:hover { filter: brightness(1.05); }

.dsh-reminder-panel-status {
  margin-left: auto;
  color: ${DSH_CSS_VARS.stateSuccessPrimary};
  font-size: 12px;
  min-width: 0;
  flex: 1 1 0;
  text-align: right;
}
`;
  document.head.appendChild(style);
}

// The cordis Loader reads `inject` (service waits) and `name` (entry
// display name) off the module exports — same pattern as dshmarket.
export {
  configure,
  activate,
  deactivate,
  apply,
  requestBrowserPermission,
  DEFAULT_OPTIONS,
  renderPanelInto,
  pluginInject as inject,
  pluginName as name,
}
