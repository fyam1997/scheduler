// 最終排更：SIA 固定 WD 08:00–13:30，不需休息
import { writeFileSync } from 'node:fs';

const N = 16;
const SL = (i) => `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
const PEOPLE = [
  { id: 'm1', name: '男1', male: true },
  { id: 'm2', name: '男2', male: true },
  { id: 'm3', name: '男3', male: true },
  { id: 'm4', name: '男4', male: true, from: '11:00' },
  { id: 'f1', name: '女1', male: false },
  { id: 'f2', name: '女2', male: false },
];
const P = 6, F1 = 4, F2 = 5;
const SIA_END = 11; // 08:00–13:30 = 12 格

const rng = (s0) => { let s = s0 >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

function solve(seed = 1, nodeLimit = 400000) {
  const rnd = rng(seed);
  const fromOf = (p) => (PEOPLE[p].from ? 6 : 0);

  const postsAt = (i) => {
    const am = i < 6, pm = i >= 12;
    const out = [];
    if (am || pm) out.push('WBG');
    out.push('WA', 'EA');
    if (pm) out.push('WD');
    return out;
  };
  const forced = (i, sc) => {
    const o = {};
    if (i <= 1) o[F1] = 'SD';
    else if (i === 2) o[F1] = 'WA';
    if (i === sc) o[F2] = 'SC';
    return o;
  };

  const grid = Array.from({ length: N }, () => new Array(P).fill(null));
  const run = new Array(P).fill(0);
  const lunch = new Array(P).fill(-1);
  let nodes = 0, out = null;

  const go = (i, sc) => {
    if (out) return true;
    if (++nodes > nodeLimit) return false;
    if (i === N) {
      if (lunch.some((x) => x < 0)) return false;
      out = { sc, grid: grid.map((r) => r.slice()) };
      return true;
    }
    const fix = forced(i, sc);
    const fixP = new Set(Object.keys(fix).map(Number));
    const posts = postsAt(i).filter((t) => !Object.values(fix).includes(t));
    const onLunch = (p) => lunch[p] >= 0 && (i === lunch[p] || i === lunch[p] + 1);
    const pool = [];
    for (let p = 0; p < P; p++) if (!fixP.has(p) && !onLunch(p) && i >= fromOf(p)) pool.push(p);
    if (pool.length < posts.length) return false;

    const subs = [];
    const pick = (st, acc) => { if (acc.length === posts.length) { subs.push(acc.slice()); return; } for (let k = st; k < pool.length; k++) { acc.push(pool[k]); pick(k + 1, acc); acc.pop(); } };
    pick(0, []);

    // 固定任務也計入 run
    const okS = subs.filter((s) => {
      for (const p of s) if (run[p] + 1 > 4) return false;
      for (const p of fixP) if (run[p] + 1 > 4) return false;
      return true;
    });
    for (let k = okS.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [okS[k], okS[j]] = [okS[j], okS[k]]; }
    okS.sort((a, b) => a.reduce((s, p) => s + run[p], 0) - b.reduce((s, p) => s + run[p], 0));

    for (const sub of okS) {
      if (posts.includes('WBG') && !sub.some((p) => PEOPLE[p].male)) continue;
      const perms = []; const used = new Set();
      const pm = (k, acc) => {
        if (k === posts.length) { perms.push(acc.slice()); return; }
        for (const p of sub) {
          if (used.has(p)) continue;
          if (posts[k] === 'WBG' && !PEOPLE[p].male) continue;
          used.add(p); acc.push(p); pm(k + 1, acc); acc.pop(); used.delete(p);
        }
      };
      pm(0, []); if (!perms.length) continue;

      for (const pr of perms) {
        const sR = grid[i].slice(), sRun = run.slice(), sL = lunch.slice();
        for (const p of fixP) grid[i][p] = fix[String(p)];
        for (let k = 0; k < posts.length; k++) grid[i][pr[k]] = posts[k];
        const working = new Set([...fixP, ...pr]);
        for (let p = 0; p < P; p++) run[p] = working.has(p) ? run[p] + 1 : 0;
        for (let p = 0; p < P; p++) if (onLunch(p) && !grid[i][p]) grid[i][p] = 'L';

        const resters = [];
        for (let p = 0; p < P; p++) if (!grid[i][p] && !fixP.has(p) && i >= fromOf(p)) resters.push(p);
        for (let k = resters.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [resters[k], resters[j]] = [resters[j], resters[k]]; }

        const fill = (ri) => {
          if (out) return true;
          if (ri === resters.length) {
            if (i >= 10) for (let p = 0; p < P; p++) if (i >= fromOf(p) && lunch[p] < 0) return false;
            return go(i + 1, sc);
          }
          const p = resters[ri];
          if (lunch[p] < 0 && i >= 6 && i <= 10) {
            lunch[p] = i; grid[i][p] = 'L';
            if (fill(ri + 1)) return true;
            grid[i][p] = null; lunch[p] = -1;
          }
          grid[i][p] = 'B';
          if (fill(ri + 1)) return true;
          grid[i][p] = null;
          return false;
        };
        if (fill(0)) return true;
        grid[i] = sR;
        for (let p = 0; p < P; p++) { run[p] = sRun[p]; lunch[p] = sL[p]; }
      }
    }
    return false;
  };

  for (const sc of [3, 4, 5]) {
    run.fill(0); lunch.fill(-1);
    for (let i = 0; i < N; i++) grid[i].fill(null);
    if (go(0, sc)) break;
  }
  return { ok: Boolean(out), grid: out?.grid ?? null, sc: out?.sc ?? null, nodes };
}

function verify(sol) {
  if (!sol.ok) return ['無解'];
  const { grid, sc } = sol;
  const e = [];
  for (let i = 0; i < N; i++) {
    const c = {};
    for (let p = 0; p < P; p++) { const t = grid[i][p]; if (t && t !== 'L' && t !== 'B') c[t] = (c[t] || 0) + 1; }
    if (i <= SIA_END) c.WD = (c.WD || 0) + 1; // SIA
    for (const [t, n] of Object.entries(c)) if (n > 1) e.push(`${SL(i)} ${t}×${n}`);
    if ((c.WA || 0) !== 1) e.push(`${SL(i)} WA=${c.WA || 0}`);
    if ((c.EA || 0) !== 1) e.push(`${SL(i)} EA=${c.EA || 0}`);
    const am = i < 6, pm = i >= 12;
    if (am || pm) {
      if ((c.WBG || 0) !== 1) e.push(`${SL(i)} WBG=${c.WBG || 0}`);
      if ((c.WD || 0) !== 1) e.push(`${SL(i)} WD=${c.WD || 0}`);
    } else if ((c.WBG || 0) > 0) e.push(`${SL(i)} 11-14 有 WBG`);
    for (let p = 0; p < P; p++) {
      const t = grid[i][p];
      if (!t) continue;
      if (t === 'WBG' && !PEOPLE[p].male) e.push(`${SL(i)} 女做 WBG`);
      if (PEOPLE[p].from === '11:00' && i < 6) e.push(`${SL(i)} 男4 未到`);
    }
  }
  for (let p = 0; p < P; p++) {
    let r = 0, mx = 0;
    for (let i = 0; i < N; i++) {
      const t = grid[i][p];
      r = t && t !== 'L' && t !== 'B' ? r + 1 : 0;
      mx = Math.max(mx, r);
    }
    if (mx > 4) e.push(`${PEOPLE[p].name} 連做 ${mx}`);
    const ls = [];
    for (let i = 0; i < N; i++) if (grid[i][p] === 'L') ls.push(i);
    if (ls.length !== 2 || ls[1] - ls[0] !== 1) e.push(`${PEOPLE[p].name} 午餐${ls.length}格`);
    else if (ls[0] < 6 || ls[1] > 11) e.push(`${PEOPLE[p].name} 午餐不在 11-14`);
  }
  const sd = [];
  for (let i = 0; i < N; i++) if (grid[i][F1] === 'SD') sd.push(i);
  if (sd.join() !== '0,1') e.push('SD 錯位');
  if (grid[2][F1] !== 'WA') e.push('女1 09:00 非 WA');
  const scAt = [];
  for (let i = 0; i < N; i++) if (grid[i][F2] === 'SC') scAt.push(i);
  if (scAt.length !== 1 || ![3, 4, 5].includes(scAt[0])) e.push('SC 錯位');
  return e;
}

let hit = null, total = 0;
for (let s = 1; s <= 60 && !hit; s++) {
  const r = solve(s, 200000);
  total += r.nodes;
  if (!r.ok) continue;
  if (!verify(r).length) hit = r;
}
if (!hit) { console.log('✗ 無解'); process.exit(1); }
console.log(`✓ 可行 nodes=${total}  SC @ ${SL(hit.sc)}\n`);

// 打印
const head = '     ' + Array.from({ length: N }, (_, i) => SL(i).padEnd(6)).join('');
console.log(head);
const assignments = {};
for (let p = 0; p < P; p++) {
  const row = [];
  let w = 0, mx = 0, cur = 0;
  for (let i = 0; i < N; i++) {
    const t = hit.grid[i][p];
    row.push(t || '·');
    if (t) assignments[`${PEOPLE[p].id}|${SL(i)}`] = t;
    if (t && t !== 'L' && t !== 'B') { w++; cur++; mx = Math.max(mx, cur); } else cur = 0;
  }
  console.log(PEOPLE[p].id.padEnd(4) + ' ' + row.map((x) => x.padEnd(6)).join('') + ` ${w / 2}h 連${mx}`);
}
const siaRow = Array.from({ length: N }, (_, i) => (i <= SIA_END ? 'WD' : '·'));
for (let i = 0; i <= SIA_END; i++) assignments[`sia|${SL(i)}`] = 'WD';
console.log('sia  ' + siaRow.map((x) => x.padEnd(6)).join('') + ' 6h 連—');

// 組 state
const state = {
  title: '排更表 08:00–16:00',
  date: '2026-11-24',
  start: '08:00',
  end: '16:00',
  people: [
    { id: 'm1', name: '男1', color: '#5B8DEF' },
    { id: 'm2', name: '男2', color: '#2D9CDB' },
    { id: 'm3', name: '男3', color: '#56CCF2' },
    { id: 'm4', name: '男4', color: '#3D5A80', from: '11:00' },
    { id: 'f1', name: '女1', color: '#E07A5F' },
    { id: 'f2', name: '女2', color: '#BB6BD9' },
    { id: 'sia', name: 'SIA', color: '#6FCF97', noRunLimit: true, noBreak: true },
  ],
  tasks: [
    { id: 'WBG', name: 'WBG', color: '#5B8DEF', isBreak: false },
    { id: 'WA', name: 'WA', color: '#F2994A', isBreak: false },
    { id: 'EA', name: 'EA', color: '#27AE60', isBreak: false },
    { id: 'WD', name: 'WD', color: '#9B51E0', isBreak: false },
    { id: 'SD', name: 'SD', color: '#EB5757', isBreak: false },
    { id: 'SC', name: 'SC', color: '#2D9CDB', isBreak: false },
    { id: 'L', name: '午餐', color: '#9AA7BD', isBreak: true },
    { id: 'B', name: 'B', color: '#C3CDDD', isBreak: true },
  ],
  rules: [
    { id: 'r_wa', type: 'cover', taskId: 'WA', from: '08:00', to: '16:00', min: 1 },
    { id: 'r_ea', type: 'cover', taskId: 'EA', from: '08:00', to: '16:00', min: 1 },
    { id: 'r_wbg_am', type: 'cover', taskId: 'WBG', from: '08:00', to: '11:00', min: 1 },
    { id: 'r_wbg_pm', type: 'cover', taskId: 'WBG', from: '14:00', to: '16:00', min: 1 },
    { id: 'r_wd', type: 'cover', taskId: 'WD', from: '08:00', to: '14:00', min: 1 },
    { id: 'r_wd_pm', type: 'cover', taskId: 'WD', from: '14:00', to: '16:00', min: 1 },
    { id: 'r_sd', type: 'cover', taskId: 'SD', from: '08:00', to: '09:00', min: 1 },
    { id: 'r_sc', type: 'cover', taskId: 'SC', from: '09:30', to: '10:00', min: 1 },
    { id: 'r_run', type: 'maxRun', hours: 2 },
    { id: 'r_lunch', type: 'rest', from: '11:00', to: '14:00', hours: 1 },
  ],
  assignments: Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b))),
};

const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
writeFileSync('rota-b64.txt', b64);
writeFileSync('rota-state.json', JSON.stringify(state, null, 2));
console.log('\nb64 len', b64.length);
console.log('LINK https://fyam1997.github.io/scheduler/#d=j1.' + b64);
