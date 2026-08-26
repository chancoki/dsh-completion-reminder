#!/usr/bin/env node
/**
 * Full matrix: {dingtalk, feishu, wecom} x {text/plain, application/json}
 * with Origin header present (browser-like), printing status, errcode-ish
 * body and every access-control-* response header.
 */
const https = require('node:https');

function req(url, ct) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = JSON.stringify({ msgtype: 'markdown', markdown: { title: 'probe DSH', text: 'probe' }, msg_type: 'text', content: { text: 'probe' } });
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': ct,
        'Content-Length': Buffer.byteLength(data),
        'Origin': 'http://127.0.0.1:3080',
      },
      timeout: 9000,
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => {
        const ac = Object.entries(res.headers).filter(([k]) => k.startsWith('access-control')).map(([k, v]) => `${k}=${v}`);
        resolve({ s: res.statusCode, ac, body: b.slice(0, 160) });
      });
    });
    r.on('error', (e) => resolve({ e: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ e: 'timeout' }); });
    r.write(data);
    r.end();
  });
}

(async () => {
  const targets = [
    ['dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=faketoken123'],
    ['feishu   ', 'https://open.feishu.cn/open-apis/bot/v2/hook/faketoken'],
    ['wecom    ', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fakekey'],
  ];
  for (const [name, url] of targets) {
    for (const ct of ['text/plain;charset=UTF-8', 'application/json']) {
      const r = await req(url, ct);
      console.log(`${name} ${ct.padEnd(26)} -> ${r.s} ac=[${(r.ac || []).join(',')}] ${r.body || r.e || ''}`);
    }
  }
})();
