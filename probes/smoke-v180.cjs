#!/usr/bin/env node
/** v1.8.0: emoji-free titles, feishu card+link+sign-in-url, discord link, browser onclick, regression. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

let captured = [];
let lastNotification = null;
let feishuFailNext = false;
function makeSandbox(seedRaw) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true });
  if (seedRaw !== undefined) dom.window.localStorage.setItem('dsh-completion-reminder:config:v1', seedRaw);
  Object.defineProperty(dom.window, 'crypto', { value: require('node:crypto').webcrypto, configurable: true });
  Object.defineProperty(dom.window, 'btoa', { value: (s) => Buffer.from(s, 'binary').toString('base64'), configurable: true });
  Object.defineProperty(dom.window, 'TextEncoder', { value: require('node:util').TextEncoder, configurable: true });
  dom.window.open = (url, t) => { captured.push({ open: url, target: t }); };
  const sandbox = vm.createContext(dom.window);
  sandbox.__ModuleLoader__ = { load(r) { sandbox.__REG__ = r; } };
  for (const k of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Element', 'localStorage']) sandbox[k] = dom.window[k];
  sandbox.Notification = function (t, o) { lastNotification = { title: t, options: o, onclick: null, close() {} }; this.title = t; this.options = o; this.onclick = null; this.close = () => {}; return lastNotification; };
  sandbox.Notification.permission = 'granted';
  sandbox.Notification.requestPermission = async () => 'granted';
  sandbox.fetch = async (url, opts) => {
    captured.push({ url: String(url), opts });
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (typeof body.msg_type === 'string') {
      if (feishuFailNext) { feishuFailNext = false; return { ok: true, status: 200, json: async () => ({ code: 19001, msg: 'param invalid: token' }) }; }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const req = () => ({ createElement: (t, p) => ({ t, p }) });
  sandbox.require = req;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf-8'), sandbox);
  return { dom, mod: sandbox.__REG__.factory(req) };
}
const ctxStub = { slots: { inject(n, f) { f(); return () => {}; }, register() { return () => {}; } } };
const tick = () => new Promise((r) => setTimeout(r, 25));

(async () => {
  let pass = 0, fail = 0;
  const check = (n, c, x) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (x ? ` — ${x}` : '')); c ? pass++ : fail++; };

  const s1 = makeSandbox();
  s1.mod.configure({ cooldownMs: 0 });
  s1.mod.apply(ctxStub);
  const host = s1.dom.window.document.createElement('div');
  s1.dom.window.document.body.appendChild(host);
  s1.mod.renderPanelInto(host);

  const pick = async (id) => {
    const r = [...host.querySelectorAll('input[type=radio][data-reminder-input=provider]')].find((x) => x.value === id);
    r.checked = true; r.dispatchEvent(new s1.dom.window.Event('change', { bubbles: true })); await tick();
  };
  const setField = async (k, v) => {
    const el = host.querySelector(`[data-reminder-field="${k}"]`); el.value = v;
    el.dispatchEvent(new s1.dom.window.Event('input', { bubbles: true })); await tick();
  };
  const clickTest = async () => {
    captured = []; lastNotification = null;
    host.querySelector('[data-reminder-action="test"]').click();
    await tick(); await tick();
    return host.querySelector('[data-reminder-status]').textContent;
  };

  // ── title emoji-free (inlined) ────────────────────────────────────────
  check('no status emoji in bundle', !/[✅⏹⚠️]/.test(fs.readFileSync('lib/client.js', 'utf8')));

  // ── feishu: post card + clickable link, sign in URL when secret set ────
  await pick('feishu');
  await setField('feishuWebhookUrl', 'https://open.feishu.cn/open-apis/bot/v2/hook/F');
  await setField('feishuSecret', 'FSsecret');
  let status = await clickTest();
  const fe = captured.find((c) => c.url && c.url.startsWith('https://open.feishu.cn'));
  check('feishu uses post card', fe && JSON.parse(fe.opts.body).msg_type === 'post');
  const feBody = JSON.parse(fe.opts.body);
  const lines = feBody.content.post.zh_cn.content;
  const linkEl = lines.flat().find((e) => e.tag === 'a');
  check('feishu card has clickable link', linkEl && linkEl.tag === 'a' && /127\.0\.0\.1:3080/.test(linkEl.href), JSON.stringify(linkEl));
  check('feishu sign in URL (not body)', /[?&]timestamp=\d+/.test(fe.url) && /[?&]sign=/.test(fe.url) && !('sign' in feBody));
  check('feishu success path', /成功|已发送/.test(status), status.trim());

  // feishu business error surfaced
  feishuFailNext = true;
  status = await clickTest();
  check('feishu error surfaced (19001)', status.includes('19001'), status.trim());

  // ── discord clickable link ─────────────────────────────────────────────
  await pick('discord');
  await setField('discordWebhookUrl', 'https://discord.com/api/webhooks/abc/def');
  status = await clickTest();
  const dc = captured.find((c) => c.url && c.url.includes('discord.com'));
  check('discord body has markdown link', /\[打开 DSH\]\(http:\/\/127\.0\.0\.1:3080\//.test(dc.opts.body), dc.opts.body);

  // ── browser notification onclick opens link in new tab ────────────────
  await pick('browser');
  status = await clickTest();
  check('browser notification created', !!lastNotification, lastNotification && lastNotification.title);
  check('browser onclick handler set', lastNotification && typeof lastNotification.onclick === 'function');
  if (lastNotification && lastNotification.onclick) {
    lastNotification.onclick();
    const opened = captured.find((c) => c.open);
    check('onclick opens link in new tab', opened && opened.target === '_blank' && /127\.0\.0\.1:3080/.test(opened.open), JSON.stringify(opened));
  }

  // ── persistence regression ────────────────────────────────────────────
  const saved = JSON.parse(s1.dom.window.localStorage.getItem('dsh-completion-reminder:config:v1'));
  check('persisted provider is browser', saved.provider === 'browser');
  const s2 = makeSandbox(saved);
  s2.mod.apply(ctxStub);
  const h2 = s2.dom.window.document.createElement('div');
  s2.mod.renderPanelInto(h2);
  check('refresh keeps browser provider', h2.querySelector('input[name="dsh-reminder-provider"]:checked').value === 'browser');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
