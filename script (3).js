'use strict';
/* =========================================================
   剣道 試合スコアボード
   全日本剣道連盟「剣道試合・審判規則」に基づく集計
   ・三本勝負：二本先取で勝ち／時間内に一方のみ一本 → 一本勝ち
   ・反則2回で相手に一本（反則は延長戦にも持ち越し）
   ・個人戦：時間内に勝敗が決しない場合 → 延長（先に一本で勝ち）・判定
   ・団体戦：勝者数 → 総本数 → 代表者戦（一本勝負）
   ・不戦勝・欠員：勝者に二本
   データはブラウザ（localStorage）に保存
   ========================================================= */

const LS_STATE = 'kendo-scoreboard-state-v1';
const LS_TEAMS = 'kendo-scoreboard-teams-v1';
const WAZA = [['メ', '面'], ['コ', '小手'], ['ド', '胴'], ['ツ', '突き']];
const KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
const MIN_SIZE = 3, MAX_SIZE = 20, HIST_MAX = 40;
const SIDE_JP = { red: '赤', white: '白' };

/* ---------- ユーティリティ ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opp = s => (s === 'red' ? 'white' : 'red');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowStr = () => new Date().toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量超過など */ } }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store(LS_STATE, S), 250); }
function saveTeams() { store(LS_TEAMS, teams); }

/* ---------- 状態 ---------- */
function freshState() {
  return {
    view: 'team',
    settings: { title: '剣道大会', matchMin: 5, enchoMin: 0, size: 5, leftSide: 'red' },
    team: newTeamMatch(5),
    indiv: newIndiv(),
    history: []
  };
}
function newIndiv() { return { bout: newBout('個人戦', '', '', 'indiv') }; }
function newTeamMatch(size) {
  return { redTeamId: '', whiteTeamId: '', redName: '', whiteName: '', size, bouts: makeBouts(size), active: 0, rep: null, setupOpen: true };
}
function newBout(label, rn, wn, kind) {
  return {
    label, kind, needed: kind === 'rep' ? 1 : 2,
    red: { name: rn || '', aff: '', marks: [], hansoku: 0 },
    white: { name: wn || '', aff: '', marks: [], hansoku: 0 },
    first: null, status: 'pending', result: null, reason: '',
    phase: 'regular', timeLeft: null, enchoElapsed: 0, enchoOver: false, hist: []
  };
}
function makeBouts(size) { return posNames(size).map(p => newBout(p, '', '', 'team')); }

/* 3人：先鋒・中堅・大将／5人：先鋒・次鋒・中堅・副将・大将／7人：先鋒・次鋒・五将・中堅・三将・副将・大将 … */
function posNames(n) {
  if (n === 3) return ['先鋒', '中堅', '大将'];
  const a = [];
  for (let i = 0; i < n; i++) {
    const fe = n - i;
    if (i === 0) a.push('先鋒');
    else if (i === 1) a.push('次鋒');
    else if (fe === 1) a.push('大将');
    else if (fe === 2) a.push('副将');
    else if (n % 2 === 1 && i === (n - 1) / 2) a.push('中堅');
    else a.push(KANJI[fe] + '将');
  }
  return a;
}

let teams = load(LS_TEAMS, []);
let S = load(LS_STATE, null);
if (!S || !S.settings || !S.team || !S.indiv) S = freshState();
if (!Array.isArray(S.history)) S.history = [];
let editingTeamId = null;

/* ---------- 補助 ---------- */
const sides = () => (S.settings.leftSide === 'white' ? ['white', 'red'] : ['red', 'white']);
const matchSec = () => Math.round(Number(S.settings.matchMin) * 60) || 300;
const teamById = id => teams.find(t => t.id === id);
function affOf(name) { const n = name.trim(); if (!n) return ''; const tm = teams.find(t => t.members.includes(n)); return tm ? tm.name : ''; }
function touched(b) {
  return b.status === 'done' || b.red.marks.length > 0 || b.white.marks.length > 0 ||
    b.red.hansoku > 0 || b.white.hansoku > 0 || b.timeLeft !== null;
}
function fmt(sec, up) {
  const s = up ? Math.floor(sec) : Math.ceil(Math.max(0, sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function timerText(b) { return b.phase === 'encho' ? fmt(b.enchoElapsed, true) : fmt(b.timeLeft == null ? matchSec() : b.timeLeft); }
function marksStr(p) { return p.marks.map(m => (m.first ? '(' + m.t + ')' : m.t)).join('') + '▲'.repeat(p.hansoku); }

function activeBout() {
  if (S.view === 'indiv') return S.indiv.bout;
  if (S.view === 'team') { const t = S.team; return t.active === 'rep' ? t.rep : (t.bouts[t.active] || null); }
  return null;
}

/* ---------- 試合操作（規則） ---------- */
function snapshot(b) {
  const c = JSON.parse(JSON.stringify(b)); delete c.hist;
  b.hist.push(c); if (b.hist.length > HIST_MAX) b.hist.shift();
}
function replaceBout(b, data) { Object.keys(b).forEach(k => delete b[k]); Object.assign(b, data); }
function undo(b) {
  if (!b) return; const p = b.hist.pop(); if (!p) return;
  pauseIf(b); const h = b.hist; replaceBout(b, p); b.hist = h;
}
const canScore = b => b && b.status !== 'done' && b.phase !== 'await';
function pauseIf(b) { if (timer.bout === b) stopTimer(); }
function pushMark(b, side, t) {
  const first = !b.first && t !== '不';
  b[side].marks.push({ t, first });
  if (first) b.first = side;
}
function scoreIppon(b, side, t) {
  if (!canScore(b)) return;
  snapshot(b); pauseIf(b);           // 一本 → 「止め」で時計停止
  pushMark(b, side, t);
  afterScore(b, side);
}
function scoreHansoku(b, side) {
  if (!canScore(b)) return;
  snapshot(b); pauseIf(b);
  b[side].hansoku++;
  if (b[side].hansoku % 2 === 0) {    // 反則2回で相手に一本
    pushMark(b, opp(side), '反');
    afterScore(b, opp(side));
  }
}
function afterScore(b, side) {
  if (b.phase === 'encho') return finish(b, side, 'encho');   // 延長は一本先取
  if (b[side].marks.length >= b.needed) finish(b, side, 'ippon');
}
function finish(b, result, reason) { b.status = 'done'; b.result = result; b.reason = reason; pauseIf(b); }
function timeUp(b) {
  if (!b || b.status === 'done') return;
  snapshot(b); pauseIf(b);
  b.timeLeft = 0;
  const r = b.red.marks.length, w = b.white.marks.length;
  if (r !== w) finish(b, r > w ? 'red' : 'white', 'time');     // 一本勝ち
  else if (b.kind === 'team') finish(b, 'draw', 'draw');        // 団体戦は引き分け
  else b.phase = 'await';                                       // 個人戦・代表者戦 → 延長等
}
function startEncho(b) { snapshot(b); b.phase = 'encho'; b.enchoElapsed = 0; b.enchoOver = false; }
function hantei(b, side) { snapshot(b); pauseIf(b); pushMark(b, side, '判'); finish(b, side, 'hantei'); }
function fusen(b, side, reason) {
  snapshot(b); pauseIf(b);
  while (b[side].marks.length < b.needed) b[side].marks.push({ t: '不', first: false });  // 勝者に二本
  finish(b, side, reason || 'fusen');
}
function drawBout(b) { snapshot(b); finish(b, 'draw', 'draw'); }
function resetBout(b) {
  pauseIf(b);
  const nb = newBout(b.label, b.red.name, b.white.name, b.kind);
  nb.red.aff = b.red.aff; nb.white.aff = b.white.aff;
  replaceBout(b, nb);
}
function reasonText(b) {
  const w = b.result;
  if (b.reason === 'fusen' || b.reason === 'absent') return '不戦勝';
  if (b.reason === 'hantei') return '判定勝ち';
  if (b.reason === 'encho') return '延長・一本勝ち';
  return b[w].marks.length >= 2 ? '二本勝ち' : '一本勝ち';
}
function resultText(b) {
  if (b.result === 'draw') return b.reason === 'absent' ? '両者欠員' : '引き分け';
  const p = b[b.result];
  return `${SIDE_JP[b.result]}　${esc(p.name || '')} の勝ち（${reasonText(b)}）`;
}
function shortRes(b) {
  if (b.result === 'draw') return b.reason === 'absent' ? '—' : '引分';
  const lab = { fusen: '不戦', absent: '不戦', hantei: '判定', encho: '延長' }[b.reason] || (b[b.result].marks.length >= 2 ? '二本' : '一本');
  return sides()[0] === b.result ? `◀ ${lab}` : `${lab} ▶`;
}

/* ---------- タイマー ---------- */
const timer = { running: false, bout: null, last: 0, id: null, lastSave: 0 };
function toggleTimer() {
  const b = activeBout(); if (!b) return;
  if (timer.running) { stopTimer(); render(); return; }
  if (b.status === 'done' || b.phase === 'await') return;
  unlockAudio();
  if (b.timeLeft == null) b.timeLeft = matchSec();
  if (b.phase === 'regular' && b.timeLeft <= 0) return;
  timer.running = true; timer.bout = b; timer.last = performance.now();
  timer.id = setInterval(tick, 100);
  render();
}
function stopTimer() {
  if (timer.id) clearInterval(timer.id);
  timer.id = null; timer.running = false; timer.bout = null;
  store(LS_STATE, S);
}
function tick() {
  const b = timer.bout; if (!b) { stopTimer(); return; }
  const now = performance.now(), dt = (now - timer.last) / 1000; timer.last = now;
  if (b.phase === 'encho') {
    b.enchoElapsed += dt;
    const lim = Number(S.settings.enchoMin) * 60;
    if (lim > 0 && !b.enchoOver && b.enchoElapsed >= lim) {
      b.enchoElapsed = lim; b.enchoOver = true; stopTimer(); beep(); render(); return;
    }
  } else {
    b.timeLeft -= dt;
    if (b.timeLeft <= 0) { b.timeLeft = 0; stopTimer(); beep(); timeUp(b); render(); return; }
  }
  const el = document.getElementById('timer'); if (el) el.textContent = timerText(b);
  if (now - timer.lastSave > 2000) { timer.lastSave = now; store(LS_STATE, S); }
}
function adjustTime(b, v) {
  if (!b || b.status === 'done') return;
  if (b.phase === 'encho') b.enchoElapsed = Math.max(0, b.enchoElapsed + v);
  else { if (b.timeLeft == null) b.timeLeft = matchSec(); b.timeLeft = Math.max(0, b.timeLeft + v); }
  const el = document.getElementById('timer'); if (el) el.textContent = timerText(b);
  save();
}
let actx = null;
function unlockAudio() {
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { }
}
function beep() {
  try {
    unlockAudio(); const t0 = actx.currentTime;
    [0, 0.35, 0.7].forEach(d => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.18, t0 + d); g.gain.setValueAtTime(0, t0 + d + 0.25);
      o.connect(g); g.connect(actx.destination); o.start(t0 + d); o.stop(t0 + d + 0.27);
    });
  } catch (e) { }
}

/* ---------- 団体戦 ---------- */
function fillOrder(side) {
  const t = S.team, tm = teamById(t[side + 'TeamId']); if (!tm) return;
  t[side + 'Name'] = tm.name;
  t.bouts.forEach((b, i) => { if (!touched(b)) b[side].name = tm.members[i] || ''; });
}
function setSize(n) {
  n = Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
  const t = S.team; if (n === t.size) return;
  if ((t.bouts.some(touched) || t.rep) && !confirm('人数を変更すると、入力済みの試合結果がリセットされます。よろしいですか？')) return;
  stopTimer();
  const keep = { red: t.bouts.map(b => b.red.name), white: t.bouts.map(b => b.white.name) };
  t.size = n; t.bouts = makeBouts(n); t.rep = null; t.active = 0; S.settings.size = n;
  ['red', 'white'].forEach(side => {
    if (teamById(t[side + 'TeamId'])) fillOrder(side);
    else t.bouts.forEach((b, i) => { b[side].name = keep[side][i] || ''; });
  });
}
function startTeam() {
  const t = S.team;
  t.bouts.forEach(b => {
    if (touched(b)) return;
    const r = b.red.name.trim(), w = b.white.name.trim();
    if (!r && !w) finish(b, 'draw', 'absent');
    else if (!r) fusen(b, 'white', 'absent');
    else if (!w) fusen(b, 'red', 'absent');
  });
  t.setupOpen = false;
  const i = t.bouts.findIndex(b => b.status !== 'done');
  t.active = i >= 0 ? i : 0;
}
function nextBout() {
  const t = S.team; stopTimer();
  const cur = t.active === 'rep' ? -1 : t.active;
  let i = t.bouts.findIndex((b, j) => j > cur && b.status !== 'done');
  if (i < 0) i = t.bouts.findIndex(b => b.status !== 'done');
  if (i >= 0) t.active = i;
}
function teamResult(t) {
  const w = { red: 0, white: 0 }, ip = { red: 0, white: 0 }; let done = 0;
  t.bouts.forEach(b => {
    ip.red += b.red.marks.length; ip.white += b.white.marks.length;
    if (b.status === 'done') { done++; if (b.result === 'red' || b.result === 'white') w[b.result]++; }
  });
  const n = t.bouts.length, rem = n - done;
  const r = { w, ip, done, n, state: 'progress', winner: null, by: null, clinch: null };
  if (done === n) {
    if (w.red !== w.white) { r.state = 'final'; r.winner = w.red > w.white ? 'red' : 'white'; r.by = 'wins'; }
    else if (ip.red !== ip.white) { r.state = 'final'; r.winner = ip.red > ip.white ? 'red' : 'white'; r.by = 'ippon'; }
    else if (t.rep && t.rep.status === 'done' && t.rep.result !== 'draw') { r.state = 'final'; r.winner = t.rep.result; r.by = 'rep'; }
    else r.state = 'rep';
  } else {
    if (w.red > w.white + rem) r.clinch = 'red';
    else if (w.white > w.red + rem) r.clinch = 'white';
  }
  return r;
}
function startRep() {
  const t = S.team;
  const rn = $('[data-rep="red"]')?.value || '', wn = $('[data-rep="white"]')?.value || '';
  stopTimer();
  t.rep = newBout('代表者戦', rn, wn, 'rep');
  t.active = 'rep';
}
function boutRec(b, label) {
  return {
    label, rn: b.red.name, wn: b.white.name, rm: marksStr(b.red), wm: marksStr(b.white),
    res: b.result === 'draw' ? (b.reason === 'absent' ? '両者欠員' : '引分') : (b.result ? SIDE_JP[b.result] + ' ' + reasonText(b) : '')
  };
}
function recordTeam() {
  const t = S.team, r = teamResult(t); if (r.state !== 'final') return;
  const tn = s => t[s + 'Name'] || SIDE_JP[s] + 'チーム';
  const names = posNames(t.size);
  const bouts = t.bouts.map((b, i) => boutRec(b, names[i]));
  if (t.rep) bouts.push(boutRec(t.rep, '代表者戦'));
  const by = { wins: '勝者数', ippon: '総本数', rep: '代表者戦' }[r.by];
  S.history.push({
    id: uid(), type: 'team', date: nowStr(), title: S.settings.title,
    red: tn('red'), white: tn('white'), w: r.w, ip: r.ip, winner: r.winner,
    summary: `${SIDE_JP[r.winner]} ${tn(r.winner)} の勝ち（${by}）`, bouts
  });
  stopTimer();
  S.team = newTeamMatch(t.size);
  alert('試合結果を「記録」に保存しました。');
}

/* ---------- 個人戦 ---------- */
function indivNext() {
  const b = S.indiv.bout;
  if (b.status === 'done') {
    S.history.push({
      id: uid(), type: 'indiv', date: nowStr(), title: S.settings.title,
      red: { name: b.red.name, aff: b.red.aff, marks: marksStr(b.red) },
      white: { name: b.white.name, aff: b.white.aff, marks: marksStr(b.white) },
      winner: b.result,
      summary: b.result === 'draw' ? '引き分け' : `${SIDE_JP[b.result]} ${b[b.result].name} ${reasonText(b)}`
    });
  } else if (touched(b) && !confirm('試合が終了していません。記録せずに次の試合へ進みますか？')) return;
  stopTimer();
  S.indiv = newIndiv();
}

/* ---------- 描画 ---------- */
function render() {
  $('#app-title').textContent = S.settings.title || '剣道大会';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + S.view));
  ({ team: renderTeam, indiv: renderIndiv, teams: renderTeams, history: renderHistory, settings: renderSettings })[S.view]();
  save();
}

const markHtml = m => `<span class="mk${m.first ? ' first' : ''}">${m.t}</span>`;

function panelHtml(b, teamNames) {
  if (!b) return '';
  const done = b.status === 'done', running = timer.running && timer.bout === b, noScore = !canScore(b);
  const phase = b.phase === 'encho' ? '延長' : b.phase === 'await' ? '時間終了' : '';
  const tCls = [b.phase === 'encho' ? 'encho' : '', running ? 'running' : '', (b.phase !== 'encho' && b.timeLeft === 0) ? 'timeout' : ''].join(' ');
  const fighter = side => {
    const p = b[side], aff = teamNames ? teamNames[side] : p.aff;
    const cls = b.result === side ? 'winner' : (done && b.result !== 'draw' ? 'loser' : '');
    return `<div class="fighter ${side} ${cls}">
      <div class="f-top"><span class="side-tag ${side}">${SIDE_JP[side]}</span><span class="f-aff">${esc(aff || '')}</span>${b.result === side ? '<span class="win-badge">勝</span>' : ''}</div>
      <div class="f-name">${p.name ? esc(p.name) : `<span class="absent">${b.kind === 'team' ? '（欠員）' : '（選手名未入力）'}</span>`}</div>
      <div class="f-marks">${p.marks.length ? p.marks.map(markHtml).join('') : '<span class="mk empty">　</span>'}</div>
      <div class="f-hansoku">反則<span class="tri">${'▲'.repeat(p.hansoku % 2) || '－'}</span><small>（累計 ${p.hansoku}回）</small></div>
      <div class="waza">
        ${WAZA.map(([k, n]) => `<button class="waza-btn" data-act="ippon" data-side="${side}" data-t="${k}" ${noScore ? 'disabled' : ''}><b>${k}</b><small>${n}</small></button>`).join('')}
        <button class="waza-btn hansoku" data-act="hansoku" data-side="${side}" ${noScore ? 'disabled' : ''}><b>▲</b><small>反則</small></button>
      </div>
    </div>`;
  };
  let notice = '';
  if (!done && b.phase === 'await') notice = '時間終了・同点です。「延長開始」「判定」' + (b.kind === 'indiv' ? '「引き分け」' : '') + 'から選んでください。';
  else if (!done && b.phase === 'encho') notice = b.enchoOver ? '延長時間が終了しました。判定、または「開始」で延長を継続できます。' : '延長戦：先に一本を取った方の勝ちです。';
  else if (!done && b.kind === 'rep') notice = '代表者戦：一本勝負です。';

  const ctl = [`<button class="btn" data-act="undo" ${b.hist.length ? '' : 'disabled'}>↶ 取り消し</button>`];
  if (!done) {
    if (b.phase === 'regular') ctl.push('<button class="btn" data-act="timeup">時間終了</button>');
    if (b.kind === 'team') ctl.push('<button class="btn" data-act="draw">引き分け</button>');
    if (b.kind !== 'team' && b.phase === 'await') ctl.push('<button class="btn primary" data-act="encho">延長開始</button>');
    if (b.kind === 'indiv' && b.phase === 'await') ctl.push('<button class="btn" data-act="draw">引き分け</button>');
    if (b.kind !== 'team' && (b.phase === 'await' || b.phase === 'encho'))
      ['red', 'white'].forEach(s => ctl.push(`<button class="btn side-${s}" data-act="hantei" data-side="${s}">判定 ${SIDE_JP[s]}</button>`));
    ['red', 'white'].forEach(s => ctl.push(`<button class="btn ghost" data-act="fusen" data-side="${s}">不戦勝・棄権 ${SIDE_JP[s]}</button>`));
  }
  ctl.push('<button class="btn ghost" data-act="resetBout">やり直し</button>');
  if (done && b.kind === 'team' && S.team.bouts.some(x => x.status !== 'done')) ctl.push('<button class="btn primary" data-act="next">次の試合へ ▶</button>');
  if (done && b.kind === 'indiv') ctl.push('<button class="btn primary" data-act="indivNext">記録して次の試合へ ▶</button>');

  const sd = sides();
  return `<div class="card panel ${done ? 'is-done' : ''}">
    <div class="panel-head">
      <div class="bout-label">${esc(b.label)}${phase ? `<span class="badge ${b.phase}">${phase}</span>` : ''}</div>
      <div class="timer-box">
        <div id="timer" class="timer ${tCls}">${timerText(b)}</div>
        <div class="timer-btns">
          <button class="btn timer-btn ${running ? 'stop' : ''}" data-act="timer" ${done || b.phase === 'await' ? 'disabled' : ''}>${running ? '⏸ 停止' : '▶ 開始'}</button>
          <button class="btn small" data-act="tadj" data-v="-1" ${done ? 'disabled' : ''}>−1秒</button>
          <button class="btn small" data-act="tadj" data-v="1" ${done ? 'disabled' : ''}>＋1秒</button>
        </div>
      </div>
    </div>
    ${notice ? `<div class="notice">${notice}</div>` : ''}
    <div class="fighters">${fighter(sd[0])}${fighter(sd[1])}</div>
    ${done ? `<div class="result-banner ${b.result}">${resultText(b)}</div>` : ''}
    <div class="controls">${ctl.join('')}</div>
  </div>`;
}

/* 団体戦 */
function renderTeam() { renderTeamSetup(); renderTeamBoard(); }

function renderTeamSetup() {
  const t = S.team, el = $('#team-setup');
  const head = `<div class="card-head"><h2>団体戦オーダー<small>${t.size}人制</small></h2><div class="head-btns">
      <button class="btn" data-act="toggleSetup">${t.setupOpen ? '閉じる' : 'オーダー編集'}</button>
      <button class="btn" data-act="print">印刷</button>
      <button class="btn danger-ghost" data-act="newTeam">新しい団体戦</button></div></div>`;
  if (!t.setupOpen) { el.innerHTML = `<div class="card setup collapsed">${head}</div>`; return; }
  const names = posNames(t.size);
  const teamBox = side => {
    const opts = teams.map(tm => `<option value="${tm.id}" ${t[side + 'TeamId'] === tm.id ? 'selected' : ''}>${esc(tm.name)}（${tm.members.length}名）</option>`).join('');
    return `<div class="setup-team ${side}"><span class="side-tag ${side}">${SIDE_JP[side]}</span>
      <select data-bind="teamSel" data-side="${side}"><option value="">登録チームから選択…</option>${opts}</select>
      <input type="text" data-bind="teamName" data-side="${side}" value="${esc(t[side + 'Name'])}" placeholder="チーム名（直接入力も可）"></div>`;
  };
  const dl = side => {
    const tm = teamById(t[side + 'TeamId']);
    return `<datalist id="dl-${side}">${tm ? tm.members.map(m => `<option value="${esc(m)}">`).join('') : ''}</datalist>`;
  };
  const rows = t.bouts.map((b, i) => {
    const lock = touched(b);
    return `<tr class="${lock ? 'locked' : ''}"><th>${i + 1}. ${names[i]}</th>
      ${['red', 'white'].map(side => `<td><input type="text" list="dl-${side}" data-bind="orderName" data-side="${side}" data-i="${i}" value="${esc(b[side].name)}" placeholder="（欠員）" ${lock ? 'disabled' : ''}></td>`).join('')}</tr>`;
  }).join('');
  el.innerHTML = `<div class="card setup">${head}
    <div class="setup-teams">${teamBox('red')}<div class="vs">対</div>${teamBox('white')}</div>
    <div class="size-ctl"><span class="lbl">人数</span>
      <button class="btn round" data-act="size" data-v="-1" ${t.size <= MIN_SIZE ? 'disabled' : ''}>−</button>
      <b class="size-num">${t.size}</b><span>人</span>
      <button class="btn round" data-act="size" data-v="1" ${t.size >= MAX_SIZE ? 'disabled' : ''}>＋</button>
      <span class="presets">${[3, 5, 7, 10].map(n => `<button class="chip ${t.size === n ? 'on' : ''}" data-act="sizeSet" data-v="${n}">${n}人</button>`).join('')}</span>
    </div>
    <table class="setup-order"><thead><tr><th>位置</th><th class="th-red">赤</th><th class="th-white">白</th></tr></thead><tbody>${rows}</tbody></table>
    ${dl('red')}${dl('white')}
    <p class="hint">登録チームを選ぶと、登録順に先鋒から自動でオーダーが入ります（補員は候補から選択可）。空欄は欠員として、相手の不戦勝（二本）になります。</p>
    <div class="setup-actions">
      <button class="btn" data-act="refill">登録順で入れ直す</button>
      <button class="btn primary" data-act="startTeam">オーダー確定・試合開始</button>
    </div></div>`;
}

function renderTeamBoard() {
  const t = S.team, r = teamResult(t), sd = sides();
  const tn = side => t[side + 'Name'] || SIDE_JP[side] + 'チーム';
  const box = side => `<div class="team-score ${side} ${r.winner === side ? 'win' : ''} ${r.winner && r.winner !== side ? 'lose' : ''}">
      <div class="tname"><span class="side-tag ${side}">${SIDE_JP[side]}</span>${esc(tn(side))}</div>
      <div class="nums"><div class="num"><b>${r.w[side]}</b><small>勝</small></div><div class="num sub"><b>${r.ip[side]}</b><small>本</small></div></div>
    </div>`;
  let banner, bcls = '';
  if (r.state === 'final') {
    bcls = r.winner;
    const lw = r.winner, ll = opp(lw);
    const by = { wins: `勝者数 ${r.w[lw]}－${r.w[ll]}`, ippon: `勝者数同数・総本数 ${r.ip[lw]}－${r.ip[ll]}`, rep: '代表者戦' }[r.by];
    banner = `${SIDE_JP[lw]}「${esc(tn(lw))}」の勝ち<small>（${by}）</small>`;
  } else if (r.state === 'rep') {
    bcls = 'rep'; banner = '勝者数・総本数ともに同数 → 代表者戦';
  } else {
    banner = `試合中（${r.done}／${r.n} 試合終了）`;
    if (r.clinch) banner += `<small>${SIDE_JP[r.clinch]}「${esc(tn(r.clinch))}」が勝者数で勝利確定</small>`;
  }
  let html = `<h1 class="print-only">${esc(S.settings.title)}　団体戦</h1>
    <div class="summary">${box(sd[0])}<div class="vs-big">対</div>${box(sd[1])}</div>
    <div class="team-banner ${bcls}">${banner}</div>`;
  if (r.state === 'rep' && !t.rep) html += repSetupHtml(t);
  if (r.state === 'final') html += '<div class="center-actions"><button class="btn primary" data-act="saveTeamRecord">結果を記録して新しい団体戦へ</button></div>';
  html += panelHtml(activeBout(), { red: tn('red'), white: tn('white') });
  html += tableHtml(t, r, tn);
  $('#team-board').innerHTML = html;
}

function repSetupHtml(t) {
  const sel = side => {
    const set = new Set(t.bouts.map(b => b[side].name.trim()).filter(Boolean));
    const def = [...t.bouts].reverse().map(b => b[side].name.trim()).find(Boolean) || '';
    return `<select data-rep="${side}">${[...set].map(n => `<option ${n === def ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  };
  return `<div class="card rep-setup"><h3>代表者戦（一本勝負）</h3>
    <p class="hint">各チームの出場選手から1名を選出してください（初期値は大将）。</p>
    <div class="rep-row"><span class="side-tag red">赤</span>${sel('red')}<span class="vs">対</span><span class="side-tag white">白</span>${sel('white')}</div>
    <button class="btn primary" data-act="startRep">代表者戦を開始</button></div>`;
}

function tableHtml(t, r, tn) {
  const sd = sides(), act = activeBout();
  const marks = p => p.marks.map(markHtml).join('') + (p.hansoku ? `<span class="hs">${'▲'.repeat(p.hansoku)}</span>` : '');
  const row = (b, key, label) => {
    const res = b.status === 'done' ? shortRes(b) : (b === act ? '試合中' : '');
    const nm = side => `<td class="nm ${b.result === side ? 'win' : ''}">${b[side].name ? esc(b[side].name) : '<span class="absent">欠員</span>'}</td>`;
    const mk = side => `<td class="mks ${b.result === side ? 'win' : ''}">${marks(b[side])}</td>`;
    return `<tr class="${t.active === key ? 'active' : ''}" data-act="select" data-i="${key}">
      <th>${label}</th>${nm(sd[0])}${mk(sd[0])}<td class="res ${b.result || ''}">${res}</td>${mk(sd[1])}${nm(sd[1])}</tr>`;
  };
  const names = posNames(t.size);
  let body = t.bouts.map((b, i) => row(b, i, names[i])).join('');
  if (t.rep) body += row(t.rep, 'rep', '代表者戦');
  return `<div class="card table-card"><table class="score-table">
    <thead><tr><th>位置</th><th class="th-${sd[0]}" colspan="2">${SIDE_JP[sd[0]]}　${esc(tn(sd[0]))}</th><th>結果</th><th class="th-${sd[1]}" colspan="2">${SIDE_JP[sd[1]]}　${esc(tn(sd[1]))}</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><th>計</th><td colspan="2">${r.w[sd[0]]}勝　${r.ip[sd[0]]}本</td><td></td><td colspan="2">${r.w[sd[1]]}勝　${r.ip[sd[1]]}本</td></tr></tfoot>
    </table>
    <p class="legend">メ＝面　コ＝小手　ド＝胴　ツ＝突き　○＝初太刀　反＝反則による一本　▲＝反則　不＝不戦勝　判＝判定　／　行をタップするとその試合に切り替わります</p></div>`;
}

/* 個人戦 */
function renderIndiv() { renderIndivSetup(); renderIndivBoard(); renderIndivLog(); }
function renderIndivSetup() {
  const b = S.indiv.bout;
  const all = []; teams.forEach(tm => tm.members.forEach(m => all.push(`<option value="${esc(m)}">${esc(tm.name)}</option>`)));
  const box = side => `<div class="setup-team ${side}"><span class="side-tag ${side}">${SIDE_JP[side]}</span>
      <input type="text" list="dl-all" data-bind="indivName" data-side="${side}" value="${esc(b[side].name)}" placeholder="選手名">
      <input type="text" data-bind="indivAff" data-side="${side}" value="${esc(b[side].aff)}" placeholder="所属"></div>`;
  $('#indiv-setup').innerHTML = `<div class="card setup">
    <div class="card-head"><h2>個人戦<small>三本勝負・${esc(S.settings.matchMin)}分</small></h2>
      <div class="head-btns"><button class="btn" data-act="indivSwap">赤白入替</button><button class="btn danger-ghost" data-act="indivNew">新しい試合</button></div></div>
    <div class="setup-teams">${box('red')}<div class="vs">対</div>${box('white')}</div>
    <datalist id="dl-all">${all.join('')}</datalist>
    <p class="hint">登録チームの選手名を選ぶと所属が自動で入ります。</p></div>`;
}
function renderIndivBoard() { $('#indiv-board').innerHTML = panelHtml(S.indiv.bout, null); }
function renderIndivLog() {
  const list = S.history.filter(h => h.type === 'indiv').slice(-8).reverse();
  $('#indiv-log').innerHTML = list.length ? `<div class="card"><div class="card-head"><h2>最近の個人戦</h2></div>${list.map(histIndivHtml).join('')}</div>` : '';
}

/* チーム登録 */
function renderTeams() {
  const ed = editingTeamId ? teamById(editingTeamId) : null;
  const list = teams.map((tm, i) => `<li class="team-item">
      <div class="ti-main"><b>${esc(tm.name)}</b><span class="cnt">${tm.members.length}名</span>
        <div class="chips">${tm.members.map((m, j) => `<span class="chip-s">${j + 1}. ${esc(m)}</span>`).join('')}</div></div>
      <div class="ti-btns">
        <button class="btn small" data-act="teamMove" data-id="${tm.id}" data-v="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small" data-act="teamMove" data-id="${tm.id}" data-v="1" ${i === teams.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small" data-act="editTeam" data-id="${tm.id}">編集</button>
        <button class="btn small danger-ghost" data-act="delTeam" data-id="${tm.id}">削除</button>
      </div></li>`).join('');
  $('#view-teams').innerHTML = `<div class="card">
      <div class="card-head"><h2>${ed ? 'チーム編集' : 'チーム登録'}</h2></div>
      <label class="field"><span>チーム名</span><input id="reg-name" type="text" value="${esc(ed ? ed.name : '')}" placeholder="例：〇〇剣友会A"></label>
      <label class="field"><span>選手（1行に1名・先鋒から順に）</span><textarea id="reg-members" rows="8" placeholder="山田 太郎&#10;鈴木 次郎&#10;…">${esc(ed ? ed.members.join('\n') : '')}</textarea></label>
      <p class="hint">入力した順番がそのままオーダー（先鋒→大将）として自動表記されます。人数より後ろに入力した選手は補員として候補に表示されます。</p>
      <div class="setup-actions">${ed ? '<button class="btn" data-act="cancelEdit">キャンセル</button>' : ''}<button class="btn primary" data-act="saveTeam">${ed ? '更新する' : '登録する'}</button></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>登録チーム一覧<small>${teams.length}チーム</small></h2>
        <div class="head-btns"><button class="btn small" data-act="exportTeams" ${teams.length ? '' : 'disabled'}>書き出し</button><button class="btn small" data-act="importTeams">読み込み</button></div></div>
      ${teams.length ? `<ul class="team-list">${list}</ul>` : '<p class="empty">まだ登録されていません。</p>'}
    </div>`;
}
function saveTeam() {
  const name = $('#reg-name').value.trim();
  const members = $('#reg-members').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!name) { alert('チーム名を入力してください。'); return false; }
  const ed = editingTeamId ? teamById(editingTeamId) : null;
  if (ed) { ed.name = name; ed.members = members; }
  else teams.push({ id: uid(), name, members });
  saveTeams(); editingTeamId = null; return true;
}

/* 記録 */
function histIndivHtml(r) {
  const nm = p => `${esc(p.name)}${p.aff ? `（${esc(p.aff)}）` : ''}`;
  return `<div class="hist"><span class="date">${esc(r.date)}</span>
    <span class="h-main">個人戦　<b class="${r.winner === 'red' ? 'w' : ''}">赤 ${nm(r.red)}</b> ${esc(r.red.marks) || '－'} 対 ${esc(r.white.marks) || '－'} <b class="${r.winner === 'white' ? 'w' : ''}">白 ${nm(r.white)}</b></span>
    <span class="h-res">${esc(r.summary)}</span></div>`;
}
function renderHistory() {
  const h = S.history;
  const item = r => {
    if (r.type !== 'team') return histIndivHtml(r);
    const rows = r.bouts.map(b => `<tr><th>${esc(b.label)}</th><td>${esc(b.rn)}</td><td>${esc(b.rm)}</td><td>${esc(b.res)}</td><td>${esc(b.wm)}</td><td>${esc(b.wn)}</td></tr>`).join('');
    return `<details class="hist"><summary><span class="date">${esc(r.date)}</span>
      <span class="h-main">団体戦　<b class="${r.winner === 'red' ? 'w' : ''}">赤 ${esc(r.red)}</b> ${r.w.red}勝${r.ip.red}本 対 ${r.w.white}勝${r.ip.white}本 <b class="${r.winner === 'white' ? 'w' : ''}">白 ${esc(r.white)}</b></span>
      <span class="h-res">${esc(r.summary)}</span></summary>
      <table class="mini-table"><tr><th>位置</th><th>赤</th><th></th><th>結果</th><th></th><th>白</th></tr>${rows}</table></details>`;
  };
  $('#view-history').innerHTML = `<div class="card">
    <div class="card-head"><h2>試合記録<small>${h.length}件</small></h2>
      <div class="head-btns"><button class="btn small" data-act="exportCsv" ${h.length ? '' : 'disabled'}>CSV書き出し</button>
      <button class="btn small danger-ghost" data-act="clearHistory" ${h.length ? '' : 'disabled'}>全削除</button></div></div>
    ${h.length ? [...h].reverse().map(item).join('') : '<p class="empty">記録はまだありません。</p>'}</div>`;
}

/* 設定 */
function renderSettings() {
  const s = S.settings;
  $('#view-settings').innerHTML = `<div class="card">
      <div class="card-head"><h2>設定</h2></div>
      <label class="field"><span>大会名</span><input type="text" data-bind="set" data-k="title" value="${esc(s.title)}"></label>
      <div class="field-row">
        <label class="field"><span>試合時間（分）</span><input type="number" min="0.5" max="20" step="0.5" data-bind="set" data-k="matchMin" value="${esc(s.matchMin)}"></label>
        <label class="field"><span>延長時間（分・0＝制限なし）</span><input type="number" min="0" max="20" step="0.5" data-bind="set" data-k="enchoMin" value="${esc(s.enchoMin)}"></label>
      </div>
      <label class="field"><span>赤・白の表示位置</span><select data-bind="set" data-k="leftSide">
        <option value="red" ${s.leftSide !== 'white' ? 'selected' : ''}>左：赤／右：白</option>
        <option value="white" ${s.leftSide === 'white' ? 'selected' : ''}>左：白／右：赤</option></select></label>
      <p class="hint">試合時間の変更は、まだ開始していない試合から反映されます。スペースキーで計時の開始・停止ができます。</p>
    </div>
    <div class="card rules"><h2>集計ルール（全日本剣道連盟 剣道試合・審判規則に準拠）</h2><ul>
      <li>三本勝負とし、試合時間内に二本先取した者を勝ちとする。</li>
      <li>時間内に一方のみが一本を取得した場合は、その者を勝ちとする（一本勝ち）。</li>
      <li>個人戦で勝敗が決しない場合は延長戦を行い、先に一本を取得した者を勝ちとする（判定・引き分けも選択可）。</li>
      <li>反則2回で相手に一本を与える。反則の回数は延長戦にも持ち越す。</li>
      <li>団体戦は勝者数の多いチームを勝ちとし、同数の場合は総本数、なお同数の場合は代表者戦（一本勝負）で決する。</li>
      <li>不戦勝（欠員・棄権を含む）の場合、勝者に二本を与える。</li>
      <li>一本・反則の記録時は時計を止める（「止め」）。</li>
    </ul></div>
    <div class="card"><h2>データ</h2><p class="hint">チーム・試合データはこの端末のブラウザ内に保存されます。</p>
      <button class="btn danger" data-act="resetAll">すべてのデータを初期化</button></div>`;
}

/* ---------- 入出力 ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['日時', '大会', '種別', '位置', '赤', '赤 記録', '結果', '白 記録', '白'].map(q).join(',')];
  S.history.forEach(r => {
    if (r.type === 'team') {
      r.bouts.forEach(b => lines.push([r.date, r.title, `団体戦 ${r.red} 対 ${r.white}`, b.label, b.rn, b.rm, b.res, b.wm, b.wn].map(q).join(',')));
      lines.push([r.date, r.title, `団体戦 ${r.red} 対 ${r.white}`, '計', `${r.w.red}勝${r.ip.red}本`, '', r.summary, '', `${r.w.white}勝${r.ip.white}本`].map(q).join(','));
    } else {
      lines.push([r.date, r.title, '個人戦', '', `${r.red.name}（${r.red.aff}）`, r.red.marks, r.summary, r.white.marks, `${r.white.name}（${r.white.aff}）`].map(q).join(','));
    }
  });
  download('kendo-records.csv', '\ufeff' + lines.join('\r\n'), 'text/csv');
}
$('#import-file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const data = JSON.parse(rd.result), arr = Array.isArray(data) ? data : data.teams;
      let n = 0;
      (arr || []).forEach(t => {
        if (t && t.name && Array.isArray(t.members)) { teams.push({ id: uid(), name: String(t.name), members: t.members.map(String) }); n++; }
      });
      saveTeams(); alert(`${n}チームを読み込みました。`); render();
    } catch (err) { alert('読み込めませんでした。書き出したJSONファイルを選んでください。'); }
    e.target.value = '';
  };
  rd.readAsText(f);
});
function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else {
    const el = d.documentElement, f = el.requestFullscreen || el.webkitRequestFullscreen;
    if (f) f.call(el); else alert('この端末のブラウザは全画面表示に対応していません。「ホーム画面に追加」すると全画面で使えます。');
  }
}

/* ---------- イベント ---------- */
document.addEventListener('click', e => {
  const tab = e.target.closest('[data-view]');
  if (tab) { if (timer.running) stopTimer(); S.view = tab.dataset.view; editingTeamId = null; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  const a = el.dataset.act, side = el.dataset.side, b = activeBout(), t = S.team;
  switch (a) {
    case 'timer': toggleTimer(); return;
    case 'tadj': adjustTime(b, Number(el.dataset.v)); return;
    case 'fullscreen': toggleFullscreen(); return;
    case 'print': window.print(); return;
    case 'ippon': scoreIppon(b, side, el.dataset.t); break;
    case 'hansoku': scoreHansoku(b, side); break;
    case 'undo': undo(b); break;
    case 'timeup': timeUp(b); break;
    case 'draw': drawBout(b); break;
    case 'encho': startEncho(b); break;
    case 'hantei': if (!confirm(`判定により${SIDE_JP[side]}の勝ちとしますか？`)) return; hantei(b, side); break;
    case 'fusen': if (!confirm(`${SIDE_JP[side]}の不戦勝（棄権を含む）としますか？\n勝者に二本が与えられます。`)) return; fusen(b, side); break;
    case 'resetBout': if (!confirm('この試合の記録を消してやり直しますか？')) return; resetBout(b); break;
    case 'next': nextBout(); break;
    case 'select': stopTimer(); t.active = el.dataset.i === 'rep' ? 'rep' : Number(el.dataset.i); break;
    case 'toggleSetup': t.setupOpen = !t.setupOpen; break;
    case 'size': setSize(t.size + Number(el.dataset.v)); break;
    case 'sizeSet': setSize(Number(el.dataset.v)); break;
    case 'refill':
      if (!t.redTeamId && !t.whiteTeamId) { alert('登録チームが選択されていません。'); return; }
      fillOrder('red'); fillOrder('white'); break;
    case 'startTeam': startTeam(); break;
    case 'newTeam': if (!confirm('現在の団体戦をリセットして新しく始めますか？（記録していない結果は消えます）')) return; stopTimer(); S.team = newTeamMatch(t.size); break;
    case 'startRep': startRep(); break;
    case 'saveTeamRecord': recordTeam(); break;
    case 'indivNext': indivNext(); break;
    case 'indivNew': if (touched(S.indiv.bout) && !confirm('現在の試合を記録せずに新しい試合を始めますか？')) return; stopTimer(); S.indiv = newIndiv(); break;
    case 'indivSwap': { const ib = S.indiv.bout; [ib.red.name, ib.white.name] = [ib.white.name, ib.red.name]; [ib.red.aff, ib.white.aff] = [ib.white.aff, ib.red.aff]; break; }
    case 'saveTeam': if (!saveTeam()) return; break;
    case 'cancelEdit': editingTeamId = null; break;
    case 'editTeam': editingTeamId = el.dataset.id; window.scrollTo(0, 0); break;
    case 'delTeam': {
      const tm = teamById(el.dataset.id); if (!tm || !confirm(`「${tm.name}」を削除しますか？`)) return;
      teams = teams.filter(x => x.id !== tm.id);
      ['red', 'white'].forEach(s => { if (S.team[s + 'TeamId'] === tm.id) S.team[s + 'TeamId'] = ''; });
      if (editingTeamId === tm.id) editingTeamId = null;
      saveTeams(); break;
    }
    case 'teamMove': {
      const i = teams.findIndex(x => x.id === el.dataset.id), j = i + Number(el.dataset.v);
      if (i < 0 || j < 0 || j >= teams.length) return;
      [teams[i], teams[j]] = [teams[j], teams[i]]; saveTeams(); break;
    }
    case 'exportTeams': download('kendo-teams.json', JSON.stringify(teams.map(x => ({ name: x.name, members: x.members })), null, 2), 'application/json'); return;
    case 'importTeams': $('#import-file').click(); return;
    case 'exportCsv': exportCsv(); return;
    case 'clearHistory': if (!confirm('すべての試合記録を削除しますか？')) return; S.history = []; break;
    case 'resetAll':
      if (!confirm('チーム登録・試合記録を含むすべてのデータを初期化します。よろしいですか？')) return;
      stopTimer(); teams = []; saveTeams(); S = freshState(); break;
    default: return;
  }
  render();
});

document.addEventListener('input', e => {
  const el = e.target, bind = el.dataset.bind; if (!bind) return;
  const side = el.dataset.side, v = el.value;
  if (bind === 'teamName') { S.team[side + 'Name'] = v; renderTeamBoard(); }
  else if (bind === 'orderName') { const b = S.team.bouts[Number(el.dataset.i)]; if (b && !touched(b)) b[side].name = v; renderTeamBoard(); }
  else if (bind === 'indivName') {
    const b = S.indiv.bout; b[side].name = v;
    const aff = affOf(v);
    if (aff && !b[side].aff) { b[side].aff = aff; const ai = document.querySelector(`[data-bind="indivAff"][data-side="${side}"]`); if (ai) ai.value = aff; }
    renderIndivBoard();
  }
  else if (bind === 'indivAff') { S.indiv.bout[side].aff = v; renderIndivBoard(); }
  else if (bind === 'set') {
    const k = el.dataset.k;
    S.settings[k] = (k === 'matchMin' || k === 'enchoMin') ? Math.max(0, Number(v) || 0) : v;
    if (k === 'title') $('#app-title').textContent = v || '剣道大会';
  }
  else return;
  save();
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.bind === 'teamSel') {
    const side = el.dataset.side; S.team[side + 'TeamId'] = el.value;
    if (el.value) fillOrder(side);
    render();
  }
});

document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (S.view !== 'team' && S.view !== 'indiv') return;
  e.preventDefault(); toggleTimer();
});

window.addEventListener('pagehide', () => store(LS_STATE, S));

render();
