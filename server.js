#!/usr/bin/env node
// 排班表 — 零依賴的本機 server：靜態檔案 + JSON 狀態讀寫
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function defaultState() {
  // 示範排班：符合預設三條條件（4 小時上限、11–14 休息 1 小時、11–14 收銀有人）
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const A = {};
  const put = (pid, from, to, taskId) => {
    for (let m = toMin(from); m < toMin(to); m += 30) A[`${pid}|${fmt(m)}`] = taskId;
  };
  put('p_1', '09:00', '13:00', 't_cash');
  put('p_1', '13:00', '14:00', 't_lunch');
  put('p_1', '14:00', '18:00', 't_cash');
  put('p_2', '09:00', '10:00', 't_stock');
  put('p_2', '10:00', '13:00', 't_cash');
  put('p_2', '13:00', '14:00', 't_break');
  put('p_2', '14:00', '18:00', 't_stock');
  put('p_3', '11:00', '12:00', 't_cash');
  put('p_3', '12:00', '13:00', 't_lunch');
  put('p_3', '13:00', '16:00', 't_cash');

  return {
    title: '排班表',
    date: new Date().toISOString().slice(0, 10),
    start: '09:00',
    end: '18:00',
    people: [
      { id: 'p_1', name: '阿明', color: '#5B8DEF' },
      { id: 'p_2', name: '阿珍', color: '#27AE60' },
      { id: 'p_3', name: '阿強', color: '#F2994A' },
    ],
    tasks: [
      { id: 't_cash', name: '收銀', color: '#F2994A', isBreak: false },
      { id: 't_stock', name: '補貨', color: '#9B51E0', isBreak: false },
      { id: 't_break', name: 'Break', color: '#9AA7BD', isBreak: true },
      { id: 't_lunch', name: '午餐', color: '#9AA7BD', isBreak: true },
    ],
    rules: [
      { id: 'r_cover', type: 'cover', taskId: 't_cash', from: '11:00', to: '14:00', min: 1 },
      { id: 'r_run', type: 'maxRun', hours: 4 },
      { id: 'r_lunch', type: 'rest', from: '11:00', to: '14:00', hours: 1 },
    ],
    assignments: A,
  };
}

async function readState() {
  let raw;
  try {
    raw = await fsp.readFile(STATE_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState();
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // 檔案壞掉：留一份 .broken 備份，重新開始，避免整個工具卡死
    const backup = `${STATE_FILE}.broken-${Date.now()}`;
    await fsp.rename(STATE_FILE, backup).catch(() => {});
    console.warn(`資料檔無法解析，已備份到 ${backup}，改用預設內容。`);
    return defaultState();
  }
}

async function writeState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, STATE_FILE);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(req, res, urlPath) {
  // 本機測試頁（唔會上 GitHub Pages）
  if (urlPath === '/test-drag.html') {
    try {
      const buf = await fsp.readFile(path.join(ROOT, '.tmp', 'test-drag.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
      return;
    } catch {
      res.writeHead(404);
      res.end('no test page');
      return;
    }
  }

  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    send(res, 403, JSON.stringify({ error: 'forbidden' }));
    return;
  }
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (err) {
    if (err.code === 'ENOENT') send(res, 404, JSON.stringify({ error: 'not found' }));
    else {
      send(res, 500, JSON.stringify({ error: String(err.message || err) }));
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/state') {
      if (req.method === 'GET') {
        const state = await readState();
        send(res, 200, JSON.stringify(state));
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          send(res, 400, JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          send(res, 400, JSON.stringify({ error: 'invalid state' }));
          return;
        }
        await writeState(parsed);
        send(res, 200, JSON.stringify({ ok: true }));
        return;
      }
      send(res, 405, JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: String(err.message || err) }));
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`排班表已啟動： http://${HOST}:${PORT}`);
  console.log(`資料檔： ${STATE_FILE}`);
});
