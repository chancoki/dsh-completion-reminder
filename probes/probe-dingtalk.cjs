#!/usr/bin/env node
/**
 * Probe DingTalk robot API behavior with a fake token:
 * - HTTP status / body shape for errors (keyword filter vs bad token)
 * - whether Access-Control-Allow-Origin is returned (decides if the
 *   browser-side fetch can read the response at all)
 */
const https = require('node:https');

function probe(url, body, label) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 10000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ label, status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', (e) => resolve({ label, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ label, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

(async () => {
  const base = 'https://oapi.dingtalk.com/robot/send?access_token=faketoken123';
  const r1 = await probe(base, { msgtype: 'text', text: { content: 'probe' } }, 'plain-text');
  console.log('text/plain :', r1.status, r1.body);
  console.log('  acao:', r1.headers && r1.headers['access-control-allow-origin']);
  console.log('  actn:', r1.headers && r1.headers['access-control-allow-headers']);

  // preflight simulation
  const opt = await new Promise((resolve) => {
    const req = https.request({
      hostname: 'oapi.dingtalk.com', path: '/robot/send?access_token=faketoken123',
      method: 'OPTIONS',
      headers: { 'Origin': 'http://127.0.0.1:3080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      timeout: 8000,
    }, (res) => { res.resume(); resolve({ s: res.statusCode, h: res.headers }); });
    req.on('error', (e) => resolve({ e: e.message }));
    req.end();
  });
  console.log('OPTIONS    :', JSON.stringify(opt));

  // signed-style url (fake sign) to see sign-error shape
  const r2 = await probe(base + '&timestamp=1717772654000&sign=Wm%2Fb', { msgtype: 'markdown', markdown: { title: 't DSH', text: 'x' } }, 'signed');
  console.log('bad-sign   :', r2.status, r2.body);
})();
