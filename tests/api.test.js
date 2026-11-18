// 서버 API: 기상과 AI를 가짜로 바꿔 실제 HTTP 요청으로 확인한다 (외부 호출 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { AiError } from '../src/gemini.js';

const station = {
  metar: { icaoId: 'KDVT', rawOb: 'METAR KDVT 181053Z 04006KT 10SM CLR 09/05 A3010', elev: 450, temp: 9, dewp: 5, altim: 1019, wdir: 40, wspd: 6, visib: '10+', clouds: [{ cover: 'CLR' }], fltCat: 'VFR', obsTime: 1794999180 },
  taf: { rawTAF: 'TAF KDVT 181120Z 1812/1912 03005KT P6SM SKC' },
  airport: { name: 'PHOENIX/PHOENIX DEER VALLEY', elev: 450, magdec: '12E', runways: [{ id: '07L/25R', dimension: '4500x75' }, { id: '07R/25L', dimension: '8196x100' }] },
};
const wx = { station: async (id) => (id === 'KZZZ' ? Promise.reject(Object.assign(new (await import('../src/wx.js')).InputError('KZZZ의 현재 METAR가 없습니다.'))) : station) };

function fakeAi(data, seen = []) {
  return { ready: true, model: 'fake-model', json: async (req) => (seen.push(req), { data: typeof data === 'function' ? data(req) : data, usage: { totalTokenCount: 10 }, model: 'fake-model' }) };
}
async function boot(ai) {
  const app = createApp({ wx, ai, aiPerMin: 100 });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('브리핑: 코드 계산 결과와 무전 상황, 잘못된 공항 코드는 400', async () => {
  const { server, base } = await boot(fakeAi({}));
  try {
    const j = await (await fetch(`${base}/api/brief?dep=kdvt`)).json();
    assert.equal(j.dep.calc.category, 'VFR');
    assert.equal(j.dep.calc.bestRunway, '07R');
    assert.equal(j.overall, 'GO');
    assert.equal(j.scenarios.length, 3);
    assert.equal((await fetch(`${base}/api/brief?dep=12`)).status, 400);
    assert.equal((await fetch(`${base}/api/brief?dep=KZZZ`)).status, 400);
  } finally {
    server.close();
  }
});

test('AI 브리핑: 서버가 계산값을 넘기고, 계산에 없는 숫자를 잡아낸다', async () => {
  const seen = [];
  const ai = fakeAi({ headline: '좋음', verdictReason: '바람 6kt로 약함', sections: [{ title: '바람', text: '07R 맞바람 4.5kt, 옆바람 22kt' }], risks: [], checks: ['교관 확인'] }, seen);
  const { server, base } = await boot(ai);
  try {
    const r = await post(base, '/api/brief/ai', { dep: 'KDVT' });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.match(seen[0].prompt, /"bestRunway":"07R"/);
    assert.match(seen[0].prompt, /TAF 원문: TAF KDVT/);
    assert.deepEqual(j.unknownNumbers, ['22kt']);
  } finally {
    server.close();
  }
});

test('무전 평가: 코드 필수 항목 검사 + AI 피드백, 빈 문장은 400', async () => {
  const seen = [];
  const { server, base } = await boot(fakeAi({ score: 80, good: ['좋음'], fix: [], better: 'Runway seven right, cleared for takeoff' }, seen));
  try {
    const r = await post(base, '/api/radio', { scenario: 'takeoff', transcript: 'runway seven right cleared for takeoff skyhawk two sierra papa', dep: 'KDVT' });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.checks.find((c) => c.k.startsWith('활주로')).ok, true);
    assert.equal(j.checks.find((c) => /closed traffic/.test(c.k)).ok, false);
    assert.match(seen[0].prompt, /코드 검사/);
    assert.equal((await post(base, '/api/radio', { scenario: 'takeoff', transcript: ' ', dep: 'KDVT' })).status, 400);
    assert.equal((await post(base, '/api/radio', { scenario: 'nope', transcript: 'hi', dep: 'KDVT' })).status, 400);
  } finally {
    server.close();
  }
});

test('AI 실패는 꾸미지 않고 오류로 알린다 (429 그대로)', async () => {
  const ai = { ready: true, model: 'x', json: async () => { throw new AiError('AI 무료 사용량을 잠시 다 썼습니다.', 429); } };
  const { server, base } = await boot(ai);
  try {
    const r = await post(base, '/api/ask', { question: '옆바람?', dep: 'KDVT' });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /사용량/);
  } finally {
    server.close();
  }
});

test('기체 옵션: 잘못된 기체·한계·번호는 400, 세미놀이면 호출부호가 바뀐다', async () => {
  const { server, base } = await boot(fakeAi({}));
  try {
    assert.equal((await fetch(`${base}/api/brief?dep=KDVT&aircraft=B747`)).status, 400);
    assert.equal((await fetch(`${base}/api/brief?dep=KDVT&xwind=40`)).status, 400);
    assert.equal((await fetch(`${base}/api/brief?dep=KDVT&tail=HL1234`)).status, 400);
    const j = await (await fetch(`${base}/api/brief?dep=KDVT&aircraft=PA44&tail=N4412K&xwind=12`)).json();
    assert.equal(j.dep.calc.aircraft.id, 'PA44');
    assert.equal(j.dep.calc.personalXwindKt, 12);
    assert.match(j.scenarios[1].controller, /^Seminole one two Kilo, runway seven right/);
  } finally {
    server.close();
  }
});
