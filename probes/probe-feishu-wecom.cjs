#!/usr/bin/env node
const https = require('node:https');

function req(method, url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers, timeout: 9000,
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ s: res.statusCode, acao: res.headers['access-control-allow-origin'], body: b.slice(0, 200) }));
    });
    r.on('error', (e) => resolve({ e: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ e: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}
const json = { 'Content-Type': 'application/json' };

(async () => {
  console.log('── Feishu ──');
  console.log(await req('POST', 'https://open.feishu.cn/open-apis/bot/v2/hook/faketoken', json, JSON.stringify({ msg_type: 'text', content: { text: 'probe' } })));
  console.log('OPTIONS:', await req('OPTIONS', 'https://open.feishu.cn/open-apis/bot/v2/hook/faketoken', {
    Origin: 'http://127.0.0.1:3080',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  }));

  console.log('── WeCom ──');
  console.log(await req('POST', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fakekey', json, JSON.stringify({ msgtype: 'text', text: { content: 'probe' } })));
  console.log('OPTIONS:', await req('OPTIONS', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fakekey', {
    Origin: 'http://127.0.0.1:3080',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  }));
})();
