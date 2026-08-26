/**
 * DSH Completion Reminder — client half (v1.1).
 *
 * Detects the agent-completion lifecycle by watching the DSH composer
 * primary button's `aria-label` (which flips between "Stop generating" /
 * "Stop 生成" / "Stop" while running and "Send message" / "发送消息" /
 * "Send" when idle) and the conversation root's `data-phase` (which
 * transitions through `active` / `settling` / `hero`).
 *
 * The plugin:
 *   - exposes `window.DSHCompletionReminder.configure({...})` for API users
 *   - injects a floating 🔔 button in the bottom-right corner that opens
 *     a settings panel (provider picker + per-provider credentials + test
 *     button). Configuration is persisted to localStorage.
 *   - delivers notifications via 9 channels: browser, Telegram, Bark,
 *     Pushover, Server酱, Discord, Slack, generic Webhook, custom.
 *
 * The plugin is packaged as a DSH client plugin (`dsh.client` in
 * package.json) and loaded through `window.__ModuleLoader__`.
 */

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
  settingsPanelEl: HTMLElement | null;
  settingsButtonEl: HTMLElement | null;
  panelOpen: boolean;
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
  settingsPanelEl: null,
  settingsButtonEl: null,
  panelOpen: false,
};

// ──── DOM signals we look at ───────────────────────────────────────────────

/**
 * The composer card root in DSH: `<div data-composer-card="true">…</div>`.
 * It contains the textarea, the `data-input-scroll` scrollport, and the
 * primary send/stop button.
 */
const COMPOSER_CARD_SELECTOR = '[data-composer-card]';

/**
 * The composer root containing all sessions. Has `data-phase` attribute
 * ('hero' | 'active' | 'settling'). We use this to disambiguate "first
 * paint idle" from "completed and went idle".
 */
const CONVERSATION_ROOT_SELECTOR = '[data-conversation-scroll], [data-composer-seat]';

/**
 * The primary send/stop button. DSH flips its `aria-label` between
 * "Stop generating" / "停止生成" (while running) and "Send message" /
 * "发送消息" (when idle).  In addition, DSH adds `disabled` to the
 * button when the draft is empty.
 *
 * We do NOT match by class name (CSS-modules hashes change between
 * builds) — only by stable attributes.
 */
const PRIMARY_BUTTON_SELECTOR = 'button[type="button"]';

/**
 * Tokens we look for in the primary button's `aria-label` to detect
 * a *running* agent.
 */
const RUNNING_TOKENS = [
  'stop generating', '停止生成', '停止', 'stop',
  'abort', 'cancel generating', 'cancel',
];

/** Tokens for an *idle* / send button. */
const IDLE_TOKENS = [
  'send message', '发送消息', 'send', '发送',
];

// ──── Public API ───────────────────────────────────────────────────────────

function configure(opts?: CompletionReminderOptions): void {
  // First merge in any persisted config so the panel + programmatic
  // configure() play nicely together.
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
    refreshSettingsButtonVisibility();
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
  if (config.showSettingsPanel) {
    ensureSettingsButton();
  }
}

function deactivate(): void {
  state.isActive = false;
  stopObserver();
  for (const off of state.unbinder.splice(0)) {
    try { off(); } catch { /* noop */ }
  }
  removeSettingsUI();
  state.runStartedAt = null;
  state.inFlight = false;
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
      showSettingsPanel: config.showSettingsPanel,
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
  // Watch the whole document — DSH may swap the conversation root on
  // session change. We only act on changes inside the composer card or
  // the conversation root, which is cheap to filter in the callback.
  state.observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-disabled', 'data-phase', 'data-state', 'class', 'disabled'],
  });

  // Take an initial reading.
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
    // Attribute changes on the primary button or its `data-composer-card`
    // ancestor are the most precise signal.
    if (m.type === 'attributes') {
      const target = m.target as Element | null;
      if (target && isInsideComposer(target)) {
        evaluateNow();
        continue;
      }
    }
    // Newly added composer cards / buttons.
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
    // idle → running
    state.inFlight = true;
    state.runStartedAt = Date.now();
    return;
  }
  if (!isRunning && state.inFlight) {
    // running → idle: completion event
    state.inFlight = false;
    const startedAt = state.runStartedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    state.runStartedAt = null;
    void completeRun(determineStatus(), durationMs);
  }
}

/**
 * Find the primary send/stop button by walking up from the composer card.
 * The button is the only `<button type="button">` inside the composer that
 * is NOT the leading add-command button, so we look for buttons with an
 * aria-label that includes one of the well-known tokens.
 */
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
  // Last-resort: if the composer has exactly one button, use it.
  if (buttons.length === 1) return buttons[0];
  return null;
}

function isRunningButton(btn: HTMLButtonElement): boolean {
  const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
  return RUNNING_TOKENS.some((t) => aria.includes(t));
}

/**
 * Look at the conversation list to figure out success / error / stopped.
 * If we cannot decide, default to 'success' (the common case).
 */
function determineStatus(): AgentRunStatus {
  // Strongest signal: the conversation root's `data-phase` is `settling`
  // while a turn is being finalised. We treat the moment it leaves
  // `settling` as completion.
  const root = document.querySelector<HTMLElement>(CONVERSATION_ROOT_SELECTOR);
  const phase = root?.getAttribute('data-phase');
  if (phase === 'settling') {
    return 'success';
  }

  // Next, look at the latest assistant turn. If its last child has
  // [data-state="interrupted"] / [data-state="error"] / class includes
  // "error" / "stop", we have a more specific status.
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
    if (text && text.length < 80) {
      state.lastModel = text;
      break;
    }
  }
  const agentCandidates = document.querySelectorAll<HTMLElement>(
    '[data-agent], [data-testid*="agent" i]',
  );
  for (const el of agentCandidates) {
    const text = (el.textContent ?? '').trim();
    if (text && text.length < 80) {
      state.lastAgent = text;
      break;
    }
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

// ──── browser ──────────────────────────────────────────────────────────────

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
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 360px;
}
.dsh-reminder-toast {
  pointer-events: auto;
  background: ${DSH_CSS_VARS.bgModule};
  color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL3};
  border-radius: 10px;
  box-shadow: ${DSH_CSS_VARS.shadowLv3};
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: opacity .25s ease, transform .25s ease;
}
.dsh-reminder-toast-title { font-weight: 600; margin-bottom: 4px; color: ${DSH_CSS_VARS.labelPrimary}; }
.dsh-reminder-toast-body { color: ${DSH_CSS_VARS.labelSecondary}; white-space: pre-wrap; word-break: break-word; }
.dsh-reminder-toast-hint { color: ${DSH_CSS_VARS.labelTertiary}; font-size: 12px; margin-top: 6px; }
.dsh-reminder-toast-leave { opacity: 0; transform: translateY(-4px); }
`;
  document.head.appendChild(style);
}

// ──── Generic fetch helpers ────────────────────────────────────────────────

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

// ──── telegram ─────────────────────────────────────────────────────────────

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

// ──── bark ─────────────────────────────────────────────────────────────────

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

// ──── pushover ─────────────────────────────────────────────────────────────

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

// ──── serverchan ───────────────────────────────────────────────────────────

async function deliverServerChan(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.serverchanSendKey) throw new Error('Server酱 provider requires serverchanSendKey');
  await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(cfg.serverchanSendKey)}.send`, {
    title: payload.title,
    desp: payload.body + (payload.url ? `\n\n[打开 DSH](${payload.url})` : ''),
  });
}

// ──── discord ──────────────────────────────────────────────────────────────

async function deliverDiscord(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.discordWebhookUrl) throw new Error('Discord provider requires discordWebhookUrl');
  await postJson(cfg.discordWebhookUrl, {
    content: `**${payload.title}**\n${payload.body}${payload.url ? `\n${payload.url}` : ''}`,
    username: 'DSH Reminder',
  });
}

// ──── slack ────────────────────────────────────────────────────────────────

async function deliverSlack(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.slackWebhookUrl) throw new Error('Slack provider requires slackWebhookUrl');
  await postJson(cfg.slackWebhookUrl, {
    text: `*${payload.title}*\n${payload.body}${payload.url ? `\n<${payload.url}|Open DSH>` : ''}`,
  });
}

// ──── generic webhook ──────────────────────────────────────────────────────

async function deliverWebhook(payload: NotificationPayload): Promise<void> {
  const cfg = config.providers;
  if (!cfg.webhookUrl) throw new Error('Webhook provider requires webhookUrl');
  const body = cfg.webhookPayload
    ? cfg.webhookPayload(payload)
    : payload;
  await postJson(cfg.webhookUrl, body);
}

// ──── custom ───────────────────────────────────────────────────────────────

async function deliverCustom(payload: NotificationPayload): Promise<void> {
  const fn = config.providers.customSend;
  if (!fn) throw new Error('Custom provider requires providers.customSend');
  await fn(payload);
}

// ──── Helpers ──────────────────────────────────────────────────────────────

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

// ──── Settings panel ───────────────────────────────────────────────────────

const SETTINGS_STYLE_ID = 'dsh-completion-reminder-settings-style';

function ensureSettingsButton(): void {
  if (state.settingsButtonEl && document.body.contains(state.settingsButtonEl)) return;
  injectSettingsStyles();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dsh-reminder-fab';
  btn.setAttribute('aria-label', 'Completion Reminder Settings');
  btn.title = 'Completion Reminder';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="currentColor" d="M12 2a7 7 0 0 0-7 7v3.586l-1.707 1.707A1 1 0 0 0 4 15.5h16a1 1 0 0 0 .707-1.707L19 12.586V9a7 7 0 0 0-7-7zm0 19a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3z"/>
    </svg>
  `;
  btn.addEventListener('click', () => toggleSettingsPanel());
  document.body.appendChild(btn);
  state.settingsButtonEl = btn;
}

function refreshSettingsButtonVisibility(): void {
  if (config.showSettingsPanel) {
    ensureSettingsButton();
  } else if (state.settingsButtonEl) {
    state.settingsButtonEl.remove();
    state.settingsButtonEl = null;
    removeSettingsPanel();
  }
}

function removeSettingsUI(): void {
  removeSettingsPanel();
  if (state.settingsButtonEl) {
    state.settingsButtonEl.remove();
    state.settingsButtonEl = null;
  }
}

function toggleSettingsPanel(): void {
  if (state.panelOpen) removeSettingsPanel();
  else openSettingsPanel();
}

function openSettingsPanel(): void {
  if (state.settingsPanelEl) return;
  injectSettingsStyles();
  const panel = document.createElement('div');
  panel.className = 'dsh-reminder-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Completion Reminder Settings');
  panel.innerHTML = renderSettingsPanel();
  document.body.appendChild(panel);
  state.settingsPanelEl = panel;
  state.panelOpen = true;
  wireSettingsPanel(panel);
}

function removeSettingsPanel(): void {
  if (state.settingsPanelEl) {
    state.settingsPanelEl.remove();
    state.settingsPanelEl = null;
  }
  state.panelOpen = false;
}

function renderSettingsPanel(): string {
  const providers: Array<[ProviderId, string]> = [
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

  const providerOptions = providers
    .map(([id, name]) => `<option value="${id}" ${config.provider === id ? 'selected' : ''}>${name}</option>`)
    .join('');

  const p = config.providers;
  const fields: Array<[string, string, string, string]> = [
    ['telegramBotToken', 'Telegram Bot Token', 'bot123456:ABC…', p.telegramBotToken ?? ''],
    ['telegramChatId',   'Telegram Chat ID',   '123456789', p.telegramChatId ?? ''],
    ['barkKey',          'Bark Key',           '你的 iPhone Bark 设备 Key', p.barkKey ?? ''],
    ['barkServer',       'Bark Server（可选）', '默认 https://api.day.app', p.barkServer ?? ''],
    ['pushoverUserKey',  'Pushover User Key',  'u…', p.pushoverUserKey ?? ''],
    ['pushoverToken',    'Pushover App Token', 'a…', p.pushoverToken ?? ''],
    ['pushoverDevice',   'Pushover Device（可选）', '留空推送到所有设备', p.pushoverDevice ?? ''],
    ['serverchanSendKey','Server酱 SendKey',   'SCT…', p.serverchanSendKey ?? ''],
    ['discordWebhookUrl','Discord Webhook URL', 'https://discord.com/api/webhooks/…', p.discordWebhookUrl ?? ''],
    ['slackWebhookUrl',  'Slack Webhook URL',  'https://hooks.slack.com/services/…', p.slackWebhookUrl ?? ''],
    ['webhookUrl',       '通用 Webhook URL',   'https://your-service.example/notify', p.webhookUrl ?? ''],
  ];

  const providerFieldsHtml = fields
    .map(
      ([name, label, placeholder, value]) => `
      <label class="dsh-reminder-field" data-provider-field>
        <span>${label}</span>
        <input type="text" name="${name}" data-provider-input="${name}" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(value)}" autocomplete="off" spellcheck="false" />
      </label>`,
    )
    .join('');

  const perm = state.permission;

  return `
    <header class="dsh-reminder-panel-header">
      <strong>提醒设置</strong>
      <button type="button" class="dsh-reminder-close" data-reminder-action="close" aria-label="关闭">✕</button>
    </header>
    <div class="dsh-reminder-panel-body">
      <label class="dsh-reminder-field">
        <span>通知渠道</span>
        <select data-reminder-input="provider">${providerOptions}</select>
      </label>

      <fieldset class="dsh-reminder-group" data-reminder-group="provider-fields">
        <legend>渠道凭证（仅当前渠道需要）</legend>
        ${providerFieldsHtml}
        <p class="dsh-reminder-hint">
          配置只保存在本浏览器的 localStorage，
          <strong>不会</strong> 上传到任何服务器。
        </p>
      </fieldset>

      <fieldset class="dsh-reminder-group">
        <legend>行为</legend>
        <label class="dsh-reminder-row">
          <input type="checkbox" data-reminder-input="notifyOnSuccess" ${config.notifyOnSuccess ? 'checked' : ''} />
          <span>成功完成时通知</span>
        </label>
        <label class="dsh-reminder-row">
          <input type="checkbox" data-reminder-input="notifyOnStopped" ${config.notifyOnStopped ? 'checked' : ''} />
          <span>用户主动停止时通知</span>
        </label>
        <label class="dsh-reminder-row">
          <input type="checkbox" data-reminder-input="notifyOnError" ${config.notifyOnError ? 'checked' : ''} />
          <span>Agent 出错时通知</span>
        </label>
        <label class="dsh-reminder-row">
          <input type="checkbox" data-reminder-input="suppressWhenFocused" ${config.suppressWhenFocused ? 'checked' : ''} />
          <span>DSH 标签页可见时静默（推荐）</span>
        </label>
        <label class="dsh-reminder-row">
          <input type="checkbox" data-reminder-input="autoRequestPermission" ${config.autoRequestPermission ? 'checked' : ''} />
          <span>自动请求浏览器通知权限</span>
        </label>
        <label class="dsh-reminder-field">
          <span>冷却（ms）— 防止连续完成时刷屏</span>
          <input type="number" min="0" step="500" data-reminder-input="cooldownMs" value="${config.cooldownMs}" />
        </label>
      </fieldset>

      <div class="dsh-reminder-row dsh-reminder-status">
        <span>当前权限：<strong data-reminder-perm>${permissionLabel(perm)}</strong></span>
        <button type="button" data-reminder-action="request-permission">请求权限</button>
      </div>

      <div class="dsh-reminder-actions">
        <button type="button" class="primary" data-reminder-action="test">发送测试通知</button>
        <button type="button" data-reminder-action="save">保存</button>
        <button type="button" data-reminder-action="reset">重置</button>
      </div>
      <p class="dsh-reminder-hint" data-reminder-status></p>
    </div>
  `;
}

function wireSettingsPanel(panel: HTMLElement): void {
  panel.querySelector('[data-reminder-action="close"]')
    ?.addEventListener('click', () => removeSettingsPanel());

  panel.addEventListener('change', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target instanceof HTMLSelectElement) {
      const name = target.dataset.reminderInput;
      if (name === 'provider') {
        config.provider = target.value as ProviderId;
      }
    } else if (target instanceof HTMLInputElement) {
      const name = target.dataset.reminderInput;
      const value = target.type === 'checkbox' ? target.checked
        : target.type === 'number' ? Number(target.value) || 0
        : target.value;
      if (name === 'notifyOnSuccess')       config.notifyOnSuccess = !!value;
      else if (name === 'notifyOnStopped')  config.notifyOnStopped = !!value;
      else if (name === 'notifyOnError')    config.notifyOnError = !!value;
      else if (name === 'suppressWhenFocused') config.suppressWhenFocused = !!value;
      else if (name === 'autoRequestPermission') config.autoRequestPermission = !!value;
      else if (name === 'cooldownMs') config.cooldownMs = Number(value) || 0;
    }
    savePersisted();
  });

  panel.addEventListener('input', (ev) => {
    const target = ev.target as HTMLInputElement | null;
    if (!target) return;
    const name = target.dataset.providerInput;
    if (name) {
      (config.providers as Record<string, string>)[name] = target.value;
      savePersisted();
    }
  });

  panel.querySelector('[data-reminder-action="save"]')
    ?.addEventListener('click', () => {
      savePersisted();
      setStatus(panel, '已保存 ✓');
    });

  panel.querySelector('[data-reminder-action="reset"]')
    ?.addEventListener('click', () => {
      if (typeof localStorage !== 'undefined') {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
      }
      configure();
      removeSettingsPanel();
      openSettingsPanel();
    });

  panel.querySelector('[data-reminder-action="request-permission"]')
    ?.addEventListener('click', async () => {
      const result = await requestBrowserPermission();
      const permEl = panel.querySelector('[data-reminder-perm]');
      if (permEl) permEl.textContent = permissionLabel(result);
      setStatus(panel, result === 'granted' ? '权限已授予' : '权限状态：' + permissionLabel(result));
    });

  panel.querySelector('[data-reminder-action="test"]')
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
        setStatus(panel, '测试通知已发送，请查收。');
      } catch (err) {
        const e = toError(err);
        config.onError(e, config.provider);
        setStatus(panel, '测试失败：' + e.message, true);
      }
    });
}

function setStatus(panel: HTMLElement, text: string, isError = false): void {
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

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function injectSettingsStyles(): void {
  if (document.getElementById(SETTINGS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SETTINGS_STYLE_ID;
  style.textContent = `
.dsh-reminder-fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483600;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: ${DSH_CSS_VARS.buttonInfoFill};
  color: #fff;
  border: none;
  box-shadow: ${DSH_CSS_VARS.shadowLv3};
  cursor: pointer;
  display: grid;
  place-items: center;
  opacity: 0.85;
  transition: opacity .15s, transform .15s;
}
.dsh-reminder-fab:hover { opacity: 1; transform: scale(1.05); }

.dsh-reminder-panel {
  position: fixed;
  right: 18px;
  bottom: 70px;
  z-index: 2147483601;
  width: 360px;
  max-height: min(80vh, 640px);
  overflow: auto;
  background: ${DSH_CSS_VARS.bgModule};
  color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL3};
  border-radius: 12px;
  box-shadow: ${DSH_CSS_VARS.shadowLv3};
  font-size: 13px;
  line-height: 1.45;
  font-family: var(--dsw-font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
.dsh-reminder-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid ${DSH_CSS_VARS.borderL1};
  font-size: 14px;
  font-weight: 600;
  position: sticky;
  top: 0;
  background: ${DSH_CSS_VARS.bgModule};
}
.dsh-reminder-close {
  background: transparent;
  border: none;
  color: ${DSH_CSS_VARS.labelSecondary};
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
}
.dsh-reminder-close:hover { background: ${DSH_CSS_VARS.borderL1}; color: ${DSH_CSS_VARS.labelPrimary}; }

.dsh-reminder-panel-body { padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 14px; }

.dsh-reminder-group {
  border: 1px solid ${DSH_CSS_VARS.borderL1};
  border-radius: 8px;
  padding: 8px 10px 10px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-reminder-group > legend { padding: 0 4px; color: ${DSH_CSS_VARS.labelSecondary}; font-size: 12px; }

.dsh-reminder-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-reminder-field > span { color: ${DSH_CSS_VARS.labelSecondary}; font-size: 12px; }
.dsh-reminder-field input,
.dsh-reminder-field select {
  background: transparent;
  color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL2};
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  transition: border-color .15s, box-shadow .15s;
}
.dsh-reminder-field input:focus,
.dsh-reminder-field select:focus {
  border-color: ${DSH_CSS_VARS.stateBusinessPrimary};
  box-shadow: 0 0 0 2px color-mix(in srgb, ${DSH_CSS_VARS.stateBusinessPrimary} 25%, transparent);
}

.dsh-reminder-row { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.dsh-reminder-row > input[type="checkbox"] { accent-color: ${DSH_CSS_VARS.buttonInfoFill}; }

.dsh-reminder-actions { display: flex; gap: 8px; }
.dsh-reminder-actions button {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid ${DSH_CSS_VARS.borderL2};
  background: transparent;
  color: ${DSH_CSS_VARS.labelPrimary};
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.dsh-reminder-actions button:hover { background: ${DSH_CSS_VARS.borderL1}; }
.dsh-reminder-actions button.primary { background: ${DSH_CSS_VARS.buttonInfoFill}; color: #fff; border-color: transparent; }
.dsh-reminder-actions button.primary:hover { filter: brightness(1.05); }

.dsh-reminder-status {
  padding: 6px 8px;
  border: 1px dashed ${DSH_CSS_VARS.borderL2};
  border-radius: 6px;
  justify-content: space-between;
  flex-wrap: wrap;
}
.dsh-reminder-status button {
  background: transparent;
  color: ${DSH_CSS_VARS.labelPrimary};
  border: 1px solid ${DSH_CSS_VARS.borderL2};
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}
.dsh-reminder-status button:hover { background: ${DSH_CSS_VARS.borderL1}; }

.dsh-reminder-hint { color: ${DSH_CSS_VARS.labelTertiary}; font-size: 12px; line-height: 1.5; }
`;
  document.head.appendChild(style);
}

// ──── DSH client plugin entry ──────────────────────────────────────────────

/**
 * DSH client plugin entry — called by the Cordis Loader.
 */
function apply(ctx: unknown, opts?: CompletionReminderOptions): void {
  configure(opts);
  activate();
}

export { configure, activate, deactivate, apply, requestBrowserPermission, DEFAULT_OPTIONS }
