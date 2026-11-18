// 무전 연습: 실제 기상으로 ATIS와 관제 상황을 만들고, 말한 문장에 필수 항목이 있는지 코드로 먼저 검사한다.
const DIG = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
export const PHON = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu' };
export const digits = (n) => String(n).split('').map((c) => (c === '.' ? 'point' : DIG[+c] ?? c)).join(' ');
export const spell = (s) => String(s).toUpperCase().split('').map((c) => (/\d/.test(c) ? DIG[+c] : PHON[c] || c)).join(' ');

export function runwaySpoken(id) {
  const m = String(id).match(/^0?(\d{1,2})([LRC]?)$/);
  if (!m) return id;
  const side = { L: ' left', R: ' right', C: ' center' }[m[2]] || '';
  return digits(m[1]) + side;
}
export function facility(name = '', icao = '') {
  if (icao === 'KDVT') return 'Deer Valley';
  let n = String(name).split('/').pop().trim();
  n = n.replace(/\b(INTL|INTERNATIONAL|ARPT|AIRPORT|RGNL|REGIONAL|MUNI|MUNICIPAL|FLD|FIELD|EXEC|EXECUTIVE)\b/gi, '').replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  return n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) || icao;
}
export function callsigns(tail = 'N172SP', call = 'Skyhawk') {
  const t = String(tail || 'N172SP').toUpperCase().replace(/^N/, '');
  const full = `${call} ${spell(t)}`;
  const short = `${call} ${spell(t.slice(-3))}`;
  // 음성 인식 결과에서 호출부호를 찾는 정규식: 기종 이름, 또는 기체 번호 끝 두 글자의 음성 문자/숫자
  const tailWords = t.slice(-2).split('').map((ch) => (/\d/.test(ch) ? `(${DIG[+ch]}|${ch})` : `(${PHON[ch]}|${ch})`));
  const re = new RegExp(`${call.replace(/ /g, '\\s*')}|${tailWords.join('\\W*')}|${t}`, 'i');
  return { full, short, tail: 'N' + t, re };
}

const LETTERS = Object.values(PHON);
export function atisLetter(obsTime) {
  const h = Math.floor((obsTime || Date.now() / 1000) / 3600);
  return LETTERS[h % 26];
}

function windSpoken(c) {
  if (!c.windKt) return 'wind calm';
  const dir = c.variable ? 'variable' : digits(String(Math.round(c.windDirMag / 10) * 10 || 360).padStart(3, '0'));
  return `wind ${dir} at ${digits(c.windKt)}${c.gustKt ? `, gusts ${digits(c.gustKt)}` : ''}`;
}
function skySpoken(c) {
  if (!c.clouds?.length || ['CLR', 'SKC'].includes(c.clouds[0]?.cover)) return 'sky clear';
  const W = { FEW: 'few clouds at', SCT: 'scattered', BKN: 'ceiling broken', OVC: 'ceiling overcast', OVX: 'sky obscured' };
  return c.clouds
    .filter((l) => l.base != null)
    .map((l) => `${W[l.cover] || l.cover} ${l.base >= 1000 ? digits(Math.floor(l.base / 1000)) + ' thousand' : ''}${l.base % 1000 ? ' ' + digits((l.base % 1000) / 100) + ' hundred' : ''}`.trim())
    .join(', ');
}

// ATIS 문장과 받아쓰기 정답
export function buildAtis(c, airportName) {
  const letter = atisLetter(c.obsTime);
  const t = new Date((c.obsTime || Date.now() / 1000) * 1000);
  const z = String(t.getUTCHours()).padStart(2, '0') + String(t.getUTCMinutes()).padStart(2, '0');
  const rwy = c.bestRunway;
  const alt = c.altimInHg != null ? c.altimInHg.toFixed(2).replace('.', '') : null;
  const vis = c.visSm == null ? null : c.visSm >= 10 ? 10 : c.visSm;
  const parts = [
    `${facility(airportName, c.station)} information ${letter}`,
    `${digits(z)} zulu`,
    windSpoken(c),
    vis != null ? `visibility ${vis >= 10 ? 'one zero' : digits(vis)}` : null,
    skySpoken(c),
    c.tempC != null ? `temperature ${c.tempC < 0 ? 'minus ' : ''}${digits(Math.abs(Math.round(c.tempC)))}, dewpoint ${c.dewC < 0 ? 'minus ' : ''}${digits(Math.abs(Math.round(c.dewC)))}` : null,
    alt ? `altimeter ${digits(alt)}` : null,
    rwy ? `landing and departing runway ${runwaySpoken(rwy)}` : null,
    `advise on initial contact you have information ${letter}`,
  ].filter(Boolean);
  return {
    text: parts.join('. ') + '.',
    answer: {
      letter,
      windDir: c.variable ? 'VRB' : c.windKt ? Math.round(c.windDirMag / 10) * 10 || 360 : 0,
      windKt: c.windKt,
      gustKt: c.gustKt || null,
      visSm: vis,
      altim: c.altimInHg,
      runway: rwy,
      tempC: c.tempC != null ? Math.round(c.tempC) : null,
    },
  };
}

// 받아쓰기 채점 (코드)
export function gradeAtis(answer, input) {
  const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[^\d.\-]/g, '')));
  const items = [
    ['정보 문자', String(input.letter || '').trim().toLowerCase() === answer.letter.toLowerCase() || String(input.letter || '').trim().toUpperCase() === answer.letter[0]],
    ['풍향', answer.windDir === 'VRB' ? /v/i.test(input.windDir || '') : Math.abs((num(input.windDir) ?? -999) - answer.windDir) <= 0 || (answer.windKt === 0 && /calm|0/i.test(input.windDir || ''))],
    ['풍속', num(input.windKt) === answer.windKt],
    ['고도계', num(input.altim) != null && Math.abs(num(input.altim) - answer.altim) < 0.005 || num(input.altim) === Math.round(answer.altim * 100)],
    ['활주로', String(input.runway || '').replace(/^0/, '').toUpperCase() === String(answer.runway || '').replace(/^0/, '').toUpperCase()],
  ];
  return { items: items.map(([k, ok]) => ({ k, ok: !!ok })), score: items.filter((i) => i[1]).length, total: items.length };
}

// 관제 상황 3가지
export function scenarios(c, airportName, tail = 'N172SP', call = 'Skyhawk') {
  const fac = facility(airportName, c.station);
  const cs = callsigns(tail, call);
  const rwy = c.bestRunway || '25L';
  const rs = runwaySpoken(rwy);
  const letter = atisLetter(c.obsTime);
  const side = /R$/.test(rwy) ? 'right' : 'left';
  return [
    {
      id: 'taxi',
      title: '지상 관제에 첫 호출 (택시 요청)',
      situation: `${fac} 북쪽 램프에 서 있습니다. ATIS ${letter}를 들었고, 장주 연습(closed traffic)을 하려 합니다. 지상 관제(Ground)를 부르세요.`,
      controller: null,
      model: `${fac} Ground, ${cs.full}, north ramp, VFR closed traffic, with information ${letter}.`,
      required: [
        ['기관 이름(Ground)', new RegExp(`ground`, 'i')],
        ['내 호출부호', cs.re],
        ['내 위치', /ramp|parking|hangar/i],
        ['의도 (closed traffic)', /closed traffic|pattern|touch and go|local/i],
        [`ATIS 문자 (${letter})`, new RegExp(letter, 'i')],
      ],
    },
    {
      id: 'takeoff',
      title: '이륙 허가 복창 (readback)',
      situation: `활주로 ${rwy} 앞 대기 중. 관제탑이 이륙 허가를 줬습니다. 복창하세요.`,
      controller: `${cs.short}, runway ${rs}, cleared for takeoff, make ${side} closed traffic.`,
      model: `Runway ${rs}, cleared for takeoff, ${side} closed traffic, ${cs.short}.`,
      required: [
        [`활주로 (${rs})`, new RegExp(rs.replace(/ /g, '\\s*') + '|' + rwy.replace(/^0/, '').replace(/([LRC])$/, '\\s*$1'), 'i')],
        ['cleared for takeoff', /cleared (for )?take ?off/i],
        [`${side} closed traffic`, new RegExp(`${side}.*(closed|traffic|pattern)`, 'i')],
        ['내 호출부호', cs.re],
      ],
    },
    {
      id: 'downwind',
      title: '다운윈드 위치 보고',
      situation: `장주 다운윈드에 들어왔습니다. 관제탑에 위치와 의도(터치앤고)를 보고하세요.`,
      controller: null,
      model: `${fac} Tower, ${cs.short}, ${side} downwind runway ${rs}, touch and go.`,
      required: [
        ['기관 이름(Tower)', /tower/i],
        ['내 호출부호', cs.re],
        [`${side} downwind`, new RegExp(`${side}\\s*down ?wind`, 'i')],
        [`활주로 (${rs})`, new RegExp(rs.replace(/ /g, '\\s*') + '|' + rwy.replace(/^0/, '').replace(/([LRC])$/, '\\s*$1'), 'i')],
        ['touch and go', /touch (and|&|n) ?go/i],
      ],
    },
  ];
}

export function checkRequired(scn, transcript) {
  return scn.required.map(([k, re]) => ({ k, ok: re.test(transcript) }));
}
