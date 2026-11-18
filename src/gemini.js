// Gemini API (REST). 키는 GEMINI_API_KEY 환경변수에서만 읽고 화면·기록에 남기지 않는다.
export class AiError extends Error {
  constructor(msg, status = 502) {
    super(msg);
    this.status = status;
  }
}

export const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

export class Gemini {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || FALLBACK_MODEL, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
  }
  get ready() {
    return !!this.apiKey;
  }
  // schema: Gemini responseSchema (OpenAPI 부분집합). JSON으로 받아 파싱해 돌려준다.
  async json({ system, prompt, schema, model = this.model, temperature = 0.2, maxTokens = 2048, timeoutMs = 60000 }) {
    if (!this.apiKey) throw new AiError('AI 키가 설정되지 않았습니다. 서버 환경변수 GEMINI_API_KEY를 넣어 주세요.', 503);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json', responseSchema: schema },
    };
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError') throw new AiError('AI 답이 너무 오래 걸립니다. 잠시 뒤 다시 시도해 주세요.', 504);
      throw new AiError('AI 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
    if (res.status === 429) throw new AiError('AI 무료 사용량을 잠시 다 썼습니다. 1분쯤 뒤 다시 시도해 주세요.', 429);
    if (res.status === 503) throw new AiError('AI 서버가 지금 붐빕니다. 잠시 뒤 다시 시도해 주세요.', 503);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new AiError(`AI 서버 오류 (${res.status})${t.includes('API key') ? ': 키를 확인해 주세요' : ''}`);
    }
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('') || '';
    if (!text) throw new AiError(`AI가 빈 답을 보냈습니다 (${j?.candidates?.[0]?.finishReason || j?.promptFeedback?.blockReason || '이유 모름'}).`);
    try {
      return { data: JSON.parse(text), usage: j.usageMetadata || null, model };
    } catch {
      throw new AiError('AI 답이 정해진 JSON 모양이 아닙니다.');
    }
  }
}
