// 프리플라이트 브리핑 서버: 기상 받기 → 코드 계산 → Gemini 설명
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WxService, InputError, cleanIcao } from './src/wx.js';
import { Gemini, AiError } from './src/gemini.js';
import { analyze, numberCheck, AIRCRAFT, aircraftOf } from './public/lib/core.js';
import { scenarios, checkRequired } from './public/lib/radio.js';
import { BRIEF_SYSTEM, BRIEF_SCHEMA, briefPrompt, ASK_SYSTEM, ASK_SCHEMA, RADIO_SYSTEM, RADIO_SCHEMA } from './src/prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(file = path.join(here, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] == null && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// 기체·내 옆바람 한계·기체 번호 (쿼리나 본문에서)
export function flightOpts(src = {}) {
  const aircraft = src.aircraft == null || src.aircraft === '' ? 'C172S' : String(src.aircraft);
  if (!AIRCRAFT[aircraft]) throw new InputError('기체를 목록에서 골라 주세요.');
  let personalXwindKt = 10;
  if (src.xwind != null && src.xwind !== '') {
    personalXwindKt = Number(src.xwind);
    if (!Number.isFinite(personalXwindKt) || personalXwindKt < 3 || personalXwindKt > 25) throw new InputError('내 옆바람 한계는 3~25kt로 넣어 주세요.');
  }
  let tail = 'N172SP';
  if (src.tail) {
    tail = String(src.tail).trim().toUpperCase();
    if (!/^N[0-9][0-9A-Z]{0,4}$/.test(tail)) throw new InputError('기체 번호는 N172SP처럼 N으로 시작해 주세요.');
  }
  return { aircraft, personalXwindKt, tail, call: aircraftOf(aircraft).call };
}

const str = (v, max) => {
  if (typeof v !== 'string' || !v.trim()) throw new InputError('내용이 비어 있습니다.');
  if (v.length > max) throw new InputError(`${max}자 이하로 줄여 주세요.`);
  return v.trim();
};

// 아주 단순한 IP별 사용량 제한 (무료 AI 한도 보호)
function limiter({ perMin = 6 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
    if (arr.length >= perMin) return res.status(429).json({ error: 'AI 요청이 너무 잦습니다. 1분쯤 뒤 다시 시도해 주세요.' });
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

export function createApp({ wx = new WxService(), ai = new Gemini(), aiPerMin = 6 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  const aiLimit = limiter({ perMin: aiPerMin });

  async function station(icao, o = {}) {
    const { metar, taf, airport } = await wx.station(icao);
    return { calc: analyze(metar, airport, o), tafRaw: taf?.rawTAF || null, airport: { name: airport.name?.trim() || metar.name, freqs: airport.freqs || null, tower: airport.tower === 'T' } };
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, ai: ai.ready ? ai.model : null }));

  // 코드 계산만 (빠름, AI 안 씀)
  app.get('/api/brief', async (req, res, next) => {
    try {
      const o = flightOpts(req.query);
      const dep = await station(cleanIcao(req.query.dep || 'KDVT'), o);
      const arr = req.query.arr ? await station(cleanIcao(req.query.arr), o) : null;
      const verdicts = [dep.calc.verdict, arr?.calc.verdict].filter(Boolean);
      const overall = verdicts.includes('NO-GO') ? 'NO-GO' : verdicts.includes('CAUTION') ? 'CAUTION' : 'GO';
      res.json({ dep, arr, overall, opts: o, aircraftList: Object.values(AIRCRAFT), scenarios: scenarios(dep.calc, dep.airport.name, o.tail, o.call) });
    } catch (e) {
      next(e);
    }
  });

  // AI 브리핑: 서버가 기상을 다시 받아 계산한 값만 AI에 넘긴다 (브라우저가 보낸 숫자는 믿지 않음)
  app.post('/api/brief/ai', aiLimit, async (req, res, next) => {
    try {
      const o = flightOpts(req.body);
      const dep = await station(cleanIcao(req.body?.dep || 'KDVT'), o);
      const arr = req.body?.arr ? await station(cleanIcao(req.body.arr), o) : null;
      const verdicts = [dep.calc.verdict, arr?.calc.verdict].filter(Boolean);
      const overall = verdicts.includes('NO-GO') ? 'NO-GO' : verdicts.includes('CAUTION') ? 'CAUTION' : 'GO';
      const t0 = Date.now();
      const { data, usage, model } = await ai.json({ system: BRIEF_SYSTEM, prompt: briefPrompt({ dep, arr, overall }), schema: BRIEF_SCHEMA });
      const all = [data.headline, data.verdictReason, ...(data.sections || []).map((s) => s.text), ...(data.risks || [])].join('\n');
      res.json({ brief: data, overall, unknownNumbers: numberCheck(all, [dep.calc, arr?.calc], [dep.tafRaw, arr?.tafRaw]), model, ms: Date.now() - t0, tokens: usage?.totalTokenCount ?? null });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/ask', aiLimit, async (req, res, next) => {
    try {
      const q = str(req.body?.question, 300);
      const o = flightOpts(req.body);
      const dep = await station(cleanIcao(req.body?.dep || 'KDVT'), o);
      const arr = req.body?.arr ? await station(cleanIcao(req.body.arr), o) : null;
      const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6).map((h) => `${h.role === 'user' ? '학생' : '도우미'}: ${String(h.text).slice(0, 600)}`).join('\n') : '';
      const prompt = `${briefPrompt({ dep, arr, overall: '(위 계산 결과 참고)' })}\n\n이전 대화:\n${history || '없음'}\n\n학생 질문: ${q}`;
      const { data } = await ai.json({ system: ASK_SYSTEM, prompt, schema: ASK_SCHEMA, temperature: 0.3 });
      res.json({ ...data, unknownNumbers: numberCheck(data.answer, [dep.calc, arr?.calc], [dep.tafRaw, arr?.tafRaw]) });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/radio', aiLimit, async (req, res, next) => {
    try {
      const transcript = str(req.body?.transcript, 400);
      const o = flightOpts(req.body);
      const dep = await station(cleanIcao(req.body?.dep || 'KDVT'), o);
      const scn = scenarios(dep.calc, dep.airport.name, o.tail, o.call).find((s) => s.id === req.body?.scenario);
      if (!scn) throw new InputError('연습 상황을 골라 주세요.');
      const checks = checkRequired(scn, transcript);
      const prompt = `상황: ${scn.situation}
관제사 말: ${scn.controller || '(학생이 먼저 부름)'}
모범 문장: ${scn.model}
학생이 말한 문장: "${transcript}"
코드 검사(필수 항목): ${checks.map((c) => `${c.k}=${c.ok ? '있음' : '없음'}`).join(', ')}`;
      const { data } = await ai.json({ system: RADIO_SYSTEM, prompt, schema: RADIO_SCHEMA, temperature: 0.2 });
      res.json({ checks, ...data, model: scn.model });
    } catch (e) {
      next(e);
    }
  });

  // 실험 결과 (scripts/eval.js가 만든 파일)
  app.get('/api/lab', (req, res) => {
    const f = path.join(here, 'evaluation', 'results', 'summary.json');
    if (!fs.existsSync(f)) return res.json({ ready: false });
    res.json({ ready: true, ...JSON.parse(fs.readFileSync(f, 'utf8')) });
  });

  app.use(express.static(path.join(here, 'public'), { extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소입니다.' }));

  app.use((err, req, res, next) => {
    if (err instanceof InputError) return res.status(400).json({ error: err.message });
    if (err instanceof AiError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON 형식이 올바르지 않습니다.' });
    console.error(err);
    res.status(502).json({ error: '기상 자료를 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const ai = new Gemini();
  const port = Number(process.env.PORT) || 3000;
  createApp({ ai }).listen(port, () => console.log(`프리플라이트 브리핑: http://localhost:${port} (AI: ${ai.ready ? ai.model : '키 없음'})`));
}
