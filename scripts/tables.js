// evaluation/results/summary.json의 숫자로 문서의 표를 채운다 (손으로 옮겨 적지 않기 위해).
// <!-- NAME --> ... <!-- /NAME --> 사이를 다시 쓴다. 처음엔 <!-- NAME --> 한 줄만 있어도 된다.
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync('evaluation/results/summary.json', 'utf8'));
const pct = (v) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);
const M = s.models;

const aiOnly = [
  `| 항목 | ${M.join(' | ')} |`,
  `|---|${M.map(() => '---').join('|')}|`,
  ...s.fields.map((f) => `| ${f.label} | ${M.map((m) => pct(s.aiOnly[m]?.fields[f.key])).join(' | ')} |`),
  `| **9개 모두 맞음** | ${M.map((m) => `**${pct(s.aiOnly[m]?.allCorrect)}**`).join(' | ')} |`,
  `| 날씨를 좋게 본 위험 오답 | ${M.map((m) => `${s.aiOnly[m]?.optimistic ?? '—'}건`).join(' | ')} |`,
  `| 채점한 METAR 수 | ${M.map((m) => s.aiOnly[m]?.answered ?? 0).join(' | ')} |`,
].join('\n');

const hybrid = [
  `| 검사 | ${M.join(' | ')} |`,
  `|---|${M.map(() => '---').join('|')}|`,
  ...s.briefChecks.map((f) => `| ${f.label} | ${M.map((m) => pct(s.hybrid[m]?.checks[f.key])).join(' | ')} |`),
  `| **4가지 모두 통과** | ${M.map((m) => `**${pct(s.hybrid[m]?.allCorrect)}**`).join(' | ')} |`,
  `| (참고) VFR 날씨까지 범주를 말함 | ${M.map((m) => pct(s.hybrid[m]?.categoryAny)).join(' | ')} |`,
  `| 채점한 브리핑 수 | ${M.map((m) => s.hybrid[m]?.answered ?? 0).join(' | ')} |`,
].join('\n');

const cost = [
  `| | ${M.join(' | ')} |`,
  `|---|${M.map(() => '---').join('|')}|`,
  `| AI 호출 수 (묶음) | ${M.map((m) => s.cost[m]?.calls ?? 0).join(' | ')} |`,
  `| 호출 1번 평균 시간 | ${M.map((m) => `${(s.cost[m]?.avgSec ?? 0).toFixed(1)}초`).join(' | ')} |`,
  `| 사용 토큰 합계 | ${M.map((m) => (s.cost[m]?.tokens ?? 0).toLocaleString('en-US')).join(' | ')} |`,
].join('\n');

const model = `**AI 혼자 해석 (METAR ${s.dataset.n}개, 코드 계산이 정답)**\n\n${aiOnly}\n\n**코드 + AI 브리핑 검사**\n\n${hybrid}\n\n**속도·비용** (실험은 METAR 10~20개를 한 번에 묶어 보냈다. 앱의 브리핑 1번은 공항 2곳이라 lite 기준 3~5초)\n\n${cost}`;

const results = [
  `실제 METAR ${s.dataset.n}개(미국 ${s.dataset.airports}개 공항, VFR 아래 ${s.dataset.nonVfr}개, 돌풍 ${s.dataset.gust}개). 코드의 비행 범주는 기상청 공식 범주와 **${s.dataset.officialMatch}** 일치해서 코드 계산을 정답으로 썼다.`,
  '',
  ...s.headline.map((h) => `- **${h.value}** — ${h.label}`),
  '',
  model,
].join('\n');

const blocks = { 'AI-ONLY': aiOnly, HYBRID: hybrid, COST: cost, 'MODEL-TABLE': model, RESULTS: results };

for (const file of ['README.md', 'model-selection.md', 'evaluation/report.md']) {
  let t = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(blocks)) {
    const re = new RegExp(`<!-- ${k} -->[\\s\\S]*?<!-- /${k} -->|<!-- ${k} -->`);
    t = t.replace(re, `<!-- ${k} -->\n${v}\n<!-- /${k} -->`);
  }
  fs.writeFileSync(file, t);
  console.log('채움:', file);
}
