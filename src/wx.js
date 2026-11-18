// aviationweather.gov Data API: METAR·TAF·공항 정보 (공개, 키 없음). 짧게 캐시한다.
const BASE = 'https://aviationweather.gov/api/data';
const UA = 'preflight-brief (student project)';

export class InputError extends Error {}

export function cleanIcao(s) {
  const v = String(s || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{3}$/.test(v)) throw new InputError('공항 코드는 KDVT처럼 4글자로 넣어 주세요.');
  return v;
}

export class WxService {
  constructor({ fetchImpl = fetch, ttlMs = 5 * 60 * 1000 } = {}) {
    this.fetch = fetchImpl;
    this.ttl = ttlMs;
    this.cache = new Map();
  }
  async getJson(path) {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.t < (path.startsWith('/airport') ? 24 * 3600e3 : this.ttl)) return hit.v;
    const res = await this.fetch(BASE + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (res.status === 204) return [];
    if (!res.ok) throw new Error(`기상 서버 응답 ${res.status}`);
    const v = await res.json();
    this.cache.set(path, { t: Date.now(), v });
    return v;
  }
  async station(icao) {
    const id = cleanIcao(icao);
    const [metars, tafs, airports] = await Promise.all([
      this.getJson(`/metar?ids=${id}&format=json`),
      this.getJson(`/taf?ids=${id}&format=json`).catch(() => []),
      this.getJson(`/airport?ids=${id}&format=json`).catch(() => []),
    ]);
    const metar = metars?.[0];
    if (!metar) throw new InputError(`${id}의 현재 METAR가 없습니다. 관측소가 있는 공항인지 확인해 주세요.`);
    return { metar, taf: tafs?.[0] || null, airport: airports?.[0] || {} };
  }
}
