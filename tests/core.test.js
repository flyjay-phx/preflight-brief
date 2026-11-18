import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze, flightCategory, ceilingFt, windComponents, densityAltitudeFt, parseVis, numberCheck, runwayEnds } from '../public/lib/core.js';
import { buildAtis, gradeAtis, scenarios, checkRequired, runwaySpoken, spell } from '../public/lib/radio.js';

const KDVT = { name: 'PHOENIX/PHOENIX DEER VALLEY', elev: 450, magdec: '12E', runways: [{ id: '07L/25R', dimension: '4500x75', alignment: 86 }, { id: '07R/25L', dimension: '8196x100', alignment: 86 }] };
const metar = (o) => ({ icaoId: 'KDVT', rawOb: 'METAR KDVT TEST', elev: 450, temp: 20, dewp: 5, altim: 1013.25, wdir: 250, wspd: 8, visib: '10+', clouds: [{ cover: 'CLR', base: null }], obsTime: 1795000000, ...o });

test('비행 범주와 운고: FAA 기준 경계값', () => {
  assert.equal(flightCategory(null, 10), 'VFR');
  assert.equal(flightCategory(3000, 10), 'MVFR');
  assert.equal(flightCategory(3100, 5), 'MVFR');
  assert.equal(flightCategory(999, 10), 'IFR');
  assert.equal(flightCategory(5000, 2.5), 'IFR');
  assert.equal(flightCategory(400, 10), 'LIFR');
  assert.equal(ceilingFt([{ cover: 'FEW', base: 800 }, { cover: 'SCT', base: 1500 }]), null); // FEW·SCT는 운고 아님
  assert.equal(ceilingFt([{ cover: 'SCT', base: 800 }, { cover: 'BKN', base: 2500 }, { cover: 'OVC', base: 1800 }]), 1800);
  assert.equal(parseVis('1 1/2'), 1.5);
  assert.equal(parseVis('10+'), 10);
  assert.equal(parseVis('P6SM'), 6);
});

test('바람 성분: 정면·직각·뒷바람과 좌우', () => {
  const head = windComponents(250, 10, 250);
  assert.ok(Math.abs(head.head - 10) < 1e-9 && Math.abs(head.cross) < 1e-9);
  assert.ok(Math.abs(windComponents(340, 10, 250).cross - 10) < 1e-9); // 오른쪽에서
  assert.ok(windComponents(160, 10, 250).cross < -9.9); // 왼쪽에서
  assert.ok(windComponents(70, 10, 250).head < -9.9); // 뒷바람
});

test('밀도 고도: 표준 대기면 표고와 같고, 더우면 높아진다', () => {
  assert.ok(Math.abs(densityAltitudeFt(0, 15, 29.92)) < 1);
  const hot = densityAltitudeFt(1478, 40, 29.92);
  assert.ok(hot > 4600 && hot < 5000, String(hot)); // 피닉스 여름 오후 40°C ≈ 4,800ft (근사식)
});

test('analyze: 디어밸리 서풍이면 25방향, 자북 보정, 위험 요소와 판정', () => {
  const c = analyze(metar({ wdir: 262, wspd: 8 }), KDVT); // 진북 262 → 자북 250
  assert.equal(c.windDirMag, 250);
  assert.match(c.bestRunway, /^25[LR]$/);
  assert.equal(c.bestRunway, '25L'); // 맞바람 같으면 긴 활주로
  assert.equal(c.verdict, 'GO');
  assert.equal(runwayEnds(KDVT.runways).length, 4);

  const gusty = analyze(metar({ wdir: 352, wspd: 18, wgst: 30 }), KDVT); // 활주로와 직각
  assert.equal(gusty.verdict, 'NO-GO');
  assert.ok(gusty.hazards.some((h) => h.code === 'XWIND' && h.level === 'stop'));
  assert.ok(gusty.hazards.some((h) => h.code === 'GUST'));

  const ifr = analyze(metar({ visib: '2', clouds: [{ cover: 'OVC', base: 700 }] }), KDVT);
  assert.equal(ifr.category, 'IFR');
  assert.equal(ifr.verdict, 'NO-GO');

  const hot = analyze(metar({ temp: 44, dewp: -5, altim: 1006 }), KDVT);
  assert.ok(hot.densityAltFt > 5000 && hot.hazards.some((h) => h.code === 'DA'));
});

test('숫자 검사: 계산·원문에 없는 숫자만 잡는다', () => {
  const c = analyze(metar({ wdir: 262, wspd: 8, rawOb: 'METAR KDVT 181053Z 26208KT 10SM CLR 20/05 A2992' }), KDVT);
  assert.deepEqual(numberCheck('바람 250도 8kt, 25L 맞바람 8kt', c), []);
  assert.deepEqual(numberCheck('옆바람이 17kt로 강합니다', c), ['17kt']);
  assert.deepEqual(numberCheck('예보상 돌풍 35kt', c, ['TAF KDVT 181120Z 1812/1912 25020G35KT P6SM SKC']), []);
});

test('실험 데이터: 코드 비행 범주가 기상청 공식 범주와 모두 같다', () => {
  const d = JSON.parse(fs.readFileSync(new URL('../data/metars.json', import.meta.url), 'utf8'));
  assert.equal(d.items.length, 200);
  const bad = d.items.filter((it) => analyze(it.metar, it.airport).category !== it.metar.fltCat);
  assert.equal(bad.length, 0, bad.map((b) => b.metar.rawOb).join('\n'));
});

test('무전: ATIS 문장·받아쓰기 채점·필수 항목 검사', () => {
  const c = analyze(metar({ wdir: 262, wspd: 8 }), KDVT);
  const a = buildAtis(c, KDVT.name);
  assert.match(a.text, /^Deer Valley information [A-Z][a-z]+/);
  assert.match(a.text, /wind two five zero at eight/);
  assert.match(a.text, /altimeter two niner niner two/);
  assert.match(a.text, /runway two five left/);
  const g = gradeAtis(a.answer, { letter: a.answer.letter, windDir: '250', windKt: '8', altim: '29.92', runway: '25L' });
  assert.equal(g.score, g.total);
  assert.equal(gradeAtis(a.answer, { letter: 'x', windDir: '200', windKt: '9', altim: '30.01', runway: '7R' }).score, 0);

  assert.equal(runwaySpoken('07R'), 'seven right');
  assert.equal(spell('172SP'), 'one seven two Sierra Papa');
  const s = scenarios(c, KDVT.name).find((x) => x.id === 'takeoff');
  assert.match(s.controller, /runway two five left, cleared for takeoff, make left closed traffic/);
  const ok = checkRequired(s, 'Runway two five left, cleared for takeoff, left closed traffic, Skyhawk two Sierra Papa');
  assert.ok(ok.every((x) => x.ok));
  const miss = checkRequired(s, 'cleared for takeoff');
  assert.equal(miss.filter((x) => !x.ok).length, 3);
});

test('기체별 판정: 같은 옆바람도 기종 한계·내 한계에 따라 달라진다', () => {
  // 활주로 07/25(자북 70/250)에 직각인 자북 340 바람 16kt → 옆바람 16kt
  const m = metar({ wdir: 352, wspd: 16, dewp: 6 }); // 기온·이슬점 차가 15가 되지 않게
  const c172 = analyze(m, KDVT, { aircraft: 'C172S' });
  const seminole = analyze(m, KDVT, { aircraft: 'PA44' });
  const sr20 = analyze(m, KDVT, { aircraft: 'SR20', personalXwindKt: 18 });
  assert.equal(c172.verdict, 'NO-GO'); // 시연 15kt 초과
  assert.equal(seminole.verdict, 'CAUTION'); // 시연 17kt 이내, 내 한계 10kt 초과
  assert.equal(sr20.verdict, 'GO'); // 시연 20kt, 내 한계 18kt 이내
  assert.equal(seminole.aircraft.multi, true);
  assert.match(seminole.aircraft.note, /Vmc 56kt/);
  // 숫자 검사는 고른 기체의 한계만 허용
  assert.deepEqual(numberCheck('세미놀 시연 옆바람 17kt, 내 한계 10kt', seminole), []);
  assert.deepEqual(numberCheck('세스나 시연 옆바람 15kt', seminole), ['15kt']);
});

test('무전 호출부호: 기종 이름과 기체 번호를 따른다', async () => {
  const { callsigns } = await import('../public/lib/radio.js');
  const c = callsigns('N4412K', 'Seminole');
  assert.equal(c.full, 'Seminole four four one two Kilo');
  assert.equal(c.short, 'Seminole one two Kilo');
  assert.ok(c.re.test('one two kilo'));
  assert.ok(!c.re.test('ready for departure'));
});
