'use strict';

/* ---------------- constants ---------------- */
const LS_KEY = 'scheduler.state.v3';
const SLOT_MIN = 30; // 內部精度：半小時；畫面一小時一格
const SHARE_PREFIX = 'j2.';
const SHARE_PREFIX_V1 = 'j1.';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const SHARE_LIMIT = 60000; // 超過就唔出連結

// 'server' = 有本機 node server（自動存檔）；'local' = 純前端，存 localStorage
let MODE = 'local';
let readonly = false;

const PERSON_PALETTE = ['#5B8DEF', '#27AE60', '#F2994A', '#9B51E0', '#EB5757', '#2D9CDB', '#F2C94C', '#56CCF2', '#BB6BD9', '#6FCF97', '#E07A5F', '#3D5A80'];
const TASK_PALETTE = ['#F2994A', '#9B51E0', '#2D9CDB', '#EB5757', '#27AE60', '#F2C94C', '#5B8DEF', '#BB6BD9'];

let state = null;
const undoStack = [];
let saveTimer = null;
let dragging = null;
let moving = null; // 觸控搬移模式：{ personId, slots[] }
let selectedTaskId = null;
let zoomed = false; // false = 全部時間擠入畫面；true = 放大可左右滾動
let warnings = [];
let warnCells = new Map();
let warnPeople = new Map();
let warnSlots = new Map();

/* ---------------- tiny helpers ---------------- */
const $ = (id) => document.getElementById(id);
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const key = (personId, slot) => `${personId}|${slot}`;

function toMin(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fmt(min) {
  const t = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
const addMin = (hhmm, n) => fmt(toMin(hhmm) + n);
const hourOf = (hhmm) => `${String(Math.floor(toMin(hhmm) / 60)).padStart(2, '0')}:00`;

const taskById = (id) => state.tasks.find((t) => t.id === id) || null;
const personById = (id) => state.people.find((p) => p.id === id) || null;

function bgFor(hex, alpha = 0.9) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function textFor(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.65 ? '#3a2a00' : '#ffffff';
}

/* ---------------- day model ---------------- */
function slots() {
  return slotsFor(state.start, state.end);
}

function slotsFor(start, end) {
  let a = toMin(start);
  let b = toMin(end);
  if (b <= a) b += 1440; // 跨夜
  a = Math.floor(a / 30) * 30;
  b = Math.ceil(b / 30) * 30;
  const out = [];
  for (let t = a; t < b; t += SLOT_MIN) out.push(fmt(t));
  return out;
}

function hours() {
  const out = [];
  for (const s of slots()) {
    const h = hourOf(s);
    const last = out[out.length - 1];
    if (last && last.hour === h) last.slots.push(s);
    else out.push({ hour: h, slots: [s] });
  }
  return out;
}

function rangeSlots(from, to) {
  let a = toMin(from);
  let b = toMin(to);
  if (b <= a) b += 1440;
  return slots().filter((s) => {
    const m = toMin(s);
    return m >= a && m < b;
  });
}

function assignedTask(personId, slot) {
  return taskById(state.assignments[key(personId, slot)]);
}
function isWorking(personId, slot) {
  const t = assignedTask(personId, slot);
  return Boolean(t) && !t.isBreak;
}
function isRest(personId, slot) {
  const t = assignedTask(personId, slot);
  return !t || Boolean(t.isBreak);
}

// 這人在這個 slot 是否應該上班（可上班時段 + 已排班）
function isAvailable(person, slot) {
  const m = toMin(slot);
  if (person.from && m < toMin(person.from)) return false;
  if (person.to && m >= toMin(person.to)) return false;
  return true;
}

function personName(id) {
  const p = personById(id);
  return p ? p.name : id;
}
function countTask(slot, taskId) {
  let n = 0;
  for (const p of state.people) if (state.assignments[key(p.id, slot)] === taskId) n += 1;
  return n;
}

/* ---------------- persistence ---------------- */
function normalize(s) {
  const out = {
    title: '排班表',
    date: new Date().toISOString().slice(0, 10),
    start: '09:00',
    end: '18:00',
    people: [],
    tasks: [],
    rules: [],
    assignments: {},
    ...(s || {}),
  };
  out.people = Array.isArray(out.people)
    ? out.people.filter((p) => p && p.id).map((p) => {
        const person = { id: p.id, name: p.name || '人手', color: p.color || '#5B8DEF' };
        if (p.from) person.from = p.from;   // 可上班時間（含）
        if (p.to) person.to = p.to;         // 可上班時間（不含）
        if (p.dailyMax) person.dailyMax = Number(p.dailyMax) || 0;
        if (p.noBreak) person.noBreak = true;      // 不受休息類規則約束
        if (p.noRunLimit) person.noRunLimit = true; // 不受連做上限約束
        return person;
      })
    : [];
  out.tasks = Array.isArray(out.tasks)
    ? out.tasks.filter((t) => t && t.id).map((t) => ({ id: t.id, name: t.name, color: t.color || '#5B8DEF', isBreak: Boolean(t.isBreak) }))
    : [];
  out.rules = Array.isArray(out.rules) ? out.rules.filter((r) => r && r.id && r.type) : [];
  out.assignments = out.assignments && typeof out.assignments === 'object' ? out.assignments : {};
  if (!out.start) out.start = '09:00';
  if (!out.end) out.end = '18:00';
  return out;
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return demoSeed();
    return normalize(JSON.parse(raw));
  } catch {
    return demoSeed();
  }
}

// 純前端第一次開：給一份示範，方便即刻睇到效果
function demoSeed() {
  const A = {};
  const put = (pid, from, to, taskId) => {
    for (let m = toMin(from); m < toMin(to); m += SLOT_MIN) A[key(pid, fmt(m))] = taskId;
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
  return normalize({
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
  });
}

// 有 /api/state 就當係本機 server 模式；GitHub Pages 上會 fetch 到 404 HTML → local 模式
async function detectMode() {
  if (location.protocol === 'file:') return 'local';
  try {
    const res = await fetch('./api/state', { headers: { Accept: 'application/json' } });
    if (!res.ok) return 'local';
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) return 'local';
    await res.json();
    return 'server';
  } catch {
    return 'local';
  }
}

async function load() {
  MODE = await detectMode();
  if (MODE === 'local') {
    state = readLocal();
    return;
  }
  try {
    const res = await fetch('./api/state');
    if (!res.ok) throw new Error('load failed');
    state = normalize(await res.json());
  } catch (err) {
    console.warn('讀取失敗，改用本機資料', err);
    state = readLocal();
  }
}

function setSaveStatus(text) {
  $('saveStatus').textContent = text;
}

let saving = false;
let dirty = false;

function save(immediate = false) {
  if (readonly) return;
  if (MODE === 'local') {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      setSaveStatus('已存在本機');
    } catch (err) {
      console.error(err);
      setSaveStatus('本機儲存失敗（可能空間不足）');
    }
    return;
  }
  setSaveStatus('未儲存…');
  dirty = true;
  clearTimeout(saveTimer);
  if (immediate) flushSave();
  else saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
  if (saving || !dirty) return;
  saving = true;
  dirty = false;
  setSaveStatus('儲存中…');
  try {
    const res = await fetch('./api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error(await res.text());
    const t = new Date();
    setSaveStatus(`已儲存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`);
  } catch (err) {
    console.error(err);
    dirty = true;
    setSaveStatus('儲存失敗');
  } finally {
    saving = false;
    if (dirty) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSave, 200);
    }
  }
}

function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 60) undoStack.shift();
  $('undoBtn').disabled = undoStack.length === 0;
}

function undo() {
  if (readonly || !undoStack.length) return;
  state = normalize(JSON.parse(undoStack.pop()));
  $('undoBtn').disabled = undoStack.length === 0;
  syncInputs();
  renderAll();
  save(true);
}

function commit(mutator) {
  if (readonly) return;
  snapshot();
  mutator();
  renderAll();
  save();
}

/* ---------------- share codec ---------------- */
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64decodeUtf8(s) {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeShare(s) {
  // 工作太多（>36）就退回舊格式，避免 base36 單字元表示不夠用
  if (s.tasks.length > 36 || s.people.length > 99) {
    return SHARE_PREFIX_V1 + b64encodeUtf8(JSON.stringify(s));
  }
  const sl = slotsFor(s.start, s.end);
  const taskIdx = new Map(s.tasks.map((t, i) => [t.id, i]));

  // 每人一行字串：'-' = 空，其餘 = base36 的工作索引
  const rows = s.people.map((p) =>
    sl.map((slot) => {
      const tid = s.assignments[key(p.id, slot)];
      const i = tid != null ? taskIdx.get(tid) : undefined;
      return i == null ? '-' : B36[i];
    }).join(''),
  );

  const compact = {
    t: s.title,
    d: s.date,
    s: s.start,
    e: s.end,
    // [名, 顏色(預設色留 null), 由, 到, flags]
    p: s.people.map((p, i) => [
      p.name,
      p.color === PERSON_PALETTE[i % PERSON_PALETTE.length] ? null : p.color,
      p.from || null,
      p.to || null,
      (p.noRunLimit ? 1 : 0) | (p.noBreak ? 2 : 0),
    ]),
    k: s.tasks.map((t, i) => [
      t.name,
      t.color === TASK_PALETTE[i % TASK_PALETTE.length] ? null : t.color,
      t.isBreak ? 1 : 0,
    ]),
    r: s.rules.map((r) => {
      if (r.type === 'cover') return ['c', taskIdx.get(r.taskId) ?? 0, r.from, r.to, r.min];
      if (r.type === 'maxRun') return ['r', r.hours];
      return ['s', r.from, r.to, r.hours];
    }),
    a: rows,
  };
  return SHARE_PREFIX + b64encodeUtf8(JSON.stringify(compact));
}

// j2：緊湊格式
function decodeShareV2(payload) {
  const obj = JSON.parse(b64decodeUtf8(payload));
  if (!obj || typeof obj !== 'object') throw new Error('格式錯誤');

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const hex = (v, fallback) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v)) ? String(v) : fallback);
  const time = (v, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : fallback);

  const people = (Array.isArray(obj.p) ? obj.p : [])
    .slice(0, 99)
    .map((row, i) => {
      if (!Array.isArray(row)) return null;
      const person = {
        id: `p${i}`,
        name: str(row[0], 60) || '人手',
        color: hex(row[1], PERSON_PALETTE[i % PERSON_PALETTE.length]),
      };
      const f = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(row[2])) ? String(row[2]) : '';
      const t = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(row[3])) ? String(row[3]) : '';
      if (f) person.from = f;
      if (t) person.to = t;
      const flags = Number(row[4]) || 0;
      if (flags & 1) person.noRunLimit = true;
      if (flags & 2) person.noBreak = true;
      return person;
    })
    .filter(Boolean);

  const tasks = (Array.isArray(obj.k) ? obj.k : [])
    .slice(0, 36)
    .map((row, i) => {
      if (!Array.isArray(row)) return null;
      return {
        id: `t${i}`,
        name: str(row[0], 60) || '工作',
        color: hex(row[1], TASK_PALETTE[i % TASK_PALETTE.length]),
        isBreak: Boolean(Number(row[2])),
      };
    })
    .filter(Boolean);

  const rules = (Array.isArray(obj.r) ? obj.r : [])
    .slice(0, 200)
    .map((row, i) => {
      if (!Array.isArray(row)) return null;
      const kind = row[0];
      const id = `r${i}`;
      if (kind === 'c') {
        const ti = Number(row[1]);
        if (!tasks[ti]) return null;
        return { id, type: 'cover', taskId: tasks[ti].id, from: time(row[2], '09:00'), to: time(row[3], '18:00'), min: Math.min(99, Math.max(1, Number(row[4]) || 1)) };
      }
      if (kind === 'r') return { id, type: 'maxRun', hours: Math.min(12, Math.max(1, Number(row[1]) || 4)) };
      if (kind === 's') return { id, type: 'rest', from: time(row[1], '11:00'), to: time(row[2], '14:00'), hours: Math.min(12, Math.max(1, Number(row[3]) || 1)) };
      return null;
    })
    .filter(Boolean);

  const start = time(obj.s, '09:00');
  const end = time(obj.e, '18:00');
  const sl = slotsFor(start, end);

  const assignments = {};
  const rows = Array.isArray(obj.a) ? obj.a : [];
  rows.forEach((line, pi) => {
    const person = people[pi];
    if (!person || typeof line !== 'string') return;
    for (let i = 0; i < sl.length && i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '-' || ch === '.') continue;
      const ti = B36.indexOf(ch);
      if (ti < 0 || !tasks[ti]) continue;
      assignments[`${person.id}|${sl[i]}`] = tasks[ti].id;
    }
  });

  return normalize({
    title: str(obj.t, 80) || '排班表',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(obj.d)) ? String(obj.d) : new Date().toISOString().slice(0, 10),
    start,
    end,
    people,
    tasks,
    rules,
    assignments,
  });
}

// 解出嚟嘅係不可信輸入：逐欄驗證，任何唔識嘅一律丟棄
function decodeShareV1(payload) {
  const raw = b64decodeUtf8(payload);
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('格式錯誤');

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const hex = (v) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v)) ? String(v) : '#5B8DEF');
  const time = (v, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : fallback);

  const people = (Array.isArray(obj.people) ? obj.people : [])
    .slice(0, 200)
    .filter((p) => p && typeof p === 'object' && p.id != null)
    .map((p) => {
      const person = { id: str(String(p.id), 40), name: str(p.name, 60) || '人手', color: hex(p.color) };
      const f = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.from)) ? String(p.from) : '';
      const t = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.to)) ? String(p.to) : '';
      if (f) person.from = f;
      if (t) person.to = t;
      if (p.noRunLimit === true) person.noRunLimit = true;
      if (p.noBreak === true) person.noBreak = true;
      return person;
    })
    .filter((p) => p.id);

  const tasks = (Array.isArray(obj.tasks) ? obj.tasks : [])
    .slice(0, 200)
    .filter((t) => t && typeof t === 'object' && t.id != null)
    .map((t) => ({ id: str(String(t.id), 40), name: str(t.name, 60) || '工作', color: hex(t.color), isBreak: Boolean(t.isBreak) }))
    .filter((t) => t.id);

  const taskIds = new Set(tasks.map((t) => t.id));
  const personIds = new Set(people.map((p) => p.id));

  const rules = (Array.isArray(obj.rules) ? obj.rules : [])
    .slice(0, 200)
    .filter((r) => r && typeof r === 'object' && ['cover', 'maxRun', 'rest'].includes(r.type))
    .map((r) => {
      const base = { id: str(String(r.id || uid('r')), 40), type: r.type };
      if (r.type === 'cover') {
        if (!taskIds.has(String(r.taskId))) return null;
        return { ...base, taskId: String(r.taskId), from: time(r.from, '09:00'), to: time(r.to, '18:00'), min: Math.min(99, Math.max(1, Number(r.min) || 1)) };
      }
      if (r.type === 'maxRun') return { ...base, hours: Math.min(12, Math.max(1, Number(r.hours) || 4)) };
      return { ...base, from: time(r.from, '11:00'), to: time(r.to, '14:00'), hours: Math.min(12, Math.max(1, Number(r.hours) || 1)) };
    })
    .filter(Boolean);

  const assignments = {};
  const src = obj.assignments && typeof obj.assignments === 'object' ? obj.assignments : {};
  let count = 0;
  for (const [k, v] of Object.entries(src)) {
    if (count > 20000) break;
    if (typeof k !== 'string' || k.length > 60) continue;
    const sep = k.indexOf('|');
    if (sep <= 0) continue;
    const pid = k.slice(0, sep);
    const slot = k.slice(sep + 1);
    if (!personIds.has(pid) || !taskIds.has(String(v))) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot)) continue;
    assignments[k] = String(v);
    count += 1;
  }

  return normalize({
    title: str(obj.title, 80) || '排班表',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(obj.date)) ? String(obj.date) : new Date().toISOString().slice(0, 10),
    start: time(obj.start, '09:00'),
    end: time(obj.end, '18:00'),
    people,
    tasks,
    rules,
    assignments,
  });
}

function shareUrl() {
  const base = location.origin + location.pathname;
  return `${base}#d=${encodeShare(state)}`;
}

/* ---------------- readonly banner ---------------- */
function showShareBanner(fromLink) {
  const box = $('banner');
  box.textContent = '';
  box.hidden = false;

  const text = document.createElement('div');
  text.className = 'banner-text';
  text.textContent = fromLink
    ? `你正在看分享的班表（唯讀）· ${state.people.length} 人 · ${Object.keys(state.assignments).length} 個排班`
    : '已複製成你的班表，可以隨意修改了';

  if (fromLink) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-primary';
    copy.textContent = '複製這份來改';
    copy.addEventListener('click', adoptShare);

    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'btn';
    hide.textContent = '收起';
    hide.addEventListener('click', () => { box.hidden = true; });

    box.append(text, copy, hide);
  } else {
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'btn';
    hide.textContent = '知道了';
    hide.addEventListener('click', () => { box.hidden = true; });
    box.append(text, hide);
  }
}

// 由分享連結進入改動模式：清 URL、寫入本機、解除唯讀
function adoptShare() {
  const copy = normalize(JSON.parse(JSON.stringify(state)));
  history.replaceState(null, '', location.pathname + location.search);
  readonly = false;
  document.body.classList.remove('readonly');
  state = copy;
  undoStack.length = 0;
  applyReadonlyUi(); // 解除所有 disabled
  syncInputs();
  renderAll();
  save(true); // local 模式寫 localStorage；server 模式寫回 state.json
  setSaveStatus('已複製，可以修改');
  showShareBanner(false);
}

function enterReadonly(shared) {
  readonly = true;
  document.body.classList.add('readonly');
  state = shared;
  undoStack.length = 0;
  syncInputs();
  renderAll();
  setSaveStatus('唯讀（分享連結）');
  showShareBanner(true);
  applyReadonlyUi();
}

function applyReadonlyUi() {
  for (const id of ['personForm', 'taskForm', 'ruleForm']) {
    const form = $(id);
    if (!form) continue;
    for (const el of form.querySelectorAll('input,select,button')) el.disabled = readonly;
  }
  for (const id of ['undoBtn', 'autofillBtn', 'clearBtn']) {
    const el = $(id);
    if (el) el.disabled = readonly;
  }  for (const id of ['titleInput', 'dateInput', 'startInput', 'endInput']) {
    const el = $(id);
    if (el) el.disabled = readonly;
  }
  updateMobileTaskButton();
}

/* ---------------- rules ---------------- */
const RULE_TYPES = {
  cover: '時段要有工作',
  maxRun: '連續工作上限',
  rest: '時段內要休息',
};

function ruleLabel(rule) {
  if (rule.type === 'cover') {
    const t = taskById(rule.taskId);
    return `${rule.from}–${rule.to} 「${t ? t.name : '已刪工作'}」至少 ${rule.min} 人`;
  }
  if (rule.type === 'maxRun') return `連續工作 ${rule.hours} 小時後要休息`;
  if (rule.type === 'rest') return `${rule.from}–${rule.to} 內至少 ${rule.hours} 小時休息`;
  return RULE_TYPES[rule.type] || '條件';
}

function ruleShort(rule) {
  if (rule.type === 'cover') {
    const t = taskById(rule.taskId);
    return `${rule.from}–${rule.to} ${t ? t.name : '?'}×${rule.min}`;
  }
  if (rule.type === 'maxRun') return `最多連做 ${rule.hours}h`;
  if (rule.type === 'rest') return `${rule.from}–${rule.to} 休息 ${rule.hours}h`;
  return '';
}

function pushTo(map, k, msg) {
  const arr = map.get(k);
  if (arr) {
    if (!arr.includes(msg)) arr.push(msg);
  } else {
    map.set(k, [msg]);
  }
}

function evaluateRules() {
  warnings = [];
  warnCells = new Map();
  warnPeople = new Map();
  warnSlots = new Map();
  const sl = slots();

  for (const rule of state.rules) {
    if (rule.type === 'cover') {
      if (!taskById(rule.taskId)) continue;
      const range = rangeSlots(rule.from, rule.to);
      for (const slot of range) {
        const have = countTask(slot, rule.taskId);
        if (have >= rule.min) continue;
        const t = taskById(rule.taskId);
        warnings.push({
          ruleId: rule.id,
          type: 'cover',
          slot,
          missing: rule.min - have,
          message: `${slot}–${addMin(slot, SLOT_MIN)}「${t.name}」要 ${rule.min} 人，現有 ${have} 人`,
        });
        pushTo(warnSlots, slot, `${t.name} 人手不足（${have}/${rule.min}）`);
      }
      continue;
    }

    for (const person of state.people) {
      const mine = sl.filter((s) => state.assignments[key(person.id, s)]);
      if (!mine.length) continue; // 這人今天沒排班，不檢查

      if (rule.type === 'maxRun' && !person.noRunLimit) {
        const limit = Math.max(1, Number(rule.hours) || 4) * (60 / SLOT_MIN);
        let run = [];
        const flush = () => {
          if (run.length > limit) {
            const over = run.slice(limit);
            warnings.push({
              ruleId: rule.id,
              type: 'maxRun',
              personId: person.id,
              slot: over[0],
              slots: over,
              message: `${person.name} 由 ${run[0]} 起連續工作超過 ${rule.hours} 小時，沒有休息`,
            });
            for (const s of over) {
              pushTo(warnCells, key(person.id, s), `連續工作超過 ${rule.hours} 小時`);
            }
            pushTo(warnPeople, person.id, `連做超過 ${rule.hours}h`);
          }
          run = [];
        };
        for (const s of sl) {
          if (isWorking(person.id, s)) run.push(s);
          else flush();
        }
        flush();
      }

      if (rule.type === 'rest' && !person.noBreak) {
        const range = rangeSlots(rule.from, rule.to);
        const needSlots = Math.max(1, Number(rule.hours) || 1) * (60 / SLOT_MIN);
        const rest = range.filter((s) => isRest(person.id, s));
        if (rest.length >= needSlots) continue;
        warnings.push({
          ruleId: rule.id,
          type: 'rest',
          personId: person.id,
          slot: range[0],
          message: `${person.name} 在 ${rule.from}–${rule.to} 只有 ${(rest.length * SLOT_MIN) / 60} 小時休息，要 ${rule.hours} 小時`,
        });
        pushTo(warnPeople, person.id, `${rule.from}–${rule.to} 休息不足`);
        // 視窗內正在工作的格子就是問題所在
        for (const s of range) {
          if (isWorking(person.id, s)) {
            pushTo(warnCells, key(person.id, s), `${rule.from}–${rule.to} 內要休息 ${rule.hours} 小時`);
          }
        }
      }
    }
  }
}

/* ---------------- 列表拖曳排序 ---------------- */
let listDrag = null; // { kind, id, startY }

function makeSortable(listEl, kind, onReorder) {
  listEl.addEventListener('dragstart', (e) => {
    if (readonly) return;
    const row = e.target.closest('[data-id]');
    if (!row) return;
    // 只在按住手柄時才算「排序」，否則交由工作卡本身處理（可拖到時間表）
    if (!e.target.closest('.grip')) return;
    listDrag = { kind, id: row.dataset.id };
    row.classList.add('sorting');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'sort', kind, id: row.dataset.id }));
    }
  });

  listEl.addEventListener('dragover', (e) => {
    if (!listDrag || listDrag.kind !== kind) return;
    const row = e.target.closest('[data-id]');
    if (!row || row.dataset.id === listDrag.id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    row.classList.toggle('drop-before', !after);
    row.classList.toggle('drop-after', after);
  });

  listEl.addEventListener('dragleave', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) row.classList.remove('drop-before', 'drop-after');
  });

  listEl.addEventListener('drop', (e) => {
    if (!listDrag || listDrag.kind !== kind) return;
    const row = e.target.closest('[data-id]');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const from = listDrag.id;
    const to = row.dataset.id;
    row.classList.remove('drop-before', 'drop-after');
    if (from !== to) onReorder(from, to, after);
    listDrag = null;
  });

  listEl.addEventListener('dragend', () => {
    listDrag = null;
    for (const el of listEl.querySelectorAll('[data-id]')) {
      el.classList.remove('sorting', 'drop-before', 'drop-after');
    }
  });
}

function reorderList(arr, fromId, toId, after) {
  const from = arr.findIndex((x) => x.id === fromId);
  const to = arr.findIndex((x) => x.id === toId);
  if (from < 0 || to < 0 || from === to) return false;
  const [item] = arr.splice(from, 1);
  const t2 = arr.findIndex((x) => x.id === toId);
  arr.splice(after ? t2 + 1 : t2, 0, item);
  return true;
}

/* ---------------- render: sidebar ---------------- */
function renderLists() {
  const peopleList = $('peopleList');
  peopleList.textContent = '';
  state.people.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'person-row';
    li.dataset.id = p.id;
    li.draggable = !readonly;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.title = '拖動排序';

    const sw = document.createElement('input');
    sw.type = 'color';
    sw.className = 'swatch';
    sw.value = p.color;
    sw.title = '改顏色';
    sw.addEventListener('input', () => {
      p.color = sw.value;
      renderAll();
      save();
    });

    const name = document.createElement('input');
    name.className = 'name-edit';
    name.value = p.name;
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v) {
        name.value = p.name;
        return;
      }
      commit(() => { p.name = v; });
    });

    const del = document.createElement('button');
    del.className = 'icon-btn del';
    del.type = 'button';
    del.title = '移除人手';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      commit(() => {
        state.people = state.people.filter((x) => x.id !== p.id);
        for (const k of Object.keys(state.assignments)) {
          if (k.startsWith(`${p.id}|`)) delete state.assignments[k];
        }
      });
    });

    // 可上班時間 + 例外
    const meta = document.createElement('div');
    meta.className = 'person-meta';

    const fromIn = document.createElement('input');
    fromIn.type = 'time';
    fromIn.className = 'mini-time';
    fromIn.value = p.from || '';
    fromIn.title = '可上班時間（由）';
    fromIn.addEventListener('change', () => {
      commit(() => {
        const v = fromIn.value;
        if (v) p.from = v;
        else delete p.from;
      });
    });

    const toIn = document.createElement('input');
    toIn.type = 'time';
    toIn.className = 'mini-time';
    toIn.value = p.to || '';
    toIn.title = '可上班時間（到）';
    toIn.addEventListener('change', () => {
      commit(() => {
        const v = toIn.value;
        if (v) p.to = v;
        else delete p.to;
      });
    });

    const ex = document.createElement('button');
    ex.type = 'button';
    ex.className = `chip-toggle${p.noRunLimit || p.noBreak ? ' on' : ''}`;
    ex.textContent = '免限';
    ex.title = '免連做上限／免休息（例如固定崗位的人）';
    ex.addEventListener('click', () => {
      commit(() => {
        const on = !(p.noRunLimit || p.noBreak);
        if (on) { p.noRunLimit = true; p.noBreak = true; }
        else { delete p.noRunLimit; delete p.noBreak; }
      });
    });

    li.append(grip, sw, name, del);
    meta.append(fromIn, toIn, ex);
    li.append(meta);
    peopleList.append(li);
  });
  $('peopleCount').textContent = `(${state.people.length})`;

  const taskList = $('taskList');
  taskList.textContent = '';
  state.tasks.forEach((t) => {
    const li = document.createElement('li');
    li.className = `task-row${t.isBreak ? ' is-break' : ''}`;
    li.style.setProperty('--task-color', t.color);
    li.draggable = true;
    li.dataset.id = t.id;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.title = '拖動排序（拖出右邊可放到時間表）';

    const sw = document.createElement('input');
    sw.type = 'color';
    sw.className = 'swatch';
    sw.value = t.color;
    sw.title = '改顏色';
    sw.addEventListener('input', () => {
      t.color = sw.value;
      renderAll();
      save();
    });

    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = t.name;
    name.title = '點選後可連續點格子填入；雙擊改名';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'name-edit task-name-edit';
      input.value = t.name;
      name.replaceWith(input);
      input.focus();
      input.select();
      const finish = (keep) => {
        if (!input.isConnected) return;
        const v = input.value.trim();
        if (keep && v && v !== t.name) commit(() => { t.name = v; });
        else renderLists();
      };
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(false);
        }
      });
    });

    const brk = document.createElement('button');
    brk.type = 'button';
    brk.className = `chip-toggle${t.isBreak ? ' on' : ''}`;
    brk.textContent = t.isBreak ? '休息' : '工作';
    brk.title = '切換這個是「工作」還是「休息」（休息不算工時，可用來滿足 Break／午餐條件）';
    brk.addEventListener('click', () => {
      commit(() => { t.isBreak = !t.isBreak; });
    });

    const del = document.createElement('button');
    del.className = 'icon-btn del';
    del.type = 'button';
    del.title = '移除工作';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      commit(() => {
        state.tasks = state.tasks.filter((x) => x.id !== t.id);
        for (const k of Object.keys(state.assignments)) {
          if (state.assignments[k] === t.id) delete state.assignments[k];
        }
        state.rules = state.rules.filter((r) => r.type !== 'cover' || r.taskId !== t.id);
      });
    });

    li.append(grip, sw, name, brk, del);

    li.addEventListener('dragstart', (e) => {
      setDragPayload(e, { type: 'task', taskId: t.id });
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragging = null;
    });
    li.addEventListener('click', (e) => {
      if (e.target.closest('input,button,.task-name-edit')) return;
      if (selectedTaskId === t.id) {
        clearSelectedTask();
        return;
      }
      selectTask(t.id);
      if (MOBILE.matches) closeSheet();
      setSaveStatus(`已選「${t.name}」— 點格子填入（Esc 取消）`);
    });

    taskList.append(li);
  });
  $('taskCount').textContent = `(${state.tasks.length})`;
  if (selectedTaskId) {
    const row = taskList.querySelector(`.task-row[data-id="${selectedTaskId}"]`);
    if (row) row.classList.add('selected');
    else clearSelectedTask();
  }

  renderRules();
}

function renderRules() {
  const list = $('ruleList');
  list.textContent = '';
  for (const rule of state.rules) {
    const li = document.createElement('li');
    li.className = `rule-row type-${rule.type}`;
    li.dataset.id = rule.id;
    li.draggable = !readonly;
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.title = '拖動排序';
    li.append(grip);
    const badge = document.createElement('span');
    badge.className = 'rule-badge';
    badge.textContent = RULE_TYPES[rule.type] || '條件';
    const text = document.createElement('span');
    text.className = 'rule-text';
    text.textContent = ruleLabel(rule);
    const del = document.createElement('button');
    del.className = 'icon-btn del';
    del.type = 'button';
    del.title = '移除條件';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      commit(() => {
        state.rules = state.rules.filter((r) => r.id !== rule.id);
      });
    });
    li.append(text, badge, del);
    list.append(li);
  }
  $('ruleCount').textContent = `(${state.rules.length})`;

  // 工作下拉選單
  const sel = $('ruleTask');
  const prev = sel.value;
  sel.textContent = '';
  for (const t of state.tasks) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    sel.append(o);
  }
  if (state.tasks.some((t) => t.id === prev)) sel.value = prev;

  // 排序手柄：列表重繪後重新綁定
  bindSortOnce();
}

let sortBound = false;
function bindSortOnce() {
  if (sortBound) return;
  sortBound = true;

  makeSortable($('peopleList'), 'people', (from, to, after) => {
    commit(() => { reorderList(state.people, from, to, after); });
  });
  makeSortable($('taskList'), 'tasks', (from, to, after) => {
    commit(() => { reorderList(state.tasks, from, to, after); });
  });
  makeSortable($('ruleList'), 'rules', (from, to, after) => {
    commit(() => { reorderList(state.rules, from, to, after); });
  });
}

/* ---------------- render: grid ---------------- */
function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  const sl = slots();
  grid.style.setProperty('--half-cols', sl.length);
  grid.classList.toggle('zoomed', zoomed);

  // 左上角（唔顯示文字）
  const corner = document.createElement('div');
  corner.className = 'cell h-name h-corner';
  corner.style.gridColumn = '1';
  corner.style.gridRow = '1';
  grid.append(corner);

  // 小時標題
  let col = 2;
  for (const h of hours()) {
    const el = document.createElement('div');
    el.className = 'cell h-hour';
    el.style.gridColumn = `${col} / span ${h.slots.length}`;
    el.style.gridRow = '1';
    el.dataset.hour = h.hour;

    const label = document.createElement('span');
    label.className = 'hh';
    const hh = document.createElement('span');
    hh.textContent = h.hour.slice(0, 2);
    const mm = document.createElement('span');
    mm.className = 'mm';
    mm.textContent = h.hour.slice(2);
    label.append(hh, mm);
    el.append(label);

    const tips = h.slots.flatMap((s) => warnSlots.get(s) || []);
    if (tips.length) {
      el.classList.add('has-warn');
      const badge = document.createElement('span');
      badge.className = 'warn-badge';
      badge.textContent = `⚠ ${tips.length}`;
      badge.title = [...new Set(tips)].join('\n');
      el.append(badge);
    }
    el.title = `${h.hour} 起一小時（虛線為半小時）`;
    el.addEventListener('click', () => startRuleForHour(h.hour));
    grid.append(el);
    col += h.slots.length;
  }

  if (!state.people.length) {
    const empty = document.createElement('div');
    empty.className = 'cell empty-note';
    empty.style.gridColumn = '1 / -1';
    empty.style.gridRow = '2';
    empty.textContent = '還沒有人手，先在左邊加人。';
    grid.append(empty);
    return;
  }

  state.people.forEach((person, pi) => {
    const rowIndex = pi + 2;
    const nameCell = document.createElement('div');
    nameCell.className = 'cell person-name';
    nameCell.style.gridColumn = '1';
    nameCell.style.gridRow = String(rowIndex);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = person.color;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = person.name;
    const load = document.createElement('span');
    load.className = 'load';
    const worked = sl.filter((s) => isWorking(person.id, s)).length;
    load.textContent = `${(worked * SLOT_MIN) / 60}h`;

    nameCell.append(dot, nm, load);

    const pm = warnPeople.get(person.id);
    if (pm) {
      nameCell.classList.add('has-warn');
      const badge = document.createElement('span');
      badge.className = 'warn-badge';
      badge.textContent = '⚠';
      badge.title = pm.join('\n');
      nameCell.append(badge);
    }
    if (selectedTaskId) nameCell.classList.add('fillable');
    nameCell.title = selectedTaskId ? '用已選的工作填滿這個人整天' : `${person.name}（Shift+點擊清空整天）`;
    nameCell.addEventListener('click', (e) => {
      if (readonly) return;
      if (e.shiftKey) {
        commit(() => {
          for (const s of sl) delete state.assignments[key(person.id, s)];
        });
        return;
      }
      if (!selectedTaskId) return;
      const id = selectedTaskId;
      commit(() => {
        for (const s of sl) if (isAvailable(person, s)) state.assignments[key(person.id, s)] = id;
      });
    });
    grid.append(nameCell);

    // 連續同工作 → 合併成一塊
    let i = 0;
    while (i < sl.length) {
      const slot = sl[i];
      const taskId = state.assignments[key(person.id, slot)];
      const colStart = 2 + i;
      if (!taskId) {
        grid.append(buildEmptyCell(person, slot, colStart, rowIndex));
        i += 1;
        continue;
      }
      let j = i;
      while (j + 1 < sl.length && state.assignments[key(person.id, sl[j + 1])] === taskId) j += 1;
      grid.append(buildBlock(person, sl.slice(i, j + 1), colStart, rowIndex));
      i = j + 1;
    }
  });

  requestAnimationFrame(fitBlockLabels);
}

// 全顯示模式：逐個區塊量度，縮字體直到名稱完整顯示
function fitBlockLabels() {
  if (zoomed) return;
  const labels = document.querySelectorAll('.grid:not(.zoomed) .block .block-label');
  for (const label of labels) {
    const block = label.parentElement;
    if (!block) continue;
    const maxW = block.clientWidth - 12; // padding
    const maxH = block.clientHeight - 10;
    if (maxW <= 0 || maxH <= 0) continue;
    let size = 12;
    label.style.fontSize = `${size}px`;
    // 逐步縮到 6px
    while (size > 6) {
      const fitsW = label.scrollWidth <= maxW + 1;
      const fitsH = label.scrollHeight <= maxH + 1;
      if (fitsW && fitsH) break;
      size -= 0.5;
      label.style.fontSize = `${size}px`;
    }
    // 名稱仍然過長 → 用兩行
    if (label.scrollWidth > maxW + 1) label.style.wordBreak = 'break-all';
  }
}

function buildEmptyCell(person, slot, colStart, rowIndex) {
  const el = document.createElement('div');
  const isHourEnd = toMin(slot) % 60 === 30;
  const available = isAvailable(person, slot);
  el.className = `cell sl empty${isHourEnd ? ' hour-end' : ' mid'}${available ? '' : ' offshift'}`;
  el.style.gridColumn = String(colStart);
  el.style.gridRow = String(rowIndex);
  el.dataset.person = person.id;
  el.dataset.slot = slot;

  if (!available) {
    el.title = `${person.name} 不在可上班時間（${person.from || '—'}–${person.to || '—'}）`;
    return el;
  }

  const msgs = warnSlots.get(slot);
  if (msgs) {
    el.classList.add('need');
    el.title = [...new Set(msgs)].join('\n');
  }
  const cellMsgs = warnCells.get(key(person.id, slot));
  if (cellMsgs) {
    el.classList.add('has-warn');
    el.title = [...new Set(cellMsgs)].join('\n');
    const badge = document.createElement('span');
    badge.className = 'warn-badge';
    badge.textContent = '⚠';
    badge.title = [...new Set(cellMsgs)].join('\n');
    el.append(badge);
  }
  if (selectedTaskId) el.classList.add('fillable');

  el.dataset.empty = '1';
  attachDrop(el, person.id, slot);
  return el;
}

function buildBlock(person, blockSlots, colStart, rowIndex) {
  const task = taskById(state.assignments[key(person.id, blockSlots[0])]);
  const el = document.createElement('div');
  el.className = `cell block${task.isBreak ? ' is-break' : ''}`;
  el.style.gridColumn = `${colStart} / span ${blockSlots.length}`;
  el.style.gridRow = String(rowIndex);
  el.style.background = task.isBreak ? '#eef2f8' : bgFor(task.color, 0.92);
  el.style.color = task.isBreak ? '#41506a' : textFor(task.color);
  // 時間表上的格不再可拖；搬移改用選取後「搬移」
  el.draggable = false;
  el.dataset.person = person.id;
  el.dataset.slot = blockSlots[0];
  el.dataset.span = String(blockSlots.length);
  el.dataset.slots = blockSlots.join(',');

  // 內部半小時分隔（虛線）
  for (let k = 1; k < blockSlots.length; k += 1) {
    const sep = document.createElement('i');
    sep.className = 'block-sep';
    sep.style.left = `${(k / blockSlots.length) * 100}%`;
    el.append(sep);
  }

  const label = document.createElement('span');
  label.className = 'block-label';
  label.textContent = task.name;
  label.title = task.name;
  el.append(label);

  const hrs = (blockSlots.length * SLOT_MIN) / 60;
  if (hrs >= 1.5) {
    const dur = document.createElement('span');
    dur.className = 'block-dur';
    dur.textContent = `${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h`;
    el.append(dur);
  }

  const cellWarn = [...new Set(blockSlots.flatMap((s) => warnCells.get(key(person.id, s)) || []))];
  if (cellWarn.length) {
    el.classList.add('has-warn');
    const firstIdx = blockSlots.findIndex((s) => warnCells.has(key(person.id, s)));
    const badge = document.createElement('span');
    badge.className = 'warn-badge';
    badge.textContent = '⚠';
    badge.title = cellWarn.join('\n');
    badge.style.left = `calc(${Math.max(0, firstIdx)} * (100% / ${blockSlots.length}) + 3px)`;
    el.append(badge);
  }

  el.title = `${task.name} ${blockSlots[0]}–${addMin(blockSlots[blockSlots.length - 1], SLOT_MIN)}（點選可改／拖選多格）`;

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (readonly) return;
    const slot = slotAtPoint(el, e.clientX, blockSlots);
    commit(() => {
      delete state.assignments[key(person.id, slot)];
    });
  });

  attachDrop(el, person.id, blockSlots[0]);
  return el;
}

// 依指標 x 座標算出落在合併區塊的第幾格
function slotAtPoint(el, clientX, blockSlots) {
  if (blockSlots.length <= 1) return blockSlots[0];
  const r = el.getBoundingClientRect();
  const ratio = (clientX - r.left) / r.width;
  const idx = Math.min(blockSlots.length - 1, Math.max(0, Math.floor(ratio * blockSlots.length)));
  return blockSlots[idx];
}

function attachDrop(el, personId, startSlot) {
  el.addEventListener('dragover', (e) => {
    if (readonly) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-ok');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-ok'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-ok');
    if (readonly) return;
    const payload = readDropPayload(e);
    dragging = null;
    if (!payload || !payload.taskId) return;
    // 落點：依指標位置決定實際格（合併區塊只影響 SPAN 那一格）
    const span = Number(el.dataset.span || 1);
    const blockSlots = span > 1 ? el.dataset.slots.split(',') : [startSlot];
    const slot = slotAtPoint(el, e.clientX, blockSlots);
    applyDrop(payload, personId, slot);
  });
}

/* ---------------- 格互動：點擊 / 長按 / 橫向拖選 ---------------- */
const gridSel = {
  active: false,
  personId: null,
  anchor: null, // slot string
  slots: [],
  dragging: false,
  startX: 0,
  startY: 0,
  pointerId: null,
  moved: false,
};

function clearGridSel() {
  gridSel.active = false;
  gridSel.personId = null;
  gridSel.anchor = null;
  gridSel.slots = [];
  gridSel.dragging = false;
  gridSel.moved = false;
  for (const el of document.querySelectorAll('.sel-range')) el.classList.remove('sel-range');
}

function paintGridSel() {
  for (const el of document.querySelectorAll('.sel-range')) el.classList.remove('sel-range');
  for (const el of document.querySelectorAll('.sel-overlay')) el.remove();
  if (!gridSel.active || !gridSel.slots.length) return;

  const selSet = new Set(gridSel.slots);
  const sl = slots();
  const cells = document.querySelectorAll(`[data-person="${gridSel.personId}"]`);

  for (const el of cells) {
    const elSlots = el.dataset.slots ? el.dataset.slots.split(',') : [el.dataset.slot];
    if (elSlots.length === 1) {
      if (selSet.has(elSlots[0])) el.classList.add('sel-range');
      continue;
    }
    // 合併區塊：逐格標記選中的部分
    const isBlock = el.classList.contains('block');
    elSlots.forEach((s, idx) => {
      if (!selSet.has(s)) return;
      if (!isBlock) { el.classList.add('sel-range'); return; }
      const ov = document.createElement('i');
      ov.className = 'sel-overlay';
      ov.style.left = `${(idx / elSlots.length) * 100}%`;
      ov.style.width = `${(1 / elSlots.length) * 100}%`;
      el.append(ov);
    });
    // 若整塊都被選 → 加整體外框
    if (elSlots.every((s) => selSet.has(s))) el.classList.add('sel-range');
  }
}

function extendGridSel(personId, slot) {
  if (!gridSel.active || gridSel.personId !== personId) return;
  const sl = slots();
  const a = sl.indexOf(gridSel.anchor);
  const b = sl.indexOf(slot);
  if (a < 0 || b < 0) return;
  const [from, to] = a <= b ? [a, b] : [b, a];
  gridSel.slots = sl.slice(from, to + 1);
  paintGridSel();
}

function cellFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cell = el.closest('[data-person][data-slot]');
  if (!cell) return null;
  if (cell.classList.contains('offshift')) return null;
  return cell;
}

function bindGridInteraction() {
  // 用格層的統一委派，處理 click / 拖選
  const grid = $('grid');

  grid.addEventListener('pointerdown', (e) => {
    if (readonly || e.button !== 0) return;
    if (e.target.closest('.person-name, .h-hour, .h-name')) return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (!cell) return;
    if (e.pointerType === 'mouse' && e.shiftKey) {
      // Shift = 擴充選取
      if (gridSel.active) {
        extendGridSel(cell.dataset.person, cell.dataset.slot);
        e.preventDefault();
      }
      return;
    }
    gridSel.pointerId = e.pointerId;
    gridSel.startX = e.clientX;
    gridSel.startY = e.clientY;
    gridSel.moved = false;
    gridSel.dragging = false;
    // 暫時只記下起點，真正開始選取要在 pointermove 超過門檻
    gridSel.pendingCell = cell;
  });

  grid.addEventListener('pointermove', (e) => {
    if (!gridSel.pendingCell || e.pointerId !== gridSel.pointerId) return;
    const dx = Math.abs(e.clientX - gridSel.startX);
    const dy = Math.abs(e.clientY - gridSel.startY);
    if (!gridSel.dragging && Math.max(dx, dy) < 6) return;
    if (!gridSel.dragging) {
      // 開始拖選：只限橫向（同一個人）
      gridSel.dragging = true;
      gridSel.active = true;
      gridSel.personId = gridSel.pendingCell.dataset.person;
      const firstSlot = slotAtPoint(gridSel.pendingCell, gridSel.startX,
        gridSel.pendingCell.dataset.slots ? gridSel.pendingCell.dataset.slots.split(',') : [gridSel.pendingCell.dataset.slot]);
      gridSel.anchor = firstSlot;
      gridSel.slots = [firstSlot];
      paintGridSel();
      document.body.classList.add('selecting');
    }
    gridSel.moved = true;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (cell && cell.dataset.person === gridSel.personId) {
      const slot = slotAtPoint(cell, e.clientX,
        cell.dataset.slots ? cell.dataset.slots.split(',') : [cell.dataset.slot]);
      extendGridSel(gridSel.personId, slot);
    }
    e.preventDefault();
  }, { passive: false });

  const finish = (e) => {
    if (!gridSel.pendingCell) return;
    const wasDragging = gridSel.dragging;
    const pending = gridSel.pendingCell;
    const selSlots = gridSel.slots.slice();
    const selPerson = gridSel.personId;
    gridSel.pendingCell = null;
    gridSel.pointerId = null;
    document.body.classList.remove('selecting');

    if (wasDragging) {
      // 拖選完成：保持選取，開選單
      if (selSlots.length) {
        paintGridSel();
        openPicker(pending, { personId: selPerson, slots: selSlots });
        paintGridSel(); // picker 開啟後再塗一次，避免時序問題
      }
      return;
    }
    // 單純點擊
    const cell = cellFromPoint(e.clientX, e.clientY) || pending;
    const slot = slotAtPoint(cell, e.clientX,
      cell.dataset.slots ? cell.dataset.slots.split(',') : [cell.dataset.slot]);
    handleCellClick(cell, cell.dataset.person, slot, e);
  };

  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', () => {
    gridSel.pendingCell = null;
    gridSel.pointerId = null;
    document.body.classList.remove('selecting');
  });

  // 點空白處取消選取
  document.addEventListener('pointerdown', (e) => {
    if (gridSel.active && !e.target.closest('#grid') && !e.target.closest('#picker')) clearGridSel();
  });

  // 長按：觸控長按 = 一次選取連續幾格（橫向）
  attachLongPressDelegate(grid);
}

function handleCellClick(cell, personId, slot, e) {
  if (readonly) return;
  if (moving) {
    placeMoving(personId, slot);
    return;
  }
  if (gridSel.active && gridSel.slots.length > 1) {
    openPicker(cell, { personId, slots: gridSel.slots.slice() });
    return;
  }
  if (selectedTaskId) {
    const id = selectedTaskId;
    commit(() => { state.assignments[key(personId, slot)] = id; });
    if (!e.shiftKey) clearSelectedTask();
    return;
  }
  const taskId = state.assignments[key(personId, slot)];
  openPicker(cell, {
    personId,
    slots: gridSel.active && gridSel.slots.length ? gridSel.slots.slice() : [slot],
    currentTaskId: taskId,
  });
}

// 長按（觸控）：開始選取，之後手指橫向拖動擴充
function attachLongPressDelegate(grid) {
  let timer = null;
  let person = null;
  let startSlot = null;

  grid.addEventListener('touchstart', (e) => {
    if (readonly || e.touches.length !== 1) return;
    const t = e.touches[0];
    const cell = cellFromPoint(t.clientX, t.clientY);
    if (!cell) return;
    startSlot = slotAtPoint(cell, t.clientX,
      cell.dataset.slots ? cell.dataset.slots.split(',') : [cell.dataset.slot]);
    person = cell.dataset.person;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (navigator.vibrate) navigator.vibrate(12);
      gridSel.active = true;
      gridSel.personId = person;
      gridSel.anchor = startSlot;
      gridSel.slots = [startSlot];
      paintGridSel();
      document.body.classList.add('selecting');
    }, 420);
  }, { passive: true });

  grid.addEventListener('touchmove', (e) => {
    if (!gridSel.active || !gridSel.personId) { clearTimeout(timer); return; }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const cell = cellFromPoint(t.clientX, t.clientY);
    if (!cell || cell.dataset.person !== gridSel.personId) return;
    const slot = slotAtPoint(cell, t.clientX,
      cell.dataset.slots ? cell.dataset.slots.split(',') : [cell.dataset.slot]);
    extendGridSel(gridSel.personId, slot);
  }, { passive: true });

  grid.addEventListener('touchend', () => {
    clearTimeout(timer);
    if (gridSel.active && gridSel.slots.length) {
      const el = document.querySelector(`[data-person="${gridSel.personId}"][data-slot="${gridSel.slots[0]}"]`);
      if (el) openPicker(el, { personId: gridSel.personId, slots: gridSel.slots.slice() });
    }
  });

  grid.addEventListener('touchcancel', () => {
    clearTimeout(timer);
    document.body.classList.remove('selecting');
  });
}

function applyDrop(payload, personId, startSlot) {
  const sl = slots();
  const idx = sl.indexOf(startSlot);
  if (idx < 0) return;
  const span = payload.type === 'move' && payload.slots ? payload.slots.length : 1;
  const targets = sl.slice(idx, idx + span);
  if (!targets.length) return;
  if (payload.type === 'move' && payload.personId === personId && payload.slots[0] === startSlot) return;

  // 放開時清掉選取
  clearGridSel();
  commit(() => {
    if (payload.type === 'move' && payload.slots) {
      for (const s of payload.slots) delete state.assignments[key(payload.personId, s)];
    }
    for (const s of targets) state.assignments[key(personId, s)] = payload.taskId;
  });
}

/* ---------------- 觸控搬移 ---------------- */
function placeMoving(personId, startSlot) {
  const sl = slots();
  const idx = sl.indexOf(startSlot);
  if (idx < 0) return;
  const taskId = state.assignments[key(moving.personId, moving.slots[0])];
  const targets = sl.slice(idx, idx + moving.slots.length);
  const src = { personId: moving.personId, slots: moving.slots.slice() };
  moving = null;
  document.body.classList.remove('moving');
  if (!taskId) return;
  commit(() => {
    for (const s of src.slots) delete state.assignments[key(src.personId, s)];
    for (const s of targets) state.assignments[key(personId, s)] = taskId;
  });
  setSaveStatus('已搬移');
}

/* ---------------- render: issues ---------------- */
function renderIssues() {
  const box = $('issues');
  box.textContent = '';
  if (!state.rules.length) return;

  const groups = new Map();
  for (const w of warnings) {
    const gk = `${w.ruleId}|${w.personId || ''}`;
    const g = groups.get(gk) || {
      ruleId: w.ruleId,
      personId: w.personId,
      type: w.type,
      count: 0,
      missing: 0,
      first: w.slot || '',
      messages: [],
    };
    g.count += 1;
    g.missing += w.missing || 0;
    if (!g.first && w.slot) g.first = w.slot;
    if (!g.messages.includes(w.message)) g.messages.push(w.message);
    groups.set(gk, g);
  }

  for (const g of groups.values()) {
    const rule = state.rules.find((r) => r.id === g.ruleId);
    const person = g.personId ? personById(g.personId) : null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'issue';
    const who = person ? `${person.name}：` : '';
    const extra = g.count > 1 ? `（${g.count} 個時段）` : '';
    b.textContent = `⚠ ${who}${ruleShort(rule)} ${g.missing ? `缺 ${g.missing} 人次` : ''}${extra}`.trim();
    b.title = g.messages.join('\n');
    b.addEventListener('click', () => {
      if (g.personId && g.first) {
        const el = document.querySelector(`.person-name`);
        if (el) el.scrollIntoView({ block: 'nearest' });
      }
      const target = g.first ? document.querySelector(`.h-hour[data-hour="${hourOf(g.first)}"]`) : null;
      if (target) target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
    box.append(b);
  }
}

function renderAll() {
  evaluateRules();
  renderLists();
  renderGrid();
  renderIssues();
  $('undoBtn').disabled = undoStack.length === 0;
  requestAnimationFrame(refreshScrollShadows);
}

/* ---------------- picker popup ---------------- */
let pickerState = null;

function openPicker(anchor, ctx) {
  if (readonly) {
    setSaveStatus('唯讀模式：按上方「複製這份來改」才可以修改');
    return;
  }
  const picker = $('picker');
  picker.textContent = '';
  pickerState = ctx;

  const person = personById(ctx.personId);
  const from = ctx.slots[0];
  const to = addMin(ctx.slots[ctx.slots.length - 1], SLOT_MIN);
  const n = ctx.slots.length;

  const title = document.createElement('div');
  title.className = 'pk-title';
  title.textContent = n > 1
    ? `${person ? person.name : ''} · ${from}–${to}（選了 ${n} 格）`
    : `${person ? person.name : ''} · ${from}–${to}`;
  picker.append(title);

  if (!state.tasks.length) {
    const d = document.createElement('div');
    d.className = 'pk-title';
    d.textContent = '先在左邊加工作';
    picker.append(d);
  }

  for (const t of state.tasks) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pk-item${t.isBreak ? ' is-break' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = t.isBreak ? '#9aa7bd' : t.color;
    const lbl = document.createElement('span');
    lbl.textContent = t.name;
    b.append(dot, lbl);
    if (t.isBreak) {
      const tag = document.createElement('span');
      tag.className = 'pk-tag';
      tag.textContent = '休息';
      b.append(tag);
    }
    b.addEventListener('click', () => {
      closePicker();
      clearGridSel();
      commit(() => {
        for (const s of ctx.slots) state.assignments[key(ctx.personId, s)] = t.id;
      });
    });
    picker.append(b);
  }

  if (ctx.slots.some((s) => state.assignments[key(ctx.personId, s)])) {
    const sep = document.createElement('div');
    sep.className = 'pk-sep';
    picker.append(sep);

    // 手機沒有拖放，用「搬移」模式取代
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'pk-item';
    move.textContent = `搬移這 ${ctx.slots.length > 1 ? `${(ctx.slots.length * SLOT_MIN) / 60} 小時` : '格'}…`;
    move.addEventListener('click', () => {
      closePicker();
      clearGridSel();
      moving = { personId: ctx.personId, slots: ctx.slots.slice() };
      document.body.classList.add('moving');
      setSaveStatus('搬移模式：點目標格放下（Esc 取消）');
    });

    const clr = document.createElement('button');
    clr.type = 'button';
    clr.className = 'pk-item danger';
    clr.textContent = ctx.slots.length > 1 ? `清空這 ${(ctx.slots.length * SLOT_MIN) / 60} 小時` : '清空這一格';
    clr.addEventListener('click', () => {
      closePicker();
      clearGridSel();
      commit(() => {
        for (const s of ctx.slots) delete state.assignments[key(ctx.personId, s)];
      });
    });
    if (MOBILE.matches) picker.append(move);
    picker.append(clr);
  }

  picker.hidden = false;
  if (MOBILE.matches) {
    picker.style.left = '';
    picker.style.top = '';
    picker.classList.add('mobile');
  } else {
    picker.classList.remove('mobile');
    const r = anchor.getBoundingClientRect();
    const pr = picker.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
    picker.style.left = `${Math.max(8, left)}px`;
    picker.style.top = `${top}px`;
  }
}

function closePicker() {
  $('picker').hidden = true;
  pickerState = null;
}

document.addEventListener('mousedown', (e) => {
  if (!pickerState) return;
  if (e.target.closest('#picker')) return;
  if (e.target.closest('.block, .empty')) return;
  closePicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (moving) {
      moving = null;
      document.body.classList.remove('moving');
      setSaveStatus('已取消搬移');
      return;
    }
    if (openSheetName) {
      closeSheet();
      return;
    }
    closePicker();
    clearSelectedTask();
  }
});

/* ---------------- drag payload ---------------- */
function setDragPayload(e, payload) {
  dragging = payload;
  try {
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
  } catch {
    /* 某些環境不支援 dataTransfer，退回 dragging 變數 */
  }
  if (e.dataTransfer) e.dataTransfer.effectAllowed = payload.type === 'move' ? 'move' : 'copy';
}

function readDropPayload(e) {
  try {
    const raw = e.dataTransfer?.getData('text/plain');
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return dragging;
}

function clearSelectedTask() {
  selectedTaskId = null;
  document.body.classList.remove('picking-task');
  document.querySelectorAll('.task-row.selected').forEach((el) => el.classList.remove('selected'));
  updateMobileTaskButton();
}

function selectTask(id) {
  if (readonly) return;
  clearSelectedTask();
  selectedTaskId = id;
  document.body.classList.add('picking-task');
  const row = document.querySelector(`.task-row[data-id="${id}"]`);
  if (row) row.classList.add('selected');
  updateMobileTaskButton();
  renderGrid();
}

function updateMobileTaskButton() {
  const btn = $('mbTask');
  if (!btn) return;
  if (readonly) {
    btn.textContent = '唯讀 — 按上方「複製這份來改」';
    btn.classList.remove('active');
    btn.style.borderColor = '';
    return;
  }
  const t = selectedTaskId ? taskById(selectedTaskId) : null;
  btn.textContent = t ? `${t.name} — 點格子填入（再按取消）` : '選工作開始排';
  btn.classList.toggle('active', Boolean(t));
  btn.style.borderColor = t ? t.color : '';
}

/* ---------------- mobile sheets ---------------- */
const MOBILE = window.matchMedia('(max-width: 760px)');
let openSheetName = null;

function openSheet(name) {
  openSheetName = name;
  document.body.dataset.sheet = name;
  document.body.classList.add('sheet-open');
  for (const b of document.querySelectorAll('.mb-btn')) {
    b.classList.toggle('on', b.dataset.sheet === name);
  }
  const titles = { people: '人手', tasks: '工作', rules: '條件' };
  const t = $('sheetTitle');
  if (t) t.textContent = titles[name] || '';
  const card = document.querySelector(`.card[data-section="${name}"]`);
  if (card) card.scrollTop = 0;
}

function closeSheet() {
  openSheetName = null;
  document.body.classList.remove('sheet-open');
  for (const b of document.querySelectorAll('.mb-btn')) b.classList.remove('on');
  closePicker();
}

function toggleSheet(name) {
  if (openSheetName === name) closeSheet();
  else openSheet(name);
}

function bindMobile() {
  for (const b of document.querySelectorAll('.mb-btn')) {
    b.addEventListener('click', () => toggleSheet(b.dataset.sheet));
  }
  $('scrim').addEventListener('click', closeSheet);
  $('sheetClose').addEventListener('click', closeSheet);
  $('mbTask').addEventListener('click', () => {
    if (selectedTaskId) {
      clearSelectedTask();
      setSaveStatus('已取消選取');
      return;
    }
    if (!state.tasks.length) {
      toggleSheet('tasks');
      return;
    }
    toggleSheet('tasks');
  });
  updateMobileTaskButton();
}

/* ---------------- rule form ---------------- */
function startRuleForHour(hour) {
  if (readonly) return;
  const type = $('ruleType');
  if (!state.tasks.length) {
    setSaveStatus('先加工作，才能設「要有人做」的條件');
    return;
  }
  type.value = 'cover';
  syncRuleFields();
  const form = $('ruleForm');
  form.elements.from.value = hour;
  form.elements.to.value = addMin(hour, 60);
  $('ruleTask').focus();
  if (MOBILE.matches) {
    openSheet('rules');
  } else {
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  setSaveStatus(`已預填 ${hour}–${addMin(hour, 60)}，選工作再按「加條件」`);
}

function syncRuleFields() {
  const type = $('ruleType').value;
  for (const box of document.querySelectorAll('.rule-fields')) {
    box.hidden = box.dataset.type !== type;
  }
}

function submitRule(e) {
  e.preventDefault();
  const form = e.target;
  const type = form.elements.type.value;

  if (type === 'cover') {
    const taskId = $('ruleTask').value;
    if (!taskId) {
      setSaveStatus('先選一個工作');
      return;
    }
    const from = form.elements.from.value || '09:00';
    const to = form.elements.to.value || addMin(from, 60);
    const min = Math.max(1, Number(form.elements.min.value) || 1);
    commit(() => {
      state.rules.push({ id: uid('r'), type: 'cover', taskId, from, to, min });
    });
  } else if (type === 'maxRun') {
    const hours = Math.max(1, Number(form.elements.hours.value) || 4);
    commit(() => {
      state.rules.push({ id: uid('r'), type: 'maxRun', hours });
    });
  } else if (type === 'rest') {
    const from = form.elements.rfrom.value || '11:00';
    const to = form.elements.rto.value || '14:00';
    const hours = Math.max(1, Number(form.elements.rneed.value) || 1);
    commit(() => {
      state.rules.push({ id: uid('r'), type: 'rest', from, to, hours });
    });
  }
}

/* ---------------- autofill ---------------- */
function autofill() {
  const sl = slots();
  const load = new Map(state.people.map((p) => [p.id, sl.filter((s) => state.assignments[key(p.id, s)]).length]));
  const planned = new Map(); // key -> taskId
  const plannedCount = (slot, taskId) => {
    let n = 0;
    for (const [k, v] of planned) if (v === taskId && k.endsWith(`|${slot}`)) n += 1;
    return n;
  };

  for (const rule of state.rules) {
    if (rule.type !== 'cover') continue;
    if (!taskById(rule.taskId)) continue;
    const range = rangeSlots(rule.from, rule.to);
    for (const slot of range) {
      let have = countTask(slot, rule.taskId) + plannedCount(slot, rule.taskId);
      if (have >= rule.min) continue;

      // 上一格（或下一格）已在做同一個工作的人，優先續做，避免碎片
      const prev = sl[sl.indexOf(slot) - 1];
      const next = sl[sl.indexOf(slot) + 1];
      const continuity = (pid) =>
        (prev && (state.assignments[key(pid, prev)] === rule.taskId || planned.get(key(pid, prev)) === rule.taskId) ? 1 : 0) +
        (next && (state.assignments[key(pid, next)] === rule.taskId || planned.get(key(pid, next)) === rule.taskId) ? 1 : 0);

      while (have < rule.min) {
        const cand = state.people
          .filter((p) => isAvailable(p, slot) && !state.assignments[key(p.id, slot)] && !planned.has(key(p.id, slot)))
          .sort((a, b) => continuity(b.id) - continuity(a.id) || load.get(a.id) - load.get(b.id));
        if (!cand.length) break;
        const pick = cand[0];
        planned.set(key(pick.id, slot), rule.taskId);
        load.set(pick.id, load.get(pick.id) + 1);
        have += 1;
      }
    }
  }

  if (!planned.size) {
    setSaveStatus('沒有需要補的缺');
    return;
  }
  commit(() => {
    for (const [k, v] of planned) state.assignments[k] = v;
  });
  setSaveStatus(`已自動補 ${planned.size} 格`);
}

/* ---------------- csv ---------------- */
function exportCsv() {
  const sl = slots();
  const rows = [['時間', ...state.people.map((p) => p.name), '條件']];
  for (const slot of sl) {
    const line = [slot];
    for (const p of state.people) {
      const t = assignedTask(p.id, slot);
      line.push(t ? t.name : '');
    }
    line.push(state.rules.map(ruleShort).join(' / '));
    rows.push(line);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.title || '排班表'}_${state.date}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- share ---------------- */
async function copyShareLink() {
  const url = shareUrl();
  if (url.length > SHARE_LIMIT) {
    setSaveStatus(`連結太長（${url.length} 字元），請減少人手或工作`);
    return;
  }
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    // 沒有 clipboard 權限（例如 http 非 localhost）→ 退回 textarea
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    ta.remove();
  }
  setSaveStatus(copied ? `已複製分享連結（${url.length} 字元）` : `連結 ${url.length} 字元，請手動複製`);

  if (!copied) {
    const box = $('banner');
    box.textContent = '';
    box.hidden = false;
    const text = document.createElement('div');
    text.className = 'banner-text';
    text.textContent = '未能自動複製，請長按或全選下面這條連結：';
    const input = document.createElement('input');
    input.className = 'share-input';
    input.readOnly = true;
    input.value = url;
    input.addEventListener('focus', () => input.select());
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'btn';
    hide.textContent = '收起';
    hide.addEventListener('click', () => { box.hidden = true; });
    box.append(text, input, hide);
    input.focus();
    return;
  }
  const box = $('banner');
  box.textContent = '';
  box.hidden = false;
  const text = document.createElement('div');
  text.className = 'banner-text';
  text.textContent = '分享連結已複製（唯讀快照，之後改動不會同步）';
  const open = document.createElement('a');
  open.className = 'btn';
  open.href = url;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = '預覽';
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'btn';
  hide.textContent = '收起';
  hide.addEventListener('click', () => { box.hidden = true; });
  box.append(text, open, hide);
}

function readShareFromHash() {
  const hash = location.hash || '';
  const m = hash.match(/^#d=(.+)$/);
  if (!m) return null;
  const payload = m[1];
  try {
    if (payload.startsWith(SHARE_PREFIX)) {
      return decodeShareV2(payload.slice(SHARE_PREFIX.length));
    }
    if (payload.startsWith(SHARE_PREFIX_V1)) {
      return decodeShareV1(payload.slice(SHARE_PREFIX_V1.length));
    }
    return null;
  } catch (err) {
    console.warn('分享連結解析失敗', err);
    return { error: true };
  }
}

function showShareError() {
  const box = $('banner');
  box.textContent = '';
  box.hidden = false;
  const text = document.createElement('div');
  text.className = 'banner-text';
  text.textContent = '這個分享連結已損壞或格式不支援';
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'btn';
  hide.textContent = '用我自己的班表';
  hide.addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    state = readLocal();
    syncInputs();
    renderAll();
    box.hidden = true;
  });
  box.append(text, hide);
}

/* ---------------- 縮放切換 ---------------- */
function toggleZoom() {
  zoomed = !zoomed;
  const btn = $('fitBtn');
  btn.textContent = zoomed ? '全顯示' : '放大';
  btn.classList.toggle('on', zoomed);
  renderGrid();
  requestAnimationFrame(refreshScrollShadows);
}

/* ---------------- 滾動陰影 ---------------- */
function updateScrollShadow(el) {
  if (!el) return;
  const canX = el.scrollWidth > el.clientWidth + 1;
  const canY = el.scrollHeight > el.clientHeight + 1;
  const left = el.scrollLeft > 1;
  const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
  const top = el.scrollTop > 1;
  const bottom = el.scrollTop < el.scrollHeight - el.clientHeight - 1;

  const parts = [];
  if (canX && left) parts.push('inset 16px 0 14px -14px rgba(16,24,40,0.32)');
  if (canX && right) parts.push('inset -16px 0 14px -14px rgba(16,24,40,0.32)');
  if (canY && top) parts.push('inset 0 16px 14px -14px rgba(16,24,40,0.28)');
  if (canY && bottom) parts.push('inset 0 -16px 14px -14px rgba(16,24,40,0.28)');
  el.style.boxShadow = parts.join(', ');
}

function watchScrollables() {
  const targets = [document.querySelector('.board'), document.querySelector('.panel'), document.querySelector('.issues')];
  for (const el of targets) {
    if (!el || el.dataset.shadowWatched) continue;
    el.dataset.shadowWatched = '1';
    el.classList.add('scroll-shadow');
    el.addEventListener('scroll', () => updateScrollShadow(el), { passive: true });
    const ro = new ResizeObserver(() => updateScrollShadow(el));
    ro.observe(el);
    updateScrollShadow(el);
  }
}

function refreshScrollShadows() {
  watchScrollables();
  for (const el of document.querySelectorAll('[data-shadow-watched]')) updateScrollShadow(el);
}

/* ---------------- inputs / bind ---------------- */
function syncInputs() {
  $('titleInput').value = state.title;
  $('dateInput').value = state.date;
  $('startInput').value = state.start;
  $('endInput').value = state.end;
  $('titleInput').style.width = `${Math.max(6, state.title.length + 2)}ch`;
}

function bind() {
  const title = $('titleInput');
  title.addEventListener('input', () => {
    state.title = title.value;
    document.title = `${state.title} — 排班`;
    title.style.width = `${Math.max(6, title.value.length + 2)}ch`;
    save();
  });

  $('dateInput').addEventListener('change', (e) => {
    commit(() => { state.date = e.target.value || state.date; });
  });
  $('startInput').addEventListener('change', (e) => {
    const v = e.target.value || state.start;
    commit(() => {
      state.start = fmt(Math.floor(toMin(v) / 60) * 60);
    });
  });
  $('endInput').addEventListener('change', (e) => {
    const v = e.target.value || state.end;
    commit(() => {
      state.end = fmt(Math.ceil(toMin(v) / 60) * 60);
    });
  });

  $('shareBtn').addEventListener('click', copyShareLink);

  $('personForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    const name = input.value.trim();
    if (!name) return;
    commit(() => {
      state.people.push({ id: uid('p'), name, color: PERSON_PALETTE[state.people.length % PERSON_PALETTE.length] });
    });
    input.value = '';
    input.focus();
  });

  $('taskForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    const name = input.value.trim();
    if (!name) return;
    commit(() => {
      state.tasks.push({
        id: uid('t'),
        name,
        color: TASK_PALETTE[state.tasks.length % TASK_PALETTE.length],
        isBreak: false,
      });
    });
    input.value = '';
    input.focus();
  });

  $('ruleType').addEventListener('change', syncRuleFields);
  $('ruleForm').addEventListener('submit', submitRule);

  $('undoBtn').addEventListener('click', undo);
  $('autofillBtn').addEventListener('click', autofill);
  $('fitBtn').addEventListener('click', toggleZoom);
  $('csvBtn').addEventListener('click', exportCsv);
  $('clearBtn').addEventListener('click', () => {
    if (!Object.keys(state.assignments).length) return;
    if (!confirm('清空所有格子（保留人手、工作與條件）？')) return;
    commit(() => { state.assignments = {}; });
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      e.preventDefault();
      undo();
    }
  });
}

/* ---------------- boot ---------------- */
(async function boot() {
  await load();
  const shared = readShareFromHash();
  syncInputs();
  bind();
  bindMobile();
  bindGridInteraction();
  syncRuleFields();

  if (shared && shared.error) {
    showShareError();
    renderAll();
    return;
  }
  if (shared) {
    enterReadonly(shared);
    return;
  }

  if (!localStorage.getItem(LS_KEY)) localStorage.setItem(LS_KEY, JSON.stringify(state));  renderAll();
  setSaveStatus(MODE === 'server' ? '已載入（本機伺服器）' : '已載入（存在這個瀏覽器）');
})();
