#!/usr/bin/env node
/**
 * dsh-completion-reminder 本地转发小服务
 * =====================================
 *
 * 为什么需要它：钉钉 / 企业微信的群机器人接口不返回 CORS 头，
 * 浏览器里的网页（DSH）无法直接 POST 过去；钉钉还强制要求
 * Content-Type: application/json，而这会触发预检，预检同样被拒。
 * 这个 ~100 行的小服务把请求从本机中转出去，让插件能读到真实结果。
 *
 * 用法：
 *   node relay.mjs            # 默认监听 http://127.0.0.1:8765
 *   PORT=9000 node relay.mjs  # 自定义端口
 *
 * 安全性：
 *   - 只绑定 127.0.0.1，局域网内其他机器访问不到
 *   - 只接受 POST /forward { url, body }，url 仅允许 http(s)
 *   - 不落盘、不记录任何内容
 *
 * 协议：POST /forward，请求体 JSON：
 *   { "url": "https://oapi.dingtalk.com/robot/send?...", "body": {...} }
 * 响应 JSON：
 *   成功 → { ok: true, status: 200, data: { errcode: 0, ... } }
 *   失败 → { ok: false, status: 200, error: "errcode 310000: keywords..." }
 *          （ok:false 表示上游返回了业务错误，HTTP 状态仍是 200）
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 8765);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function forward(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  return { status: res.status, data };
}

/** Translate an upstream business error into a readable message. */
function upstreamError(data) {
  if (data && typeof data === 'object') {
    const errcode = data.errcode ?? data.code;
    if (typeof errcode === 'number' && errcode !== 0) {
      const msg = data.errmsg ?? data.msg ?? '';
      return `errcode ${errcode}${msg ? `: ${msg}` : ''}`;
    }
  }
  return undefined;
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'dsh-completion-reminder-relay' }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/forward')) {
    res.writeHead(404).end();
    return;
  }

  const payload = await readJson(req);
  if (!payload || typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bad request: need { url, body } with http(s) url' }));
    return;
  }

  try {
    const { status, data } = await forward(payload.url, payload.body);
    const bizErr = upstreamError(data);
    if (bizErr) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status, error: bizErr }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status, data }));
    }
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `网络错误: ${err && err.message ? err.message : String(err)}` }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[dsh-completion-reminder-relay] 已启动: http://127.0.0.1:' + PORT);
  console.log('保持本窗口开着即可。在 DSH 设置里把「本地转发地址」填为 http://127.0.0.1:' + PORT);
});
