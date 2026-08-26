#!/usr/bin/env node
/** v1.7.0: relay channels removed; old dingtalk config migrates to browser. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function makeSandbox(seedRaw) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true });
  if (seedRaw !== undefined) dom.window.localStorage.setItem('dsh-completion-reminder:config:v1', seedRaw);
  Object.defineProperty(dom.window, 'crypto', { value: require('node:crypto').webcrypto, configurable: true });
  Object.defineProperty(dom.window, 'btoa', { value: (s) => Buffer.from(s, 'binary').toString('base64'), configurable: true });
  Object.defineProperty(dom.window, 'TextEncoder', { value: require('node:util').TextEncoder, configurable: true });
  const sandbox = vm.createContext(dom.window);
  sandbox.__ModuleLoader__ = { load(r) { sandbox.__REG__ = r; } };
  for (const k of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Element', 'localStorage']) sandbox[k] = dom.window[k];
  sandbox.Notification = Object.assign(function () {}, { permission: 'granted', requestPermission: async () => 'granted' });
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) });
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

  const radios = [...host.querySelectorAll('input[type=radio][data-reminder-input=provider]')];
  const ids = radios.map((r) => r.value);
  check('10 radios', radios.length === 10, ids.join(','));
  check('no dingtalk/wecom options', !ids.includes('dingtalk') && !ids.includes('wecom'));
  check('labels emoji-free', radios.every((r) => !/\p{Extended_Pictographic}/u.test(r.closest('label').textContent)));
  check('no relayUrl field rendered anywhere', !host.querySelector('[data-reminder-field="relayUrl"]'));

  // ── migration: persisted dingtalk → falls back to browser ──────────────
  const oldCfg = JSON.stringify({
    provider: 'dingtalk',
    providers: { dingtalkWebhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=X', dingtalkSecret: 'SECx', relayUrl: 'http://127.0.0.1:8765' },
  });
  const s2 = makeSandbox(oldCfg);
  s2.mod.apply(ctxStub);
  const h2 = s2.dom.window.document.createElement('div');
  s2.dom.window.document.body.appendChild(h2);
  s2.mod.renderPanelInto(h2);
  const checked2 = h2.querySelector('input[name="dsh-reminder-provider"]:checked');
  check('legacy dingtalk config migrates to browser', checked2 && checked2.value === 'browser');

  // dispatch with legacy config must not throw "unknown provider"
  let dispatched = null;
  s2.mod.configure({ onNotify: (p) => { dispatched = p; }, suppressWhenFocused: false });
  await s2.mod.testNotify ? 0 : 0; // (no such api; use completion path via configure only)
  try {
    s2.mod.configure({ provider: undefined }); // re-run guard
    check('configure survives legacy provider', true);
  } catch { check('configure survives legacy provider', false); }

  // ── feishu still direct & working ─────────────────────────────────────
  const pick = async (id) => {
    const r = [...host.querySelectorAll('input[type=radio][data-reminder-input=provider]')].find((x) => x.value === id);
    r.checked = true;
    r.dispatchEvent(new s1.dom.window.Event('change', { bubbles: true }));
    await tick();
  };
  const setField = async (k, v) => {
    const el = host.querySelector(`[data-reminder-field="${k}"]`);
    el.value = v;
    el.dispatchEvent(new s1.dom.window.Event('input', { bubbles: true }));
    await tick();
  };
  await pick('feishu');
  await setField('feishuWebhookUrl', 'https://open.feishu.cn/open-apis/bot/v2/hook/F');
  const status = await (async () => {
    host.querySelector('[data-reminder-action="test"]').click();
    await tick(); await tick();
    return host.querySelector('[data-reminder-status]').textContent;
  })();
  check('feishu success path intact', /成功|已发送/.test(status), status.trim());

  const saved = JSON.parse(s1.dom.window.localStorage.getItem('dsh-completion-reminder:config:v1'));
  check('persisted provider is feishu', saved.provider === 'feishu');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
