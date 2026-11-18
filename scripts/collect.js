// 실험용 실제 METAR 모으기: 미국 여러 지역 공항의 최근 48시간 관측에서 날씨가 고르게 섞이도록 200개를 뽑는다.
// 실행: node scripts/collect.js  → data/metars.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../public/lib/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'preflight-brief (student project)' };
// 훈련 공항이 많은 지역 + 날씨가 다양한 지역 (서부 사막·해안 안개·중부 바람·북부 눈·동부 비)
const STATIONS = `KDVT KPHX KFFZ KCHD KSDL KGEU KPRC KTUS KFLG KIWA KLAS KVGT KHND KSAN KMYF KCRQ KSNA KLGB KTOA KVNY KBUR KSBA KSMX KMRY KSQL KPAO KHWD KOAK KSFO KSTS KACV KEUG KPDX KHIO KSEA KBFI KPAE KBLI KBOI KSLC KPVU KDEN KAPA KBJC KCOS KABQ KSAF KELP KAMA KLBB KOKC KICT KDFW KADS KAUS KSAT KHOU KIAH KMSY KMEM KSTL KMCI KOMA KMSP KFAR KBIS KRAP KORD KDPA KMKE KDET KCLE KCMH KIND KSDF KATL KBHM KCHS KMCO KORL KTPA KMIA KFXE KJAX KRDU KCLT KIAD KBWI KPHL KTEB KFRG KISP KBOS KBED KPVD KBTV KALB KBGR KPWM KANC KFAI PHNL`.split(/\s+/);

async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) }).catch((e) => ({ ok: false, status: e.name }));
    if (r.status === 204) return [];
    if (r.ok) return r.json();
    if (i >= tries) throw new Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
}

const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const metars = [];
const airports = {};
for (const c of chunks(STATIONS, 25)) metars.push(...(await get(`https://aviationweather.gov/api/data/metar?ids=${c.join(',')}&hours=48&format=json`)));
for (const c of chunks(STATIONS, 8)) {
  for (const a of await get(`https://aviationweather.gov/api/data/airport?ids=${c.join(',')}&format=json`)) airports[a.icaoId] = { name: a.name, elev: a.elev, magdec: a.magdec, runways: a.runways };
}
console.log('받은 METAR', metars.length, '공항', Object.keys(airports).length);

// 정시 관측(METAR)만, 원문·바람 있는 것만
const pool = metars.filter((m) => m.rawOb && m.metarType === 'METAR' && airports[m.icaoId]?.runways?.length && m.wdir != null && m.temp != null && m.altim);
const tag = (m) => {
  const c = analyze(m, airports[m.icaoId]);
  if (c.category !== 'VFR') return 'cat';
  if (c.gustKt) return 'gust';
  if (c.variable) return 'vrb';
  if (c.worstCrossKt > 10) return 'xwind';
  if (c.wx.length) return 'wx';
  return 'plain';
};
const want = { cat: 60, gust: 40, xwind: 25, vrb: 15, wx: 20, plain: 40 };
// 같은 공항이 몰리지 않게 섞고, 공항당 최대 4개
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const shuffled = pool.map((m) => [rnd(), m]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const perStation = {};
const picked = [];
const count = {};
for (const pass of [1, 2]) {
  for (const m of shuffled) {
    if (picked.length >= 200) break;
    if (picked.includes(m)) continue;
    const t = tag(m);
    if (pass === 1 && (count[t] || 0) >= want[t]) continue;
    if ((perStation[m.icaoId] || 0) >= 4) continue;
    picked.push(m);
    count[t] = (count[t] || 0) + 1;
    perStation[m.icaoId] = (perStation[m.icaoId] || 0) + 1;
  }
}
const out = {
  source: 'aviationweather.gov Data API (METAR, airport)',
  collectedAt: new Date().toISOString(),
  counts: count,
  items: picked.map((m, i) => ({ n: i + 1, metar: m, airport: airports[m.icaoId] })),
};
fs.writeFileSync(path.join(here, '..', 'data', 'metars.json'), JSON.stringify(out, null, 1));
console.log('뽑은 개수', picked.length, count, '공항 수', Object.keys(perStation).length);
