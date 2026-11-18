// 비행 전 브리핑 계산 엔진 (브라우저·서버 공용, 순수 함수)
// 숫자는 전부 여기서 코드로 계산한다. AI에게는 이 결과를 넘겨 설명만 맡긴다.

export const M_TO_FT = 3.28084;
const rad = (d) => (d * Math.PI) / 180;
export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// 훈련기 기준값. 시연 최대 옆바람은 POH 공개 수치(한계가 아니라 시험된 값, 연식마다 다를 수 있음).
// 학생 개인 옆바람 한계는 교관과 정하는 값이라 화면에서 직접 바꿀 수 있다(기본 10kt).
export const AIRCRAFT = {
  C152: { id: 'C152', name: 'Cessna 152', call: 'Cessna', demoCrosswindKt: 12, note: '출력이 작아 더운 날 상승이 특히 약함' },
  C172S: { id: 'C172S', name: 'Cessna 172S Skyhawk', call: 'Skyhawk', demoCrosswindKt: 15, note: '' },
  C182T: { id: 'C182T', name: 'Cessna 182T Skylane', call: 'Skylane', demoCrosswindKt: 15, note: '정속 프로펠러·더 큰 엔진' },
  PA28: { id: 'PA28', name: 'Piper PA-28-181 Archer', call: 'Archer', demoCrosswindKt: 17, note: '저익기' },
  DA40: { id: 'DA40', name: 'Diamond DA40 Diamond Star', call: 'Diamond Star', demoCrosswindKt: 20, note: '' },
  SR20: { id: 'SR20', name: 'Cirrus SR20', call: 'Cirrus', demoCrosswindKt: 20, note: '' },
  PA44: { id: 'PA44', name: 'Piper PA-44-180 Seminole', call: 'Seminole', demoCrosswindKt: 17, multi: true, note: '다발기: Vmc 56kt · Vyse 88kt(파란 선) · Vxse 82kt' },
};
export const DEFAULT_AIRCRAFT = 'C172S';
export const C172 = { name: AIRCRAFT.C172S.name, demoCrosswindKt: 15, studentCrosswindKt: 10, maxGustSpreadKt: 10, highDaFt: 5000 };
export function aircraftOf(id) {
  return AIRCRAFT[id] || AIRCRAFT[DEFAULT_AIRCRAFT];
}

// 시정 문자열 "10+", "1/2", "P6SM", 숫자 → 마일
export function parseVis(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace('SM', '').replace('P', '').replace('+', '').trim();
  if (s.includes(' ')) return s.split(' ').reduce((a, p) => a + parseVis(p), 0);
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    return d ? n / d : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 운고: BKN·OVC·OVX 중 가장 낮은 층, 또는 수직 시정
export function ceilingFt(clouds = [], vertVisFt = null) {
  let c = null;
  for (const l of clouds || []) {
    if (['BKN', 'OVC', 'OVX'].includes(l.cover) && l.base != null) c = c == null ? l.base : Math.min(c, l.base);
  }
  if (vertVisFt != null) c = c == null ? vertVisFt : Math.min(c, vertVisFt);
  return c;
}

// FAA 비행 범주
export function flightCategory(ceil, vis) {
  const c = ceil == null ? Infinity : ceil;
  const v = vis == null ? Infinity : vis;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

// 바람 성분. 바람 방향·활주로 방향은 같은 기준(자방위)이어야 한다.
// head + 는 맞바람, cross + 는 오른쪽에서 부는 바람
export function windComponents(windDir, windKt, rwyHdg) {
  if (!windKt || windDir == null) return { head: 0, cross: 0 };
  const a = rad(windDir - rwyHdg);
  return { head: windKt * Math.cos(a), cross: windKt * Math.sin(a) };
}

// 밀도 고도 (근사식): 기압 고도 + 120 × (기온 − ISA 기온)
export function pressureAltitudeFt(elevFt, altimInHg) {
  return elevFt + (29.92 - altimInHg) * 1000;
}
export function densityAltitudeFt(elevFt, tempC, altimInHg) {
  if (tempC == null || altimInHg == null) return null;
  const pa = pressureAltitudeFt(elevFt, altimInHg);
  const isa = 15 - (2 * pa) / 1000;
  return pa + 120 * (tempC - isa);
}

// 활주로 "07L/25R" → 각 끝의 자방위(번호×10)
export function runwayEnds(runways = []) {
  const out = [];
  for (const r of runways) {
    const [len, wid] = String(r.dimension || '').split('x').map(Number);
    for (const id of String(r.id).split('/')) {
      const num = parseInt(id, 10);
      if (!Number.isFinite(num) || num < 1 || num > 36) continue;
      out.push({ id, magHdg: num * 10, lengthFt: len || null, widthFt: wid || null, surface: r.surface || null });
    }
  }
  return out;
}

// 진방위 바람 → 자방위 (편차는 "12E" 같은 문자열, 동편차면 빼기)
export function parseMagdec(s) {
  if (s == null) return 0;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*([EW])/i);
  if (!m) return 0;
  return Number(m[1]) * (m[2].toUpperCase() === 'E' ? 1 : -1);
}

const WX_WORDS = {
  TS: '뇌우', FG: '안개', BR: '박무', HZ: '연무', FU: '연기', DU: '먼지', SA: '모래', RA: '비', SN: '눈',
  DZ: '이슬비', GR: '우박', GS: '싸락눈', FZ: '어는', SH: '소나기', VC: '근처', BL: '날리는', PL: '얼음싸라기',
};
export function wxWords(wx) {
  if (!wx) return [];
  return wx.split(' ').map((t) => {
    const inten = t.startsWith('+') ? '강한 ' : t.startsWith('-') ? '약한 ' : '';
    const body = t.replace(/^[+-]/, '');
    const parts = body.match(/.{2}/g) || [];
    return inten + parts.map((p) => WX_WORDS[p] || p).join(' ');
  });
}

// aviationweather METAR JSON 한 건 + 공항 정보 → 계산 결과
export function analyze(metar, airport = {}, opts = {}) {
  const ac = aircraftOf(opts.aircraft);
  const personalX = Number.isFinite(Number(opts.personalXwindKt)) && opts.personalXwindKt ? Number(opts.personalXwindKt) : C172.studentCrosswindKt;
  const elevFt = Math.round((metar.elev ?? airport.elev ?? 0) * M_TO_FT);
  const vis = parseVis(metar.visib);
  const ceil = ceilingFt(metar.clouds, metar.vertVis != null ? (metar.vertVis < 100 ? metar.vertVis * 100 : metar.vertVis) : null);
  const cat = flightCategory(ceil, vis);
  const altimInHg = metar.altim ? Math.round((metar.altim / 33.8639) * 100) / 100 : null;
  const variable = metar.wdir === 'VRB';
  const windDirTrue = variable ? null : Number(metar.wdir);
  const windKt = Number(metar.wspd) || 0;
  const gustKt = metar.wgst ? Number(metar.wgst) : null;
  const magdec = parseMagdec(airport.magdec);
  const windDirMag = windDirTrue == null ? null : wrap360(windDirTrue - magdec);
  const da = densityAltitudeFt(elevFt, metar.temp, altimInHg);

  const ends = runwayEnds(airport.runways);
  const runways = ends.map((e) => {
    const steady = windComponents(windDirMag, windKt, e.magHdg);
    const gust = gustKt ? windComponents(windDirMag, gustKt, e.magHdg) : null;
    return {
      ...e,
      headKt: round1(steady.head),
      crossKt: round1(steady.cross),
      gustCrossKt: gust ? round1(gust.cross) : null,
      crossFrom: steady.cross >= 0 ? '오른쪽' : '왼쪽',
    };
  });
  // 맞바람이 가장 큰 활주로 (같으면 긴 활주로)
  const best = runways.length
    ? [...runways].sort((a, b) => b.headKt - a.headKt || (b.lengthFt || 0) - (a.lengthFt || 0))[0]
    : null;
  const worstCross = best ? Math.max(Math.abs(best.crossKt), Math.abs(best.gustCrossKt ?? 0)) : variable ? windKt : null;

  const xLabel = best && best.gustCrossKt != null && Math.abs(best.gustCrossKt) > Math.abs(best.crossKt) ? `돌풍 때 옆바람` : '옆바람';
  const xWhere = best ? ` (활주로 ${best.id})` : '';
  const hazards = [];
  if (cat !== 'VFR') hazards.push({ code: 'CAT', level: cat === 'MVFR' ? 'caution' : 'stop', text: `${cat}: 운고 ${ceil ?? '없음'}ft, 시정 ${vis ?? '?'}SM — 시계비행(VFR) ${cat === 'MVFR' ? '최저치 근처' : '불가'}` });
  if (worstCross != null && worstCross > ac.demoCrosswindKt) hazards.push({ code: 'XWIND', level: 'stop', text: `${xLabel} ${Math.round(worstCross)}kt${xWhere} — ${ac.name} 시연 최대 옆바람 ${ac.demoCrosswindKt}kt 초과` });
  else if (worstCross != null && worstCross > personalX) hazards.push({ code: 'XWIND', level: 'caution', text: `${xLabel} ${Math.round(worstCross)}kt${xWhere} — 내 옆바람 한계 ${personalX}kt 초과` });
  if (gustKt && gustKt - windKt >= C172.maxGustSpreadKt) hazards.push({ code: 'GUST', level: 'caution', text: `돌풍 차이 ${gustKt - windKt}kt (${windKt}→${gustKt}kt)` });
  else if (gustKt) hazards.push({ code: 'GUST', level: 'caution', text: `돌풍 ${gustKt}kt` });
  if (variable && windKt > 6) hazards.push({ code: 'VRB', level: 'caution', text: `풍향 불규칙 ${windKt}kt` });
  if (da != null && da > C172.highDaFt) hazards.push({ code: 'DA', level: 'caution', text: `밀도 고도 ${Math.round(da).toLocaleString()}ft — 이륙 거리 늘고 상승 약해짐${ac.multi ? '. 한 엔진이 꺼지면 상승 여유가 더 줄어듦' : ''}` });
  const wx = metar.wxString || '';
  if (/TS/.test(wx)) hazards.push({ code: 'TS', level: 'stop', text: '뇌우 보고됨' });
  if (/FZ|PL|SN/.test(wx)) hazards.push({ code: 'ICE', level: 'stop', text: '착빙·눈 가능성' });
  if (metar.temp != null && metar.dewp != null && metar.temp - metar.dewp <= 2 && cat === 'VFR') hazards.push({ code: 'SPREAD', level: 'caution', text: `기온·이슬점 차 ${round1(metar.temp - metar.dewp)}°C — 안개·낮은 구름 생길 수 있음` });

  const verdict = hazards.some((h) => h.level === 'stop') ? 'NO-GO' : hazards.length ? 'CAUTION' : 'GO';
  return {
    station: metar.icaoId,
    name: airport.name?.trim() || metar.name,
    raw: metar.rawOb,
    obsTime: metar.obsTime,
    elevFt,
    windDirTrue,
    windDirMag,
    windKt,
    gustKt,
    variable,
    visSm: vis,
    ceilingFt: ceil,
    clouds: metar.clouds || [],
    wx: wxWords(wx),
    tempC: metar.temp ?? null,
    dewC: metar.dewp ?? null,
    altimInHg,
    densityAltFt: da == null ? null : Math.round(da / 10) * 10,
    category: cat,
    officialCategory: metar.fltCat || null,
    magdec,
    runways,
    bestRunway: best?.id || null,
    worstCrossKt: worstCross == null ? null : round1(worstCross),
    hazards,
    verdict,
    aircraft: { id: ac.id, name: ac.name, demoCrosswindKt: ac.demoCrosswindKt, multi: !!ac.multi, note: ac.note },
    personalXwindKt: personalX,
  };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// AI 글에서 숫자 검사: 계산 결과에 없는 숫자(바람·고도 등)가 나오면 표시
export function numberCheck(text, calc, raws = []) {
  const allowed = new Set();
  const add = (v) => {
    if (v == null || !Number.isFinite(Number(v))) return;
    const n = Number(v);
    allowed.add(String(Math.round(n)));
    allowed.add(String(Math.round(Math.abs(n))));
    allowed.add(Math.abs(n).toFixed(1).replace(/\.0$/, ''));
    allowed.add(Math.round(n).toLocaleString('en-US'));
  };
  const list = Array.isArray(calc) ? calc : [calc];
  for (const c of list) {
    if (!c) continue;
    [c.windDirTrue, c.windDirMag, c.windKt, c.gustKt, c.visSm, c.ceilingFt, c.tempC, c.dewC, c.altimInHg, c.densityAltFt, c.elevFt, c.worstCrossKt, c.magdec].forEach(add);
    if (c.gustKt && c.windKt) add(c.gustKt - c.windKt);
    if (c.tempC != null && c.dewC != null) add(c.tempC - c.dewC);
    for (const cl of c.clouds || []) add(cl.base);
    for (const r of c.runways || []) {
      [r.headKt, r.crossKt, r.gustCrossKt, r.magHdg, r.lengthFt, r.widthFt].forEach(add);
      const n = parseInt(r.id, 10);
      add(n);
      allowed.add(String(n).padStart(2, '0'));
    }
  }
  // METAR·TAF 원문에 있는 바람·돌풍·구름 높이·시정도 허용 (예보 숫자는 AI가 옮겨 쓸 수 있음)
  for (const raw of [...list.map((c) => c?.raw), ...raws].filter(Boolean)) {
    for (const m of raw.matchAll(/(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT/g)) { if (m[1] !== 'VRB') add(Number(m[1])); add(Number(m[2])); if (m[3]) add(Number(m[3])); }
    for (const m of raw.matchAll(/(?:FEW|SCT|BKN|OVC|VV)(\d{3})/g)) add(Number(m[1]) * 100);
    for (const m of raw.matchAll(/(P?\d{1,2})SM/g)) add(Number(m[1].replace('P', '')));
  }
  for (const c of list) if (c?.aircraft) { add(c.aircraft.demoCrosswindKt); add(c.personalXwindKt); }
  if (list.some((c) => c?.aircraft?.multi)) [56, 88, 82].forEach(add);
  // 기체 정보가 없으면(옛 호출) 172 기준값을 허용
  if (!list.some((c) => c?.aircraft)) [C172.demoCrosswindKt, C172.studentCrosswindKt].forEach(add);
  // 비행 범주 경계(500·1,000·3,000ft, 1·3·5SM)와 밀도 고도 경고 기준, 기종 번호
  [C172.highDaFt, 172, 500, 1000, 3000, 5, 3, 1, 0].forEach(add);
  const found = [];
  // 시간(14:00), 날짜, 활주로 번호 표기(07L)는 빼고 단위가 붙은 숫자 위주로 본다
  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(kt|노트|ft|피트|SM|마일|°C|도|inHg|%)/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    const n = raw.replace(/,/g, '');
    if (!allowed.has(raw) && !allowed.has(n) && !allowed.has(String(Math.round(Number(n))))) found.push(m[0]);
  }
  return [...new Set(found)];
}
