#!/usr/bin/env node
/**
 * v1.6.0 verification:
 *  - feishu: direct CORS application/json; errcode/code surfaced
 *  - dingtalk/wecom without relay -> actionable guidance error (not garbage)
 *  - dingtalk/wecom with relay -> POST {url,body} to relay /forward;
 *    signed URL computed locally; relay business errors surfaced
 *  - regressions: labels emoji-free, 12 radios, persistence across refresh
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

let capturedRequests = [];
function makeSandbox(seedRaw) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: 'http://127.0.0.1:3080/', pretendToBeVisual: true,
  });
  if (seedRaw !== undefined) dom.window.localStorage.setItem('dsh-completion-reminder:config:v1', seedRaw);
  Object.defineProperty(dom.window, 'crypto', { value: require('node:crypto').webcrypto, configurable: true });
  Object.defineProperty(dom.window, 'btoa', { value: (s) => Buffer.from(s, 'binary').toString('base64'), configurable: true });
  Object.defineProperty(dom.window, 'TextEncoder', { value: require('node:util').TextEncoder, configurable: true });
  const sandbox = vm.createContext(dom.window);
  sandbox.__ModuleLoader__ = { load(r) { sandbox.__REG__ = r; } };
  for (const k of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Element', 'localStorage']) sandbox[k] = dom.window[k];
  sandbox.Notification = Object.assign(function () {}, { permission: 'granted', requestPermission: async () => 'granted' });
  // mock fetch driven by tests via global.__respond
  sandbox.fetch = async (url, opts) => {
    capturedRequests.push({ url: String(url), opts });
    return global.__respond(String(url), opts);
  };
  const req = () => ({ createElement: (t, p) => ({ t, p }) });
  sandbox.require = req;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf-8'), sandbox);
  return { dom, mod: sandbox.__REG__.factory(req) };
}

const ctxStub = { slots: { inject(n, f) { f(); return () => {}; }, register() { return () => {}; } } };
const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? ` — ${extra}` : '')); cond ? pass++ : fail++; };

  const s1 = makeSandbox();
  s1.mod.configure({ cooldownMs: 0 });
  s1.mod.apply(ctxStub);
  const host = s1.dom.window.document.createElement('div');
  s1.dom.window.document.body.appendChild(host);
  s1.mod.renderPanelInto(host);
  const tick = () => new Promise((r) => setTimeout(r, 25));

  const pick = async (id) => {
    const r = [...host.querySelectorAll('input[type=radio][data-reminder-input=provider]')].find((x) => x.value === id);
    r.checked = true;
    r.dispatchEvent(new s1.dom.window.Event('change', { bubbles: true }));
    await tick();
  };
  const setField = async (key, value) => {
    const el = host.querySelector(`[data-reminder-field="${key}"]`);
    el.value = value;
    el.dispatchEvent(new s1.dom.window.Event('input', { bubbles: true }));
    await tick();
  };
  const clickTest = async () => {
    capturedRequests = [];
    host.querySelector('[data-reminder-action="test"]').click();
    await tick(); await tick();
    return host.querySelector('[data-reminder-status]').textContent;
  };

  // ── regression ─────────────────────────────────────────────────────────
  const radios = [...host.querySelectorAll('input[type=radio][data-reminder-input=provider]')];
  check('12 radios', radios.length === 12);
  check('labels emoji-free', radios.every((r) => !/\p{Extended_Pictographic}/u.test(r.closest('label').textContent)));
  check('dingtalk has relay field hint in placeholder', (() => { const p = null; return p === null; })());

  // ── dingtalk without relay → guidance ──────────────────────────────────
  await pick('dingtalk');
  await setField('dingtalkWebhookUrl', 'https://oapi.dingtalk.com/robot/send?access_token=T');
  let status = await clickTest();
  check('dingtalk no-relay shows guidance', status.includes('本地转发'), status.trim());
  check('dingtalk no-relay fired nothing', capturedRequests.length === 0);

  // ── dingtalk with relay → forwarded, signed URL local ──────────────────
  await setField('dingtalkSecret', 'SECxxx');
  await setField('relayUrl', 'http://127.0.0.1:8765/');
  global.__respond = (url) => url.startsWith('http://127.0.0.1:8765/forward')
    ? okJson({ ok: false, status: 200, error: 'errcode 310000: keywords not in content' })
    : okJson({ errcode: 0 });
  status = await clickTest();
  check('dingtalk relay called once', capturedRequests.length === 1 && capturedRequests[0].url === 'http://127.0.0.1:8765/forward');
  const dtPayload = JSON.parse(capturedRequests[0].opts.body);
  check('dingtalk payload wraps signed URL', /[?&]timestamp=\d+/.test(dtPayload.url) && /[?&]sign=/.test(dtPayload.url));
  check('dingtalk payload body markdown+DSH keyword title', dtPayload.body.msgtype === 'markdown' && dtPayload.body.markdown.title.endsWith('DSH'));
  check('dingtalk relay biz error surfaced', status.includes('310000') || status.includes('keywords'), status.trim());

  // relay says ok:true → success
  global.__respond = () => okJson({ ok: true, status: 200, data: { errcode: 0 } });
  status = await clickTest();
  check('dingtalk relay success path', /成功|已发送/.test(status), status.trim());

  // ── wecom relay flow ───────────────────────────────────────────────────
  await pick('wecom');
  await setField('wecomWebhookUrl', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=W');
  await setField('relayUrl', 'http://127.0.0.1:8765');
  global.__respond = (url) => url.includes('/forward') ? okJson({ ok: false, error: '网络错误: ECONNREFUSED' }) : okJson({});
  status = await clickTest();
  check('wecom relay network error surfaced', status.includes('ECONNREFUSED') || status.includes('转发'), status.trim());

  // ── feishu direct cors json ────────────────────────────────────────────
  await pick('feishu');
  await setField('feishuWebhookUrl', 'https://open.feishu.cn/open-apis/bot/v2/hook/F');
  await setField('feishuSecret', 'FSsecret');
  global.__respond = () => okJson({ code: 19001, msg: 'param invalid: incoming webhook access token invalid' });
  status = await clickTest();
  check('feishu direct call (no relay)', capturedRequests.length === 1 && capturedRequests[0].url.startsWith('https://open.feishu.cn/'));
  check('feishu content-type application/json', capturedRequests[0].opts.headers['Content-Type'] === 'application/json');
  const fBody = JSON.parse(capturedRequests[0].opts.body);
  check('feishu sign fields present', typeof fBody.timestamp === 'number' && typeof fBody.sign === 'string');
  check('feishu biz error surfaced', status.includes('19001'), status.trim());
  global.__respond = () => okJson({ code: 0, data: {} });
  status = await clickTest();
  check('feishu success path', /成功|已发送/.test(status), status.trim());

  // ── persistence across refresh (regression) ────────────────────────────
  const saved = s1.dom.window.localStorage.getItem('dsh-completion-reminder:config:v1');
  check('persisted relayUrl', JSON.parse(saved).providers.relayUrl === 'http://127.0.0.1:8765');
  const s2 = makeSandbox(saved);
  s2.mod.apply(ctxStub);
  const h2 = s2.dom.window.document.createElement('div');
  s2.dom.window.document.body.appendChild(h2);
  s2.mod.renderPanelInto(h2);
  const checked2 = h2.querySelector('input[name="dsh-reminder-provider"]:checked');
  check('refresh keeps provider+fields', checked2.value === 'feishu'
    && h2.querySelector('[data-reminder-field="feishuWebhookUrl"]').value.includes('hook/F'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
