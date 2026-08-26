#!/usr/bin/env node
/** End-to-end test of relay/relay.mjs against the LIVE Feishu API. */
const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'relay.mjs')], {
  env: { ...process.env, PORT: '8799' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write('[relay] ' + d));
child.stderr.on('data', (d) => process.stderr.write('[relay!] ' + d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(800);
  let pass = 0, fail = 0;
  const check = (n, c) => { console.log((c ? '  PASS ' : '  FAIL ') + n); c ? pass++ : fail++; };

  // health + CORS preflight
  const opt = await fetch('http://127.0.0.1:8799/forward', {
    method: 'OPTIONS',
    headers: { Origin: 'http://127.0.0.1:3080', 'Access-Control-Request-Method': 'POST' },
  });
  check('preflight 204 + ACAO:*', opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*');

  // forward → LIVE feishu fake-token hook → expect business error surfaced
  const r = await fetch('http://127.0.0.1:8799/forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/faketoken-e2e',
      body: { msg_type: 'text', content: { text: 'probe' } },
    }),
  });
  const j = await r.json();
  console.log('   relay response:', JSON.stringify(j));
  check('live feishu biz error surfaced through relay', j.ok === false && String(j.error).includes('19001'));

  // bad url rejected
  const r2 = await fetch('http://127.0.0.1:8799/forward', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'file:///c:/windows', body: {} }),
  });
  check('non-http url rejected', r2.status === 400);

  child.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { child.kill(); console.error(e); process.exit(1); });
