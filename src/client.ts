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
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

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

  if (
    config.provider === 'browser' &&
    config.autoRequestPermission &&
    state.permission === 'default'
  ) {
    void requestBrowserPermission();
  }

  startObserver();
  bindVisibilityEvents();
  // Don't auto-show a hint — the user now finds us via DSH Settings.
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
    config.onError(toError(err), config.provider);
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
  if (state.permission === 'unsupported') {
    showInPageToast(payload);
    return;
  }
  if (state.permission !== 'granted') {
    if (config.autoRequestPermission) {
      const next = await requestBrowserPermission();
      if (next !== 'granted') {
        showInPageToast(payload, '未授予通知权限，已改为页面内提示。');
        return;
      }
    } else {
      showInPageToast(payload, '未授予通知权限，已改为页面内提示。');
      return;
    }
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
    showInPageToast(payload, '系统通知失败，已改为页面内提示。');
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
  ['browser', '🌐 浏览器通知'],
  ['telegram', '✈️ Telegram'],
  ['bark', '🍎 Bark (iOS)'],
  ['pushover', '📲 Pushover'],
  ['serverchan', '🐦 Server酱'],
  ['discord', '🎮 Discord'],
  ['slack', '💼 Slack'],
  ['webhook', '🔗 通用 Webhook'],
  ['custom', '🛠 自定义'],
];

const PANEL_STYLE_ID = 'dsh-completion-reminder-panel-style';

/**
 * The Host React component. It renders a stable <div> that the
 * vanilla JS portion of the plugin fills in. This way we get free
 * DSH theming (the host div inherits the dialog's CSS variables) and
 * we don't have to bundle React/JSX-runtime.
 */
const Host = forwardRef<HTMLDivElement, Record<string, never>>((_props, ref) => {
  const innerRef = useRef<HTMLDivElement | null>(null);
  useImperativeHandle(ref, () => innerRef.current as HTMLDivElement);
  return React.createElement('div', {
    ref: innerRef,
    className: 'dsh-reminder-host',
    'data-reminder-host': '',
  });
});
Host.displayName = 'DSHCompletionReminderHost';

/**
 * Component registered with DSH's `settings.section` slot. Renders a
 * ref-bound div into the dialog; the ref is captured by the parent
 * closure and populated with the actual settings UI.
 */
function makeSectionComponent(registerHost: (el: HTMLElement) => void) {
  return function ReminderSection(): React.ReactElement {
    const localRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      if (localRef.current) {
        registerHost(localRef.current);
      }
      return () => {
        if (localRef.current) {
          localRef.current.innerHTML = '';
        }
      };
    }, []);
    return React.createElement(Host, { ref: localRef });
  };
}

/**
 * Plugin entry point invoked by the DSH Cordis Loader.
 *
 * In DSH v1.x the host invokes the plugin's exported `apply(ctx, opts)`
 * after the module system has been bootstrapped. We use the context
 * to register a settings section.
 */
function apply(ctx: any, opts?: CompletionReminderOptions): void {
  configure(opts);
  activate();

  // Register the settings entry point.
  //
  // The user finds this under "DSH 设置 → 插件 → 完成提醒" — a sibling
  // tab to the existing "可配置" (configurable) tab. We register:
  //   1. `settings.plugins.tab` — a new tab inside the Plugins section
  //   2. `settings.section`      — fallback top-level section in case
  //      the host is too old to expose the plugins tab slot
  // The tab registration is the primary one and shows up in the right
  // place; the section is registered too so the user can still find
  // the configuration if the host has a non-standard Plugins UI.
  try {
    if (ctx && ctx.slots) {
      const slots = ctx.slots;
      const hostRef = { current: null as HTMLElement | null };

      // ──── primary: a tab inside the Plugins section ────────────────
      // DSH v1.2+ uses `settings.plugins.tab` to render tab buttons in
      // the Plugins section. The component factory is invoked with DI
      // props; we accept them and ignore everything except the empty
      // `renderSlot`, since our body is a vanilla-DOM host.
      try {
        slots.inject('settings.plugins.tab', () => {
          return slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'reminder',
              order: 100,
              label: () => '🔔 完成提醒',
              locale: '@dsh-completion-reminder',
              inject: () => ({}),
            },
            function ReminderPluginsTab() {
              const localRef = useRef<HTMLDivElement | null>(null);
              useEffect(() => {
                if (localRef.current) {
                  hostRef.current = localRef.current;
                  injectPanelInto(localRef.current);
                }
                return () => {
                  if (localRef.current) localRef.current.innerHTML = '';
                };
              }, []);
              return React.createElement(Host, { ref: localRef });
            },
          );
        });
      } catch (err) {
        try { console.warn('[dsh-completion-reminder] settings.plugins.tab registration failed:', err); } catch { /* noop */ }
      }

      // ──── fallback: top-level section ───────────────────────────────
      // Older hosts that don't know about the plugins-tab slot will
      // accept a top-level section registration so the user can still
      // find the configuration.
      try {
        slots.inject('settings.section', () => {
          const sectionFactory = makeSectionComponent((el) => {
            hostRef.current = el;
            injectPanelInto(el);
          });
          return slots.register(
            {
              name: 'settings.section',
              id: 'reminder',
              order: 50,
              label: () => '🔔 提醒',
              locale: '@dsh-completion-reminder',
              inject: () => ({}),
            },
            sectionFactory,
          );
        });
      } catch (err) {
        try { console.warn('[dsh-completion-reminder] settings.section registration failed:', err); } catch { /* noop */ }
      }

      // If neither slot was registered, the host is too old. The
      // detection still works, but the user has nowhere to configure;
      // surface a hint.
      if (!hostRef.current) {
        // Defer: hostRef gets populated on tab/section mount, but
        // that happens after DSH opens the dialog. Show a hint now.
        showFirstRunHint('DSH 主机不支持 settings.plugins.tab 槽位。');
      }
    } else {
      showFirstRunHint();
    }
  } catch (err) {
    try { console.warn('[dsh-completion-reminder] failed to register settings UI:', err); } catch { /* noop */ }
    showFirstRunHint();
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
  host.innerHTML = buildPanelHtml();
  wirePanelEvents(host);
}

function buildPanelHtml(): string {
  const providerOptions = PROVIDER_LABELS
    .map(([id, label]) => `<option value="${id}" ${config.provider === id ? 'selected' : ''}>${escapeHtml(label)}</option>`)
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
        <label class="dsh-reminder-panel-field">
          <span class="dsh-reminder-panel-label">通知渠道</span>
          <select data-reminder-input="provider">${providerOptions}</select>
        </label>
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
          <span>DSH 标签页可见时静默（推荐）</span>
        </label>
        <label class="dsh-reminder-panel-row">
          <input type="checkbox" data-reminder-input="autoRequestPermission" ${config.autoRequestPermission ? 'checked' : ''} />
          <span>自动请求浏览器通知权限</span>
        </label>
        <label class="dsh-reminder-panel-field">
          <span class="dsh-reminder-panel-label">冷却（ms）— 防止连续完成时刷屏</span>
          <input type="number" min="0" step="500" data-reminder-input="cooldownMs" value="${config.cooldownMs}" />
        </label>
      </section>

      <section class="dsh-reminder-panel-section dsh-reminder-panel-perm">
        <span>当前权限：<strong data-reminder-perm>${permissionLabel(state.permission)}</strong></span>
        <button type="button" data-reminder-action="request-permission">请求权限</button>
      </section>

      <footer class="dsh-reminder-panel-actions">
        <button type="button" class="primary" data-reminder-action="test">发送测试通知</button>
        <button type="button" data-reminder-action="reset">重置</button>
        <span class="dsh-reminder-panel-status" data-reminder-status></span>
      </footer>
      <p class="dsh-reminder-panel-hint">配置只保存在本浏览器的 localStorage，不会上传任何服务器。</p>
    </div>
  `;
}

function wirePanelEvents(host: HTMLElement): void {
  const root = host.querySelector('.dsh-reminder-panel') as HTMLElement | null;
  if (!root) return;

  root.addEventListener('change', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target instanceof HTMLSelectElement) {
      const name = target.dataset.reminderInput;
      if (name === 'provider') {
        config.provider = target.value as ProviderId;
        savePersisted();
        // Re-render so the credentials section updates to the new channel.
        renderPanelInto(host);
      }
    } else if (target instanceof HTMLInputElement) {
      const name = target.dataset.reminderInput;
      if (!name) return;
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
          title: '🧪 DSH Completion Reminder — 测试',
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
  // The host's parent (DSH settings dialog) sets `color-scheme: dark`
  // for the dark theme, so we explicitly hint the dark UA scheme on
  // selects + add explicit colors that work in both themes.  Native
  // form controls otherwise default to UA colors (white-on-white in
  // dark mode).
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
.dsh-reminder-panel-field input[type="number"],
.dsh-reminder-panel-field select {
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
  -webkit-appearance: none;
  appearance: none;
}
.dsh-reminder-panel-field select {
  /* Provide a small caret since we stripped the native chrome. */
  background-image: linear-gradient(45deg, transparent 50%, ${DSH_CSS_VARS.labelSecondary} 50%),
                    linear-gradient(135deg, ${DSH_CSS_VARS.labelSecondary} 50%, transparent 50%);
  background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 26px;
}
.dsh-reminder-panel-field input[type="text"]:focus,
.dsh-reminder-panel-field input[type="number"]:focus,
.dsh-reminder-panel-field select:focus {
  border-color: ${DSH_CSS_VARS.stateBusinessPrimary};
  box-shadow: 0 0 0 2px color-mix(in srgb, ${DSH_CSS_VARS.stateBusinessPrimary} 25%, transparent);
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

export { configure, activate, deactivate, apply, requestBrowserPermission, DEFAULT_OPTIONS, renderPanelInto }
