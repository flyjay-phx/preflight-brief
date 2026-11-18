// 정확도 실험: 실제 METAR 200개로 ① AI 혼자 해석 vs ② 코드 계산 + AI 설명을 비교한다.
// 실행: node scripts/eval.js   (GEMINI_API_KEY 필요. 모델은 EVAL_MODELS="a,b"로 바꿀 수 있음)
// AI 원답은 evaluation/results/raw-*.json에 저장되고, 있으면 다시 부르지 않는다(이어서 실행 가능).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server.js';
import { Gemini } from '../src/gemini.js';
import { analyze, numberCheck } from '../public/lib/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const OUT = path.join(root, 'evaluation', 'results');
loadEnv(path.join(root, '.env'));
const MODELS = (process.env.EVAL_MODELS || 'gemini-3.1-flash-lite,gemini-3.5-flash').split(',').map((s) => s.trim());
const GAP_MS = Number(process.env.EVAL_GAP_MS || 6500);
const SCORE_ONLY = process.argv.includes('--score'); // 저장된 AI 답만 다시 채점 (AI 호출 없음)
const ai = new Gemini();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(fs.readFileSync(path.join(root, 'data', 'metars.json'), 'utf8'));
const items = data.items.map((it) => ({ n: it.n, metar: it.metar, airport: it.airport, truth: analyze(it.metar, it.airport) }));

// ───── ① AI 혼자 ─────
const A_SYSTEM = `You are an aviation weather assistant. Decode METARs and compute values exactly as a flight instructor would.
Rules: METAR wind direction is TRUE. Runway numbers are MAGNETIC (number x 10). Convert wind to magnetic using the given magnetic variation (east variation: magnetic = true - variation).
Ceiling = lowest BKN, OVC or vertical visibility layer in feet (null if none). Flight category (FAA): LIFR ceiling<500 or vis<1; IFR ceiling<1000 or vis<3; MVFR ceiling 1000-3000 or vis 3-5; else VFR.
Best runway = the runway end with the largest headwind (if calm, the longest). Headwind/crosswind in knots for the best runway using the steady wind (not gust); crosswind as absolute value.
Density altitude (ft) = pressure altitude + 120 x (OAT - ISA temp), pressure altitude = field elevation + (29.92 - altimeter) x 1000, ISA temp = 15 - 2 x pressure altitude/1000.`;
const A_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      n: { type: 'integer' },
      windDirTrue: { type: 'integer', nullable: true, description: 'null if variable or calm' },
      windKt: { type: 'integer' },
      gustKt: { type: 'integer', nullable: true },
      visSm: { type: 'number' },
      ceilingFt: { type: 'integer', nullable: true },
      category: { type: 'string', enum: ['VFR', 'MVFR', 'IFR', 'LIFR'] },
      bestRunway: { type: 'string' },
      headKt: { type: 'number' },
      crossKt: { type: 'number' },
      densityAltFt: { type: 'integer' },
    },
    required: ['n', 'windDirTrue', 'windKt', 'gustKt', 'visSm', 'ceilingFt', 'category', 'bestRunway', 'headKt', 'crossKt', 'densityAltFt'],
  },
};
function aPrompt(batch) {
  return batch
    .map((it) => `#${it.n} | field elevation ${it.truth.elevFt} ft | magnetic variation ${it.truth.magdec >= 0 ? it.truth.magdec + 'E' : -it.truth.magdec + 'W'} | runways ${it.truth.runways.map((r) => r.id).join(', ')}\n${it.metar.rawOb}`)
    .join('\n\n') + `\n\nReturn one object per METAR (${batch.length} total), same n.`;
}

// ───── ② 코드 + AI ─────
const B_SYSTEM = `너는 한국인 학생 조종사용 비행 전 브리핑 도우미다. 각 공항의 "계산 결과"만 근거로 한국어 브리핑을 쓴다.
- 숫자는 계산 결과에 있는 값만 쓴다. 새로 계산하거나 지어내지 않는다.
- 판정(verdict)은 바꾸지 않고 이유를 설명한다. 위험 요소(hazards)는 빠짐없이 언급한다.
- 공항마다 3~4문장.`;
const B_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { n: { type: 'integer' }, verdict: { type: 'string' }, text: { type: 'string' } }, required: ['n', 'verdict', 'text'] },
};
function bPrompt(batch) {
  return batch
    .map((it) => {
      const c = it.truth;
      const best = c.runways.find((r) => r.id === c.bestRunway);
      return `#${it.n} ${c.station} 계산 결과: ${JSON.stringify({ category: c.category, verdict: c.verdict, windDirMag: c.windDirMag, windKt: c.windKt, gustKt: c.gustKt, visSm: c.visSm, ceilingFt: c.ceilingFt, tempC: c.tempC, dewC: c.dewC, altimInHg: c.altimInHg, densityAltFt: c.densityAltFt, bestRunway: c.bestRunway, headKt: best?.headKt, crossKt: best?.crossKt, gustCrossKt: best?.gustCrossKt, hazards: c.hazards.map((h) => h.text) })}`;
    })
    .join('\n') + `\n\n공항마다 하나씩 (${batch.length}개), 같은 n.`;
}

const HAZ_WORDS = { CAT: /운고|시정|MVFR|IFR|LIFR|구름/, XWIND: /옆바람|측풍/, GUST: /돌풍/, VRB: /불규칙|변동|VRB/, DA: /밀도 ?고도/, TS: /뇌우/, ICE: /착빙|눈|어는/, SPREAD: /이슬점|안개/ };
const CAT_WORDS = { VFR: /VFR|시계비행/, MVFR: /MVFR/, IFR: /(?<![LM])IFR|계기비행/, LIFR: /LIFR/ };

async function callBatches(model, mode, batchSize, system, schema, promptFn) {
  const file = path.join(OUT, `raw-${model}-${mode}.json`);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { model, mode, calls: [] };
  const done = new Set(saved.calls.flatMap((c) => c.ns));
  if (SCORE_ONLY) return saved;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    if (batch.every((b) => done.has(b.n))) continue;
    for (let tryN = 0; ; tryN++) {
      const t0 = Date.now();
      try {
        const r = await ai.json({ system, prompt: promptFn(batch), schema, model, temperature: 0, maxTokens: 24000, timeoutMs: 300000 });
        saved.calls.push({ ns: batch.map((b) => b.n), ms: Date.now() - t0, tokens: r.usage?.totalTokenCount ?? null, out: r.data });
        fs.writeFileSync(file, JSON.stringify(saved, null, 1));
        console.log(`${model} ${mode} ${i + batch.length}/${items.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        break;
      } catch (e) {
        console.log(`${model} ${mode} 실패 (${e.message}) ${tryN < 5 ? '다시 시도' : '건너뜀'}`);
        if (tryN >= 5) break;
        await sleep(e.status === 429 ? 30000 * (tryN + 1) : 5000);
      }
    }
    await sleep(GAP_MS);
  }
  return saved;
}

const near = (a, b, tol) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
function scoreA(saved) {
  const byN = new Map();
  for (const c of saved.calls) for (const o of c.out || []) byN.set(o.n, o);
  const keys = ['windDir', 'windKt', 'gustKt', 'visSm', 'ceilingFt', 'category', 'bestRunway', 'crossKt', 'densityAltFt'];
  const hit = Object.fromEntries(keys.map((k) => [k, 0]));
  let all = 0, answered = 0, optimistic = 0;
  const fails = [];
  const order = ['LIFR', 'IFR', 'MVFR', 'VFR'];
  for (const it of items) {
    const t = it.truth, o = byN.get(it.n);
    if (!o) continue;
    answered++;
    const tBest = t.runways.find((r) => r.id === t.bestRunway);
    const aiRwy = t.runways.find((r) => r.id.replace(/^0/, '') === String(o.bestRunway).replace(/^0/, '').toUpperCase());
    const ok = {
      windDir: t.variable || !t.windKt ? o.windDirTrue == null || !t.windKt : o.windDirTrue === t.windDirTrue,
      windKt: o.windKt === t.windKt,
      gustKt: (o.gustKt || null) === (t.gustKt || null),
      visSm: near(o.visSm, t.visSm, 0.1),
      ceilingFt: (o.ceilingFt ?? null) === (t.ceilingFt ?? null),
      category: o.category === t.category,
      bestRunway: !!aiRwy && tBest && aiRwy.headKt >= tBest.headKt - 1,
      crossKt: aiRwy ? near(Math.abs(o.crossKt), Math.abs(aiRwy.crossKt), 2) : false,
      densityAltFt: near(o.densityAltFt, t.densityAltFt, 300),
    };
    for (const k of keys) if (ok[k]) hit[k]++;
    if (keys.every((k) => ok[k])) all++;
    if (order.indexOf(o.category) > order.indexOf(t.category)) optimistic++;
    const wrong = keys.filter((k) => !ok[k]);
    if (wrong.length) fails.push({ n: it.n, raw: t.raw, wrong, ai: o, truth: { windDirTrue: t.windDirTrue, windKt: t.windKt, gustKt: t.gustKt, visSm: t.visSm, ceilingFt: t.ceilingFt, category: t.category, bestRunway: t.bestRunway, crossKt: aiRwy ? aiRwy.crossKt : tBest?.crossKt, densityAltFt: t.densityAltFt } });
  }
  return { answered, fields: Object.fromEntries(keys.map((k) => [k, hit[k] / (answered || 1)])), allCorrect: all / (answered || 1), optimistic, fails };
}
function scoreB(saved) {
  const byN = new Map();
  for (const c of saved.calls) for (const o of c.out || []) byN.set(o.n, o);
  const keys = ['numbers', 'category', 'hazards', 'verdict'];
  const hit = Object.fromEntries(keys.map((k) => [k, 0]));
  let answered = 0, all = 0, catAny = 0;
  const fails = [];
  for (const it of items) {
    const t = it.truth, o = byN.get(it.n);
    if (!o) continue;
    answered++;
    const unknown = numberCheck(o.text, t);
    const missing = t.hazards.filter((h) => HAZ_WORDS[h.code] && !HAZ_WORDS[h.code].test(o.text)).map((h) => h.code);
    const flipped = (t.verdict === 'NO-GO' && /문제\s?없|괜찮|비행하기 좋|좋은 날/.test(o.text)) || (t.verdict === 'GO' && /비행 불가|취소하|하지 마/.test(o.text)) || o.verdict.replace(/\s/g, '').toUpperCase() !== t.verdict;
    const mentions = CAT_WORDS[t.category].test(o.text);
    if (mentions) catAny++;
    // 비행 범주는 VFR 아래일 때만 필수 (맑은 날 'VFR'을 안 쓰는 것은 위험하지 않음). 처음의 엄격한 기준(categoryAny)도 함께 기록
    const ok = { numbers: unknown.length === 0, category: t.category === 'VFR' || mentions, hazards: missing.length === 0, verdict: !flipped };
    for (const k of keys) if (ok[k]) hit[k]++;
    if (keys.every((k) => ok[k])) all++;
    else fails.push({ n: it.n, raw: t.raw, text: o.text, unknown, missing, flipped, verdict: o.verdict, truthVerdict: t.verdict });
  }
  return { answered, checks: Object.fromEntries(keys.map((k) => [k, hit[k] / (answered || 1)])), categoryAny: catAny / (answered || 1), allCorrect: all / (answered || 1), fails };
}
function cost(...saves) {
  const calls = saves.flatMap((s) => s.calls);
  return { calls: calls.length, avgSec: calls.reduce((a, c) => a + c.ms, 0) / (calls.length || 1) / 1000, tokens: calls.reduce((a, c) => a + (c.tokens || 0), 0) };
}

if (!ai.ready && !SCORE_ONLY) {
  console.error('GEMINI_API_KEY가 없습니다. .env에 넣고 다시 실행하세요.');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const summary = {
  generatedAt: new Date().toISOString(),
  models: MODELS,
  dataset: {
    n: items.length,
    airports: new Set(items.map((i) => i.truth.station)).size,
    collectedAt: data.collectedAt,
    nonVfr: items.filter((i) => i.truth.category !== 'VFR').length,
    gust: items.filter((i) => i.truth.gustKt).length,
    officialMatch: `${items.filter((i) => i.truth.category === i.truth.officialCategory).length}/${items.length}`,
  },
  fields: [
    { key: 'windDir', label: '풍향' },
    { key: 'windKt', label: '풍속' },
    { key: 'gustKt', label: '돌풍' },
    { key: 'visSm', label: '시정' },
    { key: 'ceilingFt', label: '운고' },
    { key: 'category', label: '비행 범주 (VFR/IFR)' },
    { key: 'bestRunway', label: '쓸 활주로' },
    { key: 'crossKt', label: '옆바람 (±2kt)' },
    { key: 'densityAltFt', label: '밀도 고도 (±300ft)' },
  ],
  briefChecks: [
    { key: 'numbers', label: '숫자가 모두 계산값과 일치' },
    { key: 'category', label: 'VFR 아래 날씨면 비행 범주 언급' },
    { key: 'hazards', label: '위험 요소 빠짐없이 언급' },
    { key: 'verdict', label: '판정을 뒤집지 않음' },
  ],
  aiOnly: {},
  hybrid: {},
  cost: {},
};
const detail = {};
for (const model of MODELS) {
  const a = await callBatches(model, 'ai-only', 20, A_SYSTEM, A_SCHEMA, aPrompt);
  // 하루 호출 한도가 작은 모델은 한 번에 20개씩 (lite 모델은 10개씩 실행했음)
  const b = await callBatches(model, 'hybrid', model.includes('lite') ? 10 : 20, B_SYSTEM, B_SCHEMA, bPrompt);
  const sa = scoreA(a), sb = scoreB(b);
  summary.aiOnly[model] = { answered: sa.answered, fields: sa.fields, allCorrect: sa.allCorrect, optimistic: sa.optimistic };
  summary.hybrid[model] = { answered: sb.answered, checks: sb.checks, categoryAny: sb.categoryAny, allCorrect: sb.allCorrect };
  summary.cost[model] = cost(a, b);
  detail[model] = { aiOnlyFails: sa.fails, hybridFails: sb.fails };
}
fs.writeFileSync(path.join(OUT, 'details.json'), JSON.stringify(detail, null, 1));

// 실패 사례 고르기 (사람이 읽을 대표 사례)
const failures = [];
const m0 = MODELS[0];
const pickA = (pred, title, explain) => {
  for (const md of MODELS) {
    const f = detail[md].aiOnlyFails.find((x) => pred(x) && !failures.some((y) => y.n === x.n));
    if (f) return failures.push({ n: f.n, title: `${title} (${md}, AI 혼자)`, raw: f.raw, detail: explain(f) });
  }
};
pickA((f) => f.wrong.includes('category') && ['VFR', 'MVFR', 'IFR'].indexOf(f.ai.category) > -1 && ['LIFR', 'IFR', 'MVFR', 'VFR'].indexOf(f.ai.category) > ['LIFR', 'IFR', 'MVFR', 'VFR'].indexOf(f.truth.category), '날씨를 실제보다 좋게 판정', (f) => `AI: ${f.ai.category} (운고 ${f.ai.ceilingFt ?? '없음'}, 시정 ${f.ai.visSm}) → 정답: ${f.truth.category} (운고 ${f.truth.ceilingFt ?? '없음'}, 시정 ${f.truth.visSm}). 학생이 그대로 믿으면 시계비행이 안 되는 날씨에 나갈 수 있는 위험한 오답.`);
pickA((f) => f.wrong.includes('crossKt'), '옆바람 계산 틀림', (f) => `AI: 활주로 ${f.ai.bestRunway} 옆바람 ${f.ai.crossKt}kt → 정답 ${Math.abs(f.truth.crossKt ?? 0)}kt. 자북 보정이나 각도 계산에서 틀림.`);
pickA((f) => f.wrong.includes('densityAltFt'), '밀도 고도 계산 틀림', (f) => `AI: ${f.ai.densityAltFt}ft → 정답 ${f.truth.densityAltFt}ft.`);
pickA((f) => f.wrong.includes('ceilingFt'), '운고 판단 틀림', (f) => `AI: ${f.ai.ceilingFt ?? '없음'} → 정답 ${f.truth.ceilingFt ?? '없음'}. FEW·SCT는 운고가 아닌데 운고로 봤거나 그 반대.`);
pickA((f) => f.wrong.includes('bestRunway'), '쓸 활주로 틀림', (f) => `AI: ${f.ai.bestRunway} → 정답 ${f.truth.bestRunway}. 뒷바람 활주로를 고르면 이착륙 거리가 크게 늘어남.`);
for (const md of MODELS) {
  const f = detail[md].hybridFails.find((x) => x.unknown.length);
  if (f) failures.push({ n: f.n, title: `코드 + AI인데도 계산에 없는 숫자를 씀 (${md})`, raw: f.raw, detail: `AI 글의 "${f.unknown.join(', ')}"는 계산 결과에 없음 → 앱은 이런 경우 "숫자 검사" 경고를 띄움. 글: ${f.text.slice(0, 160)}…` });
  const g = detail[md].hybridFails.find((x) => x.missing.length && !failures.some((y) => y.n === x.n));
  if (g) failures.push({ n: g.n, title: `위험 요소를 빠뜨림 (${md}, 코드 + AI)`, raw: g.raw, detail: `빠진 위험 요소: ${g.missing.join(', ')} → 앱은 AI 글과 별개로 코드가 찾은 위험 요소 목록을 항상 함께 보여 줌.` });
}
summary.failures = failures.slice(0, 8);

const best = MODELS.map((md) => [md, summary.aiOnly[md].allCorrect]).sort((a, b) => b[1] - a[1])[0];
const pct = (x) => `${(x * 100).toFixed(0)}%`;
summary.headline = [
  { label: `AI 혼자: 9개 항목 모두 맞은 METAR (${best[0]})`, value: pct(best[1]) },
  { label: `AI 혼자: 날씨를 실제보다 좋게 본 위험한 오답 (${m0})`, value: `${summary.aiOnly[m0].optimistic}건` },
  { label: `코드 + AI: 4가지 검사 모두 통과 (${m0})`, value: pct(summary.hybrid[m0].allCorrect) },
];
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ aiOnly: summary.aiOnly, hybrid: summary.hybrid, cost: summary.cost }, null, 1));
