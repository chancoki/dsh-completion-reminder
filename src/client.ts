/**
 * DSH Completion Reminder — client half.
 *
 * A DOM-based DSH client plugin that fires a notification when the agent
 * stops generating. The plugin watches the input toolbar (send vs stop
 * button) and the conversation stream to detect three terminal states:
 * success, user-stopped, and error.
 *
 * Delivery channels:
 *   - browser   : window.Notification (default; user-gated permission)
 *   - telegram  : Telegram Bot API
 *   - bark      : Apple Push (Bark) HTTP API
 *   - pushover  : Pushover REST API
 *   - serverchan: Server酱 (sct.ftqq.com) — popular in CN
 *   - discord   : Discord incoming webhook
 *   - slack     : Slack incoming webhook
 *   - webhook   : generic JSON POST webhook
 *   - custom    : user-supplied function
 *
 * The plugin is packaged as a DSH client plugin (`dsh.client` in
 * package.json) and loaded through `window.__ModuleLoader__`.
 */

import type {
  AgentRunStatus,
  CompletionReminderOptions,
  NotificationPayload,
  ProviderConfig,
  ProviderId,
  TitleContext,
} from './types.js';
import {
  DEFAULT_OPTIONS,
  DSH_CSS_VARS,
  formatDuration,
} from './types.js';

// ──── State ────────────────────────────────────────────────────────────────

type ResolvedOptions = typeof DEFAULT_OPTIONS & {
  providers: ProviderConfig;
};

let config: ResolvedOptions = { ...DEFAULT_OPTIONS };

const state = {
  observer: null as MutationObserver | null,
  runStartedAt: null as number | null,
  lastModel: null as string | null,
  lastAgent: null as string | null,
  inFlight: false,
  lastNotifiedAt: 0,
  isActive: false,
  permission: detectPermission(),
  unbinder: [] as Array<() => void>,
};

// ──── DOM selectors used to detect the agent run lifecycle ─────────────────

/**
 * Selectors for the input toolbar's send/stop button. DSH renders the
 * same component with a different icon/aria-label while the agent is
 * running; we watch the button's `aria-label` and `data-*` attributes.
 */
const TOOLBAR_BUTTON_SELECTORS = [
  // DSH common: button with a "send" / "stop" accessible name.
  'button[aria-label*="send" i]',
  'button[aria-label*="stop" i]',
  'button[aria-label*="停止" i]',
  'button[aria-label*="发送" i]',
  'button[aria-label*="取消" i]',
  'button[aria-label*="中止" i]',
  'button[aria-label*="abort" i]',
  'button[aria-label*="cancel" i]',
  // DSH common: button type="submit" in the chat form.
  'form button[type="submit"]',
  'textarea + * button',
  'textarea ~ button',
];

/** Texts that, when present on a visible button, mean "agent is running". */
const RUNNING_TOKENS = [
  'stop',
  'stop generating',
  '停止',
  '中止',
  '取消生成',
  'abort',
  'cancel',
  'pause',
  '暂停',
  'interrupt',
];

/** Texts that mean "the run has finished (successfully)". */
const SUCCESS_TOKENS = [
  'send',
  '发送',
  'submit',
  '提交',
];

/** Selectors for the active conversation. */
const CONVERSATION_SELECTORS = [
  '[data-conversation-id]',
  '[data-conversation]',
  'main [class*="conversation"]',
  'main [class*="chat"]',
  'main [class*="message"]',
];

// ──── Public configure / activate / deactivate ────────────────────────────

function configure(opts?: CompletionReminderOptions): void {
  if (!opts) {
    config = { ...DEFAULT_OPTIONS };
    return;
  }
  config = {
    ...DEFAULT_OPTIONS,
    ...opts,
    providers: { ...DEFAULT_OPTIONS.providers, ...(opts.providers ?? {}) },
  };
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
}

function deactivate(): void {
  state.isActive = false;
  stopObserver();
  for (const off of state.unbinder.splice(0)) {
    try { off(); } catch { /* noop */ }
  }
  state.runStartedAt = null;
  state.inFlight = false;
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
    attributeFilter: ['aria-label', 'aria-pressed', 'data-state', 'data-status', 'class', 'disabled'],
  });

  // Take an initial reading of the current state.
  scanCurrentRun();
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
    // Toolbar changes (send ↔ stop swap) are the strongest signal.
    if (m.type === 'attributes' || m.type === 'characterData') {
      const target = m.target as Element | null;
      if (target && isInsideToolbar(target)) {
        evaluateToolbar();
      }
    }

    // New child nodes can also flip the toolbar; check the subtree root.
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches?.(TOOLBAR_BUTTON_SELECTORS.join(','))) {
        evaluateToolbar();
      } else if (node.querySelector?.(TOOLBAR_BUTTON_SELECTORS.join(','))) {
        evaluateToolbar();
      }
    }
  }
}

function isInsideToolbar(el: Element): boolean {
  return !!el.closest('form, [class*="composer" i], [class*="toolbar" i], [class*="input" i], [class*="chat-input" i]');
}

function scanCurrentRun(): void {
  // Without any history, we don't know whether the user is mid-run.
  // Trust the current toolbar state on first paint.
  evaluateToolbar();
}

function evaluateToolbar(): void {
  const buttons = collectToolbarButtons();
  if (!buttons.length) return;

  // Look for a button whose text/aria-label signals "running".
  const running = buttons.find((b) => matchesAny(b, RUNNING_TOKENS));
  const idle = buttons.find((b) => matchesAny(b, SUCCESS_TOKENS));

  // Refresh cached model/agent name opportunistically.
  captureRunMetadata();

  if (running && !state.inFlight) {
    // Edge: idle → running
    state.inFlight = true;
    state.runStartedAt = Date.now();
    return;
  }

  if (!running && state.inFlight) {
    // Edge: running → idle. We treat any exit-from-running as a
    // completion event and decide success vs stopped vs error by
    // inspecting the latest assistant message and any visible error.
    state.inFlight = false;
    const startedAt = state.runStartedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    state.runStartedAt = null;
    void completeRun(determineStatus(), durationMs);
  }

  // When the page first loads idle, do nothing.
  void idle;
}

/** Returns the buttons in the composer toolbar (send/stop/... ). */
function collectToolbarButtons(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const forms = document.querySelectorAll<HTMLElement>('form, [class*="composer" i], [class*="toolbar" i]');
  for (const f of forms) {
    const buttons = f.querySelectorAll<HTMLElement>('button');
    buttons.forEach((b) => {
      if (b.offsetParent !== null || b.getClientRects().length) out.push(b);
    });
  }
  // Also include bare buttons that match one of the toolbar selectors
  // outside a known form (best effort).
  for (const sel of TOOLBAR_BUTTON_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach((b) => {
      if (b.offsetParent !== null || b.getClientRects().length) {
        if (!out.includes(b)) out.push(b);
      }
    });
  }
  return out;
}

function matchesAny(btn: HTMLElement, tokens: string[]): boolean {
  const text = (btn.textContent ?? '').trim().toLowerCase();
  const aria = (btn.getAttribute('aria-label') ?? '').trim().toLowerCase();
  const title = (btn.getAttribute('title') ?? '').trim().toLowerCase();
  const cls = (btn.getAttribute('class') ?? '').toLowerCase();
  const hay = `${text} ${aria} ${title} ${cls}`;
  return tokens.some((tok) => hay.includes(tok));
}

/**
 * Inspect the most recent assistant message to decide success vs error.
 * If we can't decide, default to 'success' (the common case).
 */
function determineStatus(): AgentRunStatus {
  // If the user pressed stop while we were running, we still flag the
  // event as 'stopped' when an explicit stopped/error marker is visible.
  const lastAssistant = findLastAssistantMessage();
  if (!lastAssistant) return 'success';

  const text = (lastAssistant.textContent ?? '').toLowerCase();
  if (/(error|exception|failed|traceback|错误|失败|异常)/.test(text) &&
      !/no error|没有错误|successfully|成功/.test(text)) {
    return 'error';
  }
  if (/(stopped by user|user stopped|手动停止|已停止|已取消)/.test(text)) {
    return 'stopped';
  }
  return 'success';
}

function findLastAssistantMessage(): HTMLElement | null {
  for (const sel of CONVERSATION_SELECTORS) {
    const all = document.querySelectorAll<HTMLElement>(sel);
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      const role = (el.getAttribute('data-role') ?? el.getAttribute('data-author') ?? '')
        .toLowerCase();
      if (role.includes('assistant') || role.includes('agent') || role.includes('model')) {
        return el;
      }
    }
  }
  // Fallback: the last child in the conversation stream is the latest
  // message — if its text looks like an error we already know.
  const main = document.querySelector('main');
  const last = main?.lastElementChild;
  return last instanceof HTMLElement ? last : null;
}

function captureRunMetadata(): void {
  const model = readModelFromHeader();
  if (model) state.lastModel = model;

  const agent = readAgentFromHeader();
  if (agent) state.lastAgent = agent;
}

function readModelFromHeader(): string | null {
  // DSH renders a model label (e.g. "DeepSeek-V3") in a header chip.
  const candidates = document.querySelectorAll<HTMLElement>(
    '[data-model], [data-testid*="model" i], [class*="model" i]'
  );
  for (const el of candidates) {
    const text = (el.textContent ?? '').trim();
    if (text && text.length < 80) return text;
  }
  return null;
}

function readAgentFromHeader(): string | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[data-agent], [data-testid*="agent" i]'
  );
  for (const el of candidates) {
    const text = (el.textContent ?? '').trim();
    if (text && text.length < 80) return text;
  }
  return null;
}

// ──── Visibility / focus suppression ───────────────────────────────────────

function bindVisibilityEvents(): void {
  if (typeof document === 'undefined') return;
  const onVis = () => { /* noop — read on demand */ };
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

  // Cooldown — avoid rapid-fire notifications on tool-call loops.
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
    // No Notification API — fall back to an in-page toast.
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
    // Some browsers throw when called from a non-active tab.
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
.dsh-reminder-toast-title {
  font-weight: 600;
  margin-bottom: 4px;
  color: ${DSH_CSS_VARS.labelPrimary};
}
.dsh-reminder-toast-body {
  color: ${DSH_CSS_VARS.labelSecondary};
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-reminder-toast-hint {
  color: ${DSH_CSS_VARS.labelTertiary};
  font-size: 12px;
  margin-top: 6px;
}
.dsh-reminder-toast-leave {
  opacity: 0;
  transform: translateY(-4px);
}
`;
  document.head.appendChild(style);
}

// ──── Generic fetch helper ─────────────────────────────────────────────────

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
  // Bark accepts /:key/:title/:body?url=…&icon=…
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

// ──── DSH client plugin entry ──────────────────────────────────────────────

/**
 * DSH client plugin entry — called by the Cordis Loader.
 */
function apply(ctx: unknown, opts?: CompletionReminderOptions): void {
  configure(opts);
  activate();
}

export { configure, activate, deactivate, apply, requestBrowserPermission, DEFAULT_OPTIONS }
