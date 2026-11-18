import { buildAtis, gradeAtis } from '/lib/radio.js';
import { AIRCRAFT } from '/lib/core.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const S = { data: null, dep: 'KDVT', arr: '', chat: [], scenarioState: {}, opts: { aircraft: 'C172S', xwind: 10, tail: 'N172SP' } };
const store = {
  get() { try { return JSON.parse(localStorage.getItem('pf-opts') || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem('pf-opts', JSON.stringify(v)); } catch {} },
};
$('f-ac').innerHTML = Object.values(AIRCRAFT).map((a) => `<option value="${a.id}">${a.name} · 옆바람 ${a.demoCrosswindKt}kt</option>`).join('');
function readOpts() {
  S.opts = { aircraft: $('f-ac').value, xwind: Number($('f-xw').value) || 10, tail: ($('f-tail').value || 'N172SP').trim().toUpperCase() };
  store.set(S.opts);
  return S.opts;
}
window.__pf = S;

function toast(msg, ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `요청 실패 (${res.status})`);
  return j;
}

// 탭
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  for (const t of ['brief', 'radio', 'lab']) $(`tab-${t}`).hidden = t !== name;
  if (name === 'lab') loadLab();
  if (name === 'radio') renderRadio();
  history.replaceState(null, '', name === 'brief' ? location.pathname + location.search : `#${name}`);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ───────── 브리핑 ─────────
const VERDICT_KO = { GO: '갈 만함', CAUTION: '조심', 'NO-GO': '오늘은 아님' };
const fmt = (v, unit = '', d = 0) => (v == null ? '—' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: d })}${unit}`);

function windRose(c) {
  // 활주로 양 끝(07R, 25L)을 한 줄로 묶는다
  const pairs = new Map();
  for (const r of c.runways) {
    const side = (r.id.match(/[LRC]/) || [''])[0];
    const norm = r.magHdg <= 180 ? side : { L: 'R', R: 'L' }[side] || side;
    const k = `${r.magHdg % 180}-${norm}-${r.lengthFt}`;
    if (!pairs.has(k)) pairs.set(k, r);
  }
  const lines = [];
  let i = 0;
  const n = pairs.size;
  for (const r of pairs.values()) {
    const a = (r.magHdg * Math.PI) / 180;
    const off = (i - (n - 1) / 2) * 12;
    const ox = Math.cos(a) * off, oy = Math.sin(a) * off;
    const L = 52;
    const x1 = 75 - Math.sin(a) * L + ox, y1 = 75 + Math.cos(a) * L + oy, x2 = 75 + Math.sin(a) * L + ox, y2 = 75 - Math.cos(a) * L + oy;
    const w = Math.max(5, Math.min(10, (r.widthFt || 75) / 12));
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3a4552" stroke-width="${w}" stroke-linecap="butt"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#cfd8e0" stroke-width="1" stroke-dasharray="4 4"/>`);
    i++;
  }
  let arrow = '';
  if (c.windKt && c.windDirMag != null) {
    const a = (c.windDirMag * Math.PI) / 180;
    const fx = 75 + Math.sin(a) * 68, fy = 75 - Math.cos(a) * 68, tx = 75 + Math.sin(a) * 22, ty = 75 - Math.cos(a) * 22;
    arrow = `<line x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="#5ad1ff" stroke-width="3"/><circle cx="${tx}" cy="${ty}" r="4" fill="#5ad1ff"/>`;
  }
  const ticks = ['N', 'E', 'S', 'W'].map((t, k) => {
    const a = (k * 90 * Math.PI) / 180;
    return `<text x="${75 + Math.sin(a) * 70}" y="${75 - Math.cos(a) * 70 + 4}" fill="#94a3b1" font-size="10" text-anchor="middle" font-family="IBM Plex Mono">${t}</text>`;
  });
  return `<svg viewBox="0 0 150 150" role="img" aria-label="활주로와 바람 방향 (자북 기준)"><circle cx="75" cy="75" r="62" fill="none" stroke="rgba(255,255,255,.08)"/>${ticks.join('')}${lines.join('')}${arrow}<text x="75" y="146" fill="#94a3b1" font-size="9" text-anchor="middle">자북 기준 · 파란 선 = 바람</text></svg>`;
}

function stationCard(label, s) {
  const c = s.calc;
  const sky = c.clouds.length ? c.clouds.map((l) => `${l.cover}${l.base != null ? ' ' + l.base.toLocaleString() : ''}`).join(', ') : '맑음';
  const wind = c.windKt ? `${c.variable ? 'VRB' : String(c.windDirTrue).padStart(3, '0') + '°'} ${c.windKt}${c.gustKt ? 'G' + c.gustKt : ''}kt` : '무풍';
  const rows = c.runways
    .slice()
    .sort((a, b) => b.headKt - a.headKt)
    .map(
      (r) => `<tr class="${r.id === c.bestRunway ? 'best' : ''}"><td>${esc(r.id)}${r.id === c.bestRunway ? ' ★' : ''}</td><td>${r.headKt >= 0 ? '맞' : '뒷'} ${Math.abs(r.headKt).toFixed(0)}</td><td>${Math.abs(r.crossKt).toFixed(0)}${r.gustCrossKt != null ? `<small>(G${Math.abs(r.gustCrossKt).toFixed(0)})</small>` : ''} ${r.crossKt === 0 ? '' : r.crossKt > 0 ? '→' : '←'}</td><td>${r.lengthFt ? r.lengthFt.toLocaleString() : ''}</td></tr>`
    )
    .join('');
  const haz = c.hazards.length ? c.hazards.map((h) => `<li class="${h.level}">${esc(h.text)}</li>`).join('') : '<li class="ok">코드 검사에서 걸리는 위험 요소 없음</li>';
  return `<article class="card">
    <div class="st-head"><div><small class="dim">${label}</small><h3>${esc(c.station)}</h3><div class="nm">${esc(s.airport.name || '')}</div></div><span class="cat ${c.category}" title="공식 범주 ${esc(c.officialCategory || '')}">${c.category}</span></div>
    <div class="raw"><span class="lbl">METAR</span>${esc(c.raw)}</div>
    <div class="chips">
      <div class="chip"><small>바람 (진북)</small><b>${esc(wind)}</b></div>
      <div class="chip"><small>시정</small><b>${fmt(c.visSm, 'SM', 2)}</b></div>
      <div class="chip"><small>운고</small><b>${c.ceilingFt == null ? '없음' : fmt(c.ceilingFt, 'ft')}</b></div>
      <div class="chip"><small>기온 / 이슬점</small><b>${fmt(c.tempC, '°', 1)} / ${fmt(c.dewC, '°', 1)}</b></div>
      <div class="chip"><small>고도계</small><b>${c.altimInHg?.toFixed(2) ?? '—'}</b></div>
      <div class="chip"><small>밀도 고도</small><b>${fmt(c.densityAltFt, 'ft')}</b></div>
    </div>
    <div class="dim" style="font-size:12.5px;margin-top:6px">구름: ${esc(sky)}${c.wx.length ? ' · 현상: ' + esc(c.wx.join(', ')) : ''} · 표고 ${c.elevFt.toLocaleString()}ft · 편차 ${Math.abs(c.magdec)}°${c.magdec >= 0 ? 'E' : 'W'}</div>
    ${c.runways.length ? `<div class="rwy">${windRose(c)}<table><tr><th>활주로</th><th>맞·뒷바람</th><th>옆바람 kt</th><th>길이 ft</th></tr>${rows}</table></div>` : ''}
    <ul class="haz">${haz}</ul>
    ${s.tafRaw ? `<details class="taf"><summary>TAF (예보) 원문</summary><div class="raw">${esc(s.tafRaw)}</div></details>` : ''}
  </article>`;
}

async function runBrief(dep, arr) {
  S.dep = dep;
  S.arr = arr;
  S.chat = [];
  const btn = document.querySelector('#f-brief .primary');
  btn.disabled = true;
  btn.textContent = '기상 받는 중…';
  $('ai').hidden = true;
  $('ask').hidden = true;
  try {
    const o = readOpts();
    const d = await api(`/api/brief?dep=${encodeURIComponent(dep)}${arr ? `&arr=${encodeURIComponent(arr)}` : ''}&aircraft=${o.aircraft}&xwind=${o.xwind}&tail=${encodeURIComponent(o.tail)}`);
    S.data = d;
    const v = $('verdict');
    v.className = `verdict ${d.overall}`;
    const why = [d.dep, d.arr].filter(Boolean).flatMap((s) => s.calc.hazards.filter((h) => h.level !== 'ok').map((h) => `${s.calc.station}: ${h.text}`));
    const ac = d.dep.calc.aircraft;
    v.innerHTML = `<span class="big">${d.overall}</span><p><b>${VERDICT_KO[d.overall]}</b> — 코드가 바람·구름·시정·밀도 고도를 <b>${esc(ac.name)}</b>(시연 옆바람 ${ac.demoCrosswindKt}kt)와 내 옆바람 한계 ${d.dep.calc.personalXwindKt}kt 기준으로 검사한 결과입니다.${why.length ? '<br>' + why.map(esc).join('<br>') : ''}${ac.note ? `<br><span class="acnote">${esc(ac.note)}</span>` : ''}</p>`;
    v.hidden = false;
    $('stations').innerHTML = stationCard('출발', d.dep) + (d.arr ? stationCard('도착', d.arr) : '');
    const u = new URL(location.href);
    u.searchParams.set('dep', dep);
    arr ? u.searchParams.set('arr', arr) : u.searchParams.delete('arr');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    S.atis = null;
    runAi();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '브리핑 받기';
  }
}

async function runAi() {
  $('ai').hidden = false;
  $('ai-retry').hidden = true;
  $('ai-meta').textContent = '쓰는 중…';
  $('ai-body').innerHTML = '<div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:85%"></div><div class="skeleton"></div>';
  $('ai-check').textContent = '';
  $('ai-check').className = 'numcheck';
  try {
    const r = await api('/api/brief/ai', { dep: S.dep, arr: S.arr || undefined, ...S.opts });
    const b = r.brief;
    $('ai-meta').textContent = `${r.model} · ${(r.ms / 1000).toFixed(1)}초`;
    $('ai-body').innerHTML = `<p class="headline">${esc(b.headline)}</p><p>${esc(b.verdictReason)}</p>
      ${b.sections.map((s) => `<h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>`).join('')}
      ${b.risks.length ? `<h3>조심할 점</h3><ul>${b.risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${b.checks.length ? `<h3>출발 전 스스로 확인</h3><ul>${b.checks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
    const ck = $('ai-check');
    if (r.unknownNumbers.length) {
      ck.className = 'numcheck bad';
      ck.textContent = `⚠ 숫자 검사: 계산 결과에 없는 숫자가 있습니다 (${r.unknownNumbers.join(', ')}). 위 표의 값을 믿으세요.`;
    } else {
      ck.className = 'numcheck ok';
      ck.textContent = '✓ 숫자 검사: AI 글의 바람·고도·시정 숫자가 모두 코드 계산값과 일치합니다.';
    }
    $('ask').hidden = false;
    renderChat(b.checks.slice(0, 2));
  } catch (e) {
    $('ai-meta').textContent = '';
    $('ai-body').innerHTML = `<p class="err">${esc(e.message)}</p><p class="dim">위의 코드 계산 결과와 위험 요소는 AI 없이도 그대로 쓸 수 있습니다.</p>`;
    $('ai-retry').hidden = false;
  }
}
$('ai-retry').addEventListener('click', runAi);

function renderChat(follow = []) {
  $('chat').innerHTML = S.chat.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.text)}${m.warn ? `<br><small class="err">⚠ 계산에 없는 숫자: ${esc(m.warn)}</small>` : ''}</div>`).join('');
  $('follow').innerHTML = follow.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  $('follow').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
}
async function ask(q) {
  if (!q.trim()) return;
  S.chat.push({ role: 'user', text: q });
  renderChat();
  $('f-q').value = '';
  const btn = document.querySelector('#f-ask .primary');
  btn.disabled = true;
  try {
    const r = await api('/api/ask', { question: q, dep: S.dep, arr: S.arr || undefined, history: S.chat.slice(0, -1), ...S.opts });
    S.chat.push({ role: 'bot', text: r.answer, warn: r.unknownNumbers.join(', ') });
    renderChat(r.followUps || []);
  } catch (e) {
    S.chat.push({ role: 'bot', text: e.message });
    renderChat();
  } finally {
    btn.disabled = false;
  }
}
$('f-ask').addEventListener('submit', (e) => {
  e.preventDefault();
  ask($('f-q').value);
});
$('f-brief').addEventListener('submit', (e) => {
  e.preventDefault();
  runBrief($('f-dep').value.trim().toUpperCase(), $('f-arr').value.trim().toUpperCase());
});
document.querySelectorAll('.quick [data-q]').forEach((b) =>
  b.addEventListener('click', () => {
    const [d, a] = b.dataset.q.split(',');
    $('f-dep').value = d;
    $('f-arr').value = a;
    runBrief(d, a);
  })
);

// ───────── 무전 연습 ─────────
function speak(text, rate = 1) {
  if (!('speechSynthesis' in window)) return toast('이 브라우저는 음성 읽기를 지원하지 않습니다.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = rate;
  const v = speechSynthesis.getVoices().find((x) => /en-US/.test(x.lang) && /Google|Microsoft (Guy|Aria|Mark|David)/.test(x.name)) || speechSynthesis.getVoices().find((x) => /en-US/.test(x.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function renderRadio() {
  if (!S.data) return runBrief(S.dep, S.arr).then(renderRadio);
  const d = S.data;
  if (!S.atis) S.atis = buildAtis(d.dep.calc, d.dep.airport.name);
  $('atis-apt').textContent = d.dep.calc.station;
  $('atis-src').textContent = d.dep.calc.raw.split(' ').slice(0, 3).join(' ');
  $('atis-text').textContent = S.atis.text;
  $('scenarios').innerHTML = d.scenarios
    .map(
      (s) => `<div class="card scn" data-id="${s.id}">
      <h2>${esc(s.title)}</h2>
      <p class="dim">${esc(s.situation)}</p>
      ${s.controller ? `<div class="ctl">🎧 ATC: ${esc(s.controller)} <button class="ghost play" type="button" style="padding:2px 10px;margin-left:6px">▶</button></div>` : ''}
      <div class="row">${SR ? '<button class="mic" type="button">🎙 말하기</button>' : '<span class="dim" style="font-size:13px">이 브라우저는 음성 인식이 없어 직접 쳐야 합니다.</span>'}<button class="ghost hint" type="button">모범 문장 보기</button></div>
      <textarea placeholder="여기에 무전 문장 (말하면 자동으로 채워짐)" maxlength="400"></textarea>
      <div class="row" style="margin-top:8px"><button class="primary grade" type="button">평가 받기</button></div>
      <div class="model mono dim" hidden style="font-size:13px">${esc(s.model)}</div>
      <div class="fb"></div>
    </div>`
    )
    .join('');
  document.querySelectorAll('.scn').forEach((el) => {
    const id = el.dataset.id;
    const s = d.scenarios.find((x) => x.id === id);
    const ta = el.querySelector('textarea');
    el.querySelector('.play')?.addEventListener('click', () => speak(s.controller, 0.95));
    el.querySelector('.hint').addEventListener('click', () => (el.querySelector('.model').hidden = !el.querySelector('.model').hidden));
    const mic = el.querySelector('.mic');
    if (mic) {
      let rec = null;
      mic.addEventListener('click', () => {
        if (rec) return rec.stop();
        rec = new SR();
        rec.lang = 'en-US';
        rec.interimResults = true;
        rec.onresult = (ev) => (ta.value = Array.from(ev.results).map((r) => r[0].transcript).join(' '));
        rec.onerror = (ev) => toast(ev.error === 'not-allowed' ? '마이크 권한을 허용해 주세요.' : `음성 인식 오류: ${ev.error}`);
        rec.onend = () => {
          rec = null;
          mic.classList.remove('on');
          mic.textContent = '🎙 말하기';
        };
        rec.start();
        mic.classList.add('on');
        mic.textContent = '■ 멈추기';
      });
    }
    el.querySelector('.grade').addEventListener('click', async () => {
      const fb = el.querySelector('.fb');
      if (!ta.value.trim()) return toast('무전 문장을 말하거나 쳐 주세요.');
      fb.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>';
      try {
        const r = await api('/api/radio', { scenario: id, transcript: ta.value, dep: S.dep, ...S.opts });
        fb.innerHTML = `<div class="res">${r.checks.map((c) => `<span class="pill ${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'} ${esc(c.k)}</span>`).join('')}</div>
          <p><span class="score">${r.score}</span> <span class="dim">/ 100 (AI 평가)</span></p>
          ${r.good.length ? `<p>👍 ${r.good.map(esc).join(' · ')}</p>` : ''}
          ${r.fix.length ? `<ul>${r.fix.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          <div class="better">${esc(r.better)} <button class="ghost sayb" type="button" style="padding:2px 10px">▶</button></div>`;
        fb.querySelector('.sayb').addEventListener('click', () => speak(r.better, 0.95));
      } catch (e) {
        fb.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      }
    });
  });
}
$('atis-play').addEventListener('click', () => S.atis && speak(S.atis.text, 0.95));
$('atis-slow').addEventListener('click', () => S.atis && speak(S.atis.text, 0.75));
$('atis-show').addEventListener('click', () => ($('atis-text').hidden = !$('atis-text').hidden));
$('f-atis').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!S.atis) return;
  const input = Object.fromEntries(new FormData(e.target));
  const g = gradeAtis(S.atis.answer, input);
  const a = S.atis.answer;
  $('atis-result').innerHTML = `<div class="res"><b style="margin-right:6px">${g.score} / ${g.total}</b>${g.items.map((i) => `<span class="pill ${i.ok ? 'ok' : 'no'}">${i.ok ? '✓' : '✗'} ${i.k}</span>`).join('')}</div>
    <p class="dim mono" style="font-size:13px">정답: ${a.letter} · ${a.windDir === 'VRB' ? 'VRB' : String(a.windDir).padStart(3, '0')}° ${a.windKt}kt${a.gustKt ? ' G' + a.gustKt : ''} · 고도계 ${a.altim?.toFixed(2)} · 활주로 ${a.runway}</p>`;
});

// ───────── 실험 ─────────
async function loadLab() {
  const el = $('lab');
  if (el.dataset.loaded) return;
  el.innerHTML = '<div class="card"><div class="skeleton"></div></div>';
  try {
    const r = await api('/api/lab');
    if (!r.ready) {
      el.innerHTML = '<div class="card"><h2>실험 결과 준비 중</h2><p class="dim">scripts/eval.js를 실행하면 여기에 결과가 나옵니다.</p></div>';
      return;
    }
    el.dataset.loaded = '1';
    el.innerHTML = renderLab(r);
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
  }
}

function renderLab(r) {
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const bar = (x, cls = '') => `<div class="bar"><i class="${cls}" style="width:${(x || 0) * 100}%"></i></div>`;
  const m = r.models;
  const fieldRows = r.fields
    .map((f) => `<tr><td>${esc(f.label)}</td>${m.map((md) => `<td class="num">${pct(r.aiOnly[md]?.fields[f.key])}</td><td>${bar(r.aiOnly[md]?.fields[f.key])}</td>`).join('')}<td class="num">100%</td></tr>`)
    .join('');
  const briefRows = r.briefChecks
    .map((f) => `<tr><td>${esc(f.label)}</td>${m.map((md) => `<td class="num">${pct(r.hybrid[md]?.checks[f.key])}</td><td>${bar(r.hybrid[md]?.checks[f.key], 'b')}</td>`).join('')}</tr>`)
    .join('');
  return `
  <div class="card lab"><h2>무엇을 비교했나</h2>
    <p>미국 ${r.dataset.airports}개 공항의 실제 METAR <b>${r.dataset.n}개</b> (${esc(r.dataset.collectedAt.slice(0, 10))} 수집, 비VFR ${r.dataset.nonVfr}개·돌풍 ${r.dataset.gust}개 포함). 정답은 코드 계산이고, 코드 비행 범주는 기상청 공식 범주와 <b>${r.dataset.officialMatch}</b> 일치했습니다.</p>
    <p><b>방식 ① AI 혼자:</b> METAR 원문과 활주로만 주고 AI가 해석·계산. <b>방식 ② 코드 + AI (이 앱):</b> 코드가 계산한 값을 주고 AI는 한국어 브리핑만.</p>
  </div>
  <div class="big3">${r.headline.map((h) => `<div><b>${esc(h.value)}</b><small>${esc(h.label)}</small></div>`).join('')}</div>
  <div class="card lab"><h2>① AI 혼자 METAR를 읽었을 때 항목별 정답률</h2>
    <table><tr><th>항목</th>${m.map((md) => `<th colspan="2">${esc(md)}</th>`).join('')}<th>코드</th></tr>${fieldRows}
    <tr><td><b>모든 항목 다 맞은 METAR</b></td>${m.map((md) => `<td class="num"><b>${pct(r.aiOnly[md]?.allCorrect)}</b></td><td></td>`).join('')}<td class="num">100%</td></tr></table>
    <p class="dim" style="font-size:12.5px">허용 오차: 바람 성분·옆바람 ±2kt, 밀도 고도 ±300ft, 운고 정확히, 시정 ±0.1SM.</p>
  </div>
  <div class="card lab"><h2>② 코드 + AI 브리핑 검사</h2>
    <table><tr><th>검사</th>${m.map((md) => `<th colspan="2">${esc(md)}</th>`).join('')}</tr>${briefRows}
    <tr><td><b>4가지 모두 통과</b></td>${m.map((md) => `<td class="num"><b>${pct(r.hybrid[md]?.allCorrect)}</b></td><td></td>`).join('')}</tr>
    <tr class="dim"><td>참고: 맑은 날까지 모든 브리핑에 범주 언급 (처음 기준)</td>${m.map((md) => `<td class="num">${pct(r.hybrid[md]?.categoryAny)}</td><td></td>`).join('')}</tr></table>
    <p class="dim" style="font-size:12.5px">처음에는 모든 브리핑에 비행 범주를 쓰는지 봤지만, 빠진 경우가 전부 맑은 날(VFR)이라 위험하지 않다고 보고 "VFR 아래 날씨면 반드시 언급"으로 기준을 바꿨습니다. 처음 기준 결과도 위에 그대로 둡니다.</p>
  </div>
  <div class="card lab"><h2>실패 사례</h2>${r.failures.map((f) => `<div class="fail"><b>${esc(f.title)}</b><code>${esc(f.raw)}</code>${esc(f.detail)}</div>`).join('')}</div>
  <div class="card lab"><h2>모델 비용·속도</h2><table><tr><th>모델</th><th>호출</th><th>평균 응답</th><th>토큰</th></tr>${m.map((md) => `<tr><td>${esc(md)}</td><td class="num">${r.cost[md]?.calls ?? '—'}</td><td class="num">${r.cost[md]?.avgSec?.toFixed?.(1) ?? '—'}초</td><td class="num">${r.cost[md]?.tokens?.toLocaleString?.() ?? '—'}</td></tr>`).join('')}</table></div>`;
}

// 시작
const saved = store.get();
if (saved && AIRCRAFT[saved.aircraft]) {
  $('f-ac').value = saved.aircraft;
  $('f-xw').value = saved.xwind || 10;
  $('f-tail').value = saved.tail || 'N172SP';
} else $('f-ac').value = 'C172S';
$('f-ac').addEventListener('change', () => {
  // 기종에 맞는 흔한 기체 번호 예시로 바꿔 줌 (사용자가 바꾼 번호는 그대로)
  if (/^N(172SP|152|182|4412K|28|40|20)/.test($('f-tail').value.toUpperCase())) $('f-tail').value = { C152: 'N152AB', C172S: 'N172SP', C182T: 'N182TS', PA28: 'N28AR', DA40: 'N40DS', SR20: 'N20SR', PA44: 'N4412K' }[$('f-ac').value];
});
const q = new URLSearchParams(location.search);
$('f-dep').value = (q.get('dep') || 'KDVT').toUpperCase();
$('f-arr').value = (q.get('arr') || '').toUpperCase();
runBrief($('f-dep').value, $('f-arr').value);
if (location.hash === '#radio') showTab('radio');
if (location.hash === '#lab') showTab('lab');
