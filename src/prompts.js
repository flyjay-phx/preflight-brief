// AI에게 주는 지시문과 답 모양(JSON 스키마)
export const BRIEF_SYSTEM = `너는 미국에서 비행 훈련을 받는 한국인 학생 조종사를 돕는 비행 전 브리핑 도우미다. 기체는 주어진 기종 기준으로 말한다(다발기면 한 엔진 고장 대비도 짚는다).
규칙:
- 숫자(바람·옆바람·운고·시정·밀도 고도 등)는 반드시 주어진 "계산 결과"의 값만 쓴다. 새로 계산하거나 지어내지 않는다.
- 판정(GO / CAUTION / NO-GO)은 코드가 정한 값을 바꾸지 않고, 왜 그런지 쉬운 한국어로 설명한다.
- 항공 약어는 처음 나올 때 한국어 뜻을 괄호로 붙인다. 예: BKN(구름 5/8~7/8).
- 최종 판단은 기장(PIC)과 교관이 한다는 점을 잊지 않게 한다. 과장하거나 겁주지 않는다.
- 숫자는 TAF 원문에 적힌 예보 값도 쓸 수 있다. 이때는 "예보"라고 밝힌다.
- 비행 범주 뜻: VFR(시계비행 가능), MVFR(한계 시계비행: 운고 1,000~3,000ft 또는 시정 3~5SM), IFR(계기비행 기상: 시계비행 불가), LIFR(낮은 계기비행 기상).
- 짧고 실용적으로. 각 문단 2~3문장.`;

export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '한 줄 요약 (40자 안팎)' },
    verdictReason: { type: 'string', description: '판정 이유 1~2문장' },
    sections: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
      description: '바람과 활주로 / 구름과 시정 / 성능(밀도 고도) / 도착지(있을 때) / 예보 변화',
    },
    risks: { type: 'array', items: { type: 'string' }, description: '조심할 점 0~4개' },
    checks: { type: 'array', items: { type: 'string' }, description: '출발 전 스스로 확인할 질문 2~3개' },
  },
  required: ['headline', 'verdictReason', 'sections', 'risks', 'checks'],
};

function stationBlock(label, s) {
  const c = s.calc;
  return `[${label}] ${c.station} ${c.name || ''}
METAR 원문: ${c.raw}
TAF 원문: ${s.tafRaw || '없음'}
계산 결과(JSON): ${JSON.stringify({
    category: c.category,
    verdict: c.verdict,
    aircraftDemoCrosswindKt: c.aircraft?.demoCrosswindKt,
    personalCrosswindLimitKt: c.personalXwindKt,
    elevFt: c.elevFt,
    windDirMag: c.windDirMag,
    windKt: c.windKt,
    gustKt: c.gustKt,
    variable: c.variable,
    visSm: c.visSm,
    ceilingFt: c.ceilingFt,
    clouds: c.clouds,
    weather: c.wx,
    tempC: c.tempC,
    dewC: c.dewC,
    altimInHg: c.altimInHg,
    densityAltFt: c.densityAltFt,
    bestRunway: c.bestRunway,
    runways: c.runways.map((r) => ({ id: r.id, headKt: r.headKt, crossKt: r.crossKt, crossFrom: r.crossFrom, gustCrossKt: r.gustCrossKt, lengthFt: r.lengthFt })),
    hazards: c.hazards.map((h) => h.text),
  })}`;
}

export function briefPrompt({ dep, arr, overall }) {
  const ac = dep.calc.aircraft;
  return `기체: ${ac.name} (시연 최대 옆바람 ${ac.demoCrosswindKt}kt${ac.multi ? ', 다발기' : ''}${ac.note ? ', ' + ac.note : ''}). 학생의 개인 옆바람 한계: ${dep.calc.personalXwindKt}kt. 전체 판정: ${overall}.
${stationBlock('출발', dep)}
${arr ? stationBlock('도착', arr) : '(도착지 없음: 출발 공항 장주 연습)'}

위 계산 결과로 한국어 비행 전 브리핑을 써라.`;
}

export const ASK_SYSTEM = `너는 한국인 학생 조종사의 질문에 답하는 비행 전 브리핑 도우미다.
- 주어진 브리핑 자료(계산 결과)의 숫자만 쓰고, 모르는 것은 모른다고 말한다.
- 규정이나 기체 한계는 일반적인 내용만 말하고 "POH와 교관 확인"을 권한다.
- 한국어로 3~6문장. 필요한 항공 영어 표현은 그대로 쓰고 뜻을 붙인다.`;
export const ASK_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, followUps: { type: 'array', items: { type: 'string' }, description: '이어서 물어볼 만한 질문 2개' } },
  required: ['answer', 'followUps'],
};

export const RADIO_SYSTEM = `너는 미국 관제 무전(FAA AIM 4장 표준 용어) 연습 코치다. 학생은 한국인이다.
학생이 말한 문장(음성 인식 결과라 철자가 틀릴 수 있음)을 상황과 모범 문장에 비교해 평가한다.
- 음성 인식 오타(예: "sky hawk", "too five left")는 너그럽게 보고, 빠진 정보·순서·불필요한 말을 본다.
- 코드가 이미 검사한 필수 항목 결과를 존중한다.
- 피드백은 한국어, 고친 문장은 영어.`;
export const RADIO_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', description: '0~100' },
    good: { type: 'array', items: { type: 'string' } },
    fix: { type: 'array', items: { type: 'string' }, description: '고칠 점 (한국어)' },
    better: { type: 'string', description: '고친 무전 문장 (영어)' },
  },
  required: ['score', 'good', 'fix', 'better'],
};
