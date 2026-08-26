/**
 * DSH Completion Reminder — type definitions.
 */

/**
 * Identifier of a built-in notification provider.
 *  - 'browser'  : window.Notification (default; requires user permission)
 *  - 'telegram' : Telegram Bot API
 *  - 'bark'     : Apple Push (Bark) HTTP API
 *  - 'pushover' : Pushover REST API
 *  - 'serverchan': Server酱 (sct.ftqq.com) — popular in the Chinese community
 *  - 'discord'  : Discord webhook
 *  - 'slack'    : Slack incoming webhook
 *  - 'webhook'  : generic JSON POST webhook
 *  - 'custom'   : user-supplied delivery function
 */
export type ProviderId =
  | 'browser'
  | 'telegram'
  | 'bark'
  | 'pushover'
  | 'serverchan'
  | 'dingtalk'
  | 'feishu'
  | 'wecom'
  | 'discord'
  | 'slack'
  | 'webhook'
  | 'custom';

/**
 * Per-provider configuration. Only the fields relevant to the active
 * provider are read.
 */
export interface ProviderConfig {
  /** Telegram bot token (from @BotFather) */
  telegramBotToken?: string;
  /** Telegram chat id (numeric or @channel) */
  telegramChatId?: string;

  /** Bark device key (or the full server URL if self-hosting) */
  barkKey?: string;
  /** Optional Bark server URL — defaults to https://api.day.app */
  barkServer?: string;

  /** Pushover user key */
  pushoverUserKey?: string;
  /** Pushover application token */
  pushoverToken?: string;
  /** Pushover device name to restrict delivery to one device */
  pushoverDevice?: string;

  /** Server酱 SendKey (https://sct.ftqq.com) */
  serverchanSendKey?: string;

  /**
   * 钉钉自定义机器人 Webhook（完整 URL，含 access_token）。
   * https://open.dingtalk.com/document/robots/custom-robot-access
   */
  dingtalkWebhookUrl?: string;
  /** 钉钉机器人「加签」密钥（SEC 开头）。未开启加签则留空 */
  dingtalkSecret?: string;

  /** 飞书自定义机器人 Webhook（完整 URL）https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot */
  feishuWebhookUrl?: string;
  /** 飞书机器人「签名校验」密钥。未开启签名校验则留空 */
  feishuSecret?: string;

  /** 企业微信群机器人 Webhook（含 key 参数的完整 URL） */
  wecomWebhookUrl?: string;

  /** Discord incoming webhook URL */
  discordWebhookUrl?: string;
  /** Slack incoming webhook URL */
  slackWebhookUrl?: string;
  /** Generic webhook URL — POST a JSON body */
  webhookUrl?: string;
  /**
   * Optional custom JSON body shape for the generic webhook. Receives
   * `{ title, body, url, status }` and must return a serializable object.
   */
  webhookPayload?: (ctx: NotificationPayload) => unknown;

  /**
   * Custom delivery function used when provider === 'custom'. Runs in the
   * browser context; throw to signal delivery failure.
   */
  customSend?: (ctx: NotificationPayload) => Promise<void> | void;
}

/**
 * Public plugin options.
 */
export interface CompletionReminderOptions {
  /**
   * Notification provider. Defaults to 'browser'.
   */
  provider?: ProviderId;

  /**
   * Auto-request `Notification.requestPermission()` on activation when
   * the browser provider is in use and permission is 'default'.
   * @default true
   */
  autoRequestPermission?: boolean;

  /**
   * Whether to notify on successful agent completion.
   * @default true
   */
  notifyOnSuccess?: boolean;

  /**
   * Whether to notify when the user manually stops the agent.
   * @default true
   */
  notifyOnStopped?: boolean;

  /**
   * Whether to notify on agent errors (when the run fails before completion).
   * @default true
   */
  notifyOnError?: boolean;

  /**
   * Suppress notifications while the DSH tab is visible & focused.
   * @default true
   */
  suppressWhenFocused?: boolean;

  /**
   * Minimum interval between two notifications, in ms. Prevents spam
   * when several agents finish in quick succession.
   * @default 5000
   */
  cooldownMs?: number;

  /**
   * Custom title template. Receives `{ status, model, agent }` and must
   * return a string. Default: 'DSH Agent 已完成' / '已停止' / '出错'.
   */
  titleTemplate?: (ctx: TitleContext) => string;
  /**
   * Custom body template. Receives `{ status, model, agent }` and must
   * return a string. Default: human-friendly summary.
   */
  bodyTemplate?: (ctx: TitleContext) => string;

  /**
   * Optional URL to focus (DSH page) when the user clicks the notification.
   * Defaults to the current location.
   */
  clickUrl?: string;

  /**
   * Optional icon URL for browser notifications.
   */
  iconUrl?: string;

  /**
   * Per-provider configuration. Only the fields relevant to the active
   * provider are read.
   */
  providers?: ProviderConfig;

  /**
   * Optional callback invoked for every notification attempt — useful for
   * debugging or telemetry. Receives the resolved payload and the active
   * provider id.
   */
  onNotify?: (ctx: NotificationPayload, provider: ProviderId) => void;

  /**
   * Optional callback invoked on delivery errors. Use this to surface
   * misconfiguration in the console without breaking the page.
   */
  onError?: (err: Error, provider: ProviderId) => void;

  /**
   * Whether to render the floating settings panel (🔔 gear button).
   * Set to false when the user has already configured everything via API.
   * @default true
   */
  showSettingsPanel?: boolean;
}

/**
 * Context passed to the title/body templates and to onNotify/onError.
 */
export interface TitleContext {
  /** 'success' | 'stopped' | 'error' */
  status: AgentRunStatus;
  /** Best-effort model name detected from the UI (may be undefined). */
  model?: string;
  /** Best-effort agent / mode label detected from the UI. */
  agent?: string;
  /** Wall-clock duration of the run, in ms, when known. */
  durationMs?: number;
  /** ISO timestamp of completion. */
  completedAt: string;
  /** Current page URL (for click-through). */
  url: string;
}

/**
 * Final payload passed to each delivery channel.
 */
export interface NotificationPayload {
  title: string;
  body: string;
  url: string;
  iconUrl?: string;
  status: AgentRunStatus;
  model?: string;
  agent?: string;
  durationMs?: number;
  completedAt: string;
}

/**
 * Possible agent run states detected by the plugin.
 */
export type AgentRunStatus = 'success' | 'stopped' | 'error';

/**
 * Internal state object held by the plugin.
 */
export interface PluginState {
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
}

/**
 * Default options. Frozen at activation time.
 */
export const DEFAULT_OPTIONS: Required<
  Omit<
    CompletionReminderOptions,
    | 'providers'
    | 'titleTemplate'
    | 'bodyTemplate'
    | 'onNotify'
    | 'onError'
    | 'clickUrl'
    | 'iconUrl'
  >
> & {
  providers: ProviderConfig;
  titleTemplate: (ctx: TitleContext) => string;
  bodyTemplate: (ctx: TitleContext) => string;
  onNotify: (ctx: NotificationPayload, provider: ProviderId) => void;
  onError: (err: Error, provider: ProviderId) => void;
  clickUrl: string;
  iconUrl: string;
} = {
  provider: 'browser',
  autoRequestPermission: true,
  notifyOnSuccess: true,
  notifyOnStopped: true,
  notifyOnError: true,
  suppressWhenFocused: true,
  cooldownMs: 5000,
  titleTemplate: (ctx) => {
    switch (ctx.status) {
      case 'success':
        return '✅ DSH Agent 已完成';
      case 'stopped':
        return '⏹ DSH Agent 已停止';
      case 'error':
        return '⚠️ DSH Agent 出错';
    }
  },
  bodyTemplate: (ctx) => {
    const parts: string[] = [];
    if (ctx.agent) parts.push(`Agent: ${ctx.agent}`);
    if (ctx.model) parts.push(`Model: ${ctx.model}`);
    if (typeof ctx.durationMs === 'number') {
      parts.push(`用时: ${formatDuration(ctx.durationMs)}`);
    }
    if (!parts.length) return '代理任务已结束，点击查看详情。';
    return parts.join(' · ');
  },
  onNotify: () => undefined,
  onError: (err) => {
    try { console.warn('[dsh-completion-reminder]', err); } catch { /* noop */ }
  },
  providers: {},
  clickUrl: '',
  iconUrl: '',
  showSettingsPanel: true,
};

/** DSH design system CSS variable names. */
export const DSH_CSS_VARS = {
  bgModule: 'var(--dsw-alias-bg-module-platform)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  borderL3: 'var(--dsw-alias-border-l3)',
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary)',
  labelCaption: 'var(--dsw-alias-label-caption)',
  stateSuccessPrimary: 'var(--dsw-alias-state-success-primary)',
  stateWarnPrimary: 'var(--dsw-alias-state-warn-primary)',
  stateErrorPrimary: 'var(--dsw-alias-state-error-primary)',
  stateBusinessPrimary: 'var(--dsw-alias-state-business-primary)',
  buttonInfoFill: 'var(--dsw-alias-button-info-fill)',
  shadowLv3: 'var(--dsw-shadow-lv3)',
  fontStrong14: 'var(--dsw-font-s-strong-14)',
  fontXs13: 'var(--dsw-font-xs-13)',
};

/**
 * Format a millisecond duration as `1h 2m 3s` / `12s` / `345ms`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** localStorage key for the persisted user config. */
export const STORAGE_KEY = 'dsh-completion-reminder:config:v1';

/**
 * Public shape of the persisted user config (subset of CompletionReminderOptions).
 */
export interface PersistedConfig {
  provider?: ProviderId;
  autoRequestPermission?: boolean;
  notifyOnSuccess?: boolean;
  notifyOnStopped?: boolean;
  notifyOnError?: boolean;
  suppressWhenFocused?: boolean;
  cooldownMs?: number;
  showSettingsPanel?: boolean;
  providers?: ProviderConfig;
}
