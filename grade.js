// Вызов Ландева для оценки ответа на кейс по рубрике. Тот же способ авторизации
// (X-API-KEY, затем Authorization: Bearer), что и в исходном landev.js проекта.

const { CRITERIA } = require('./data');

const LANDEV_BASE = process.env.LANDEV_BASE || 'https://gpt.lanit.dev/api/rest-adapter';
const LANDEV_ASSISTANT_ID = process.env.LANDEV_ASSISTANT_ID || 'c2552014-ab5e-11f1-99fd-c645def4f0dd';

async function callLandev({ systemPrompt, prompt }) {
  const key = process.env.LANDEV_API_KEY;
  if (!key) throw new Error('LANDEV_API_KEY не задан в переменных окружения');
  const url = `${LANDEV_BASE}/external/assistant-config/neural/${LANDEV_ASSISTANT_ID}/structured`;
  const body = JSON.stringify({ prompt, systemPrompt: systemPrompt || undefined });
  const headerVariants = [{ 'X-API-KEY': key }, { Authorization: 'Bearer ' + key }];
  let last = 'неизвестная ошибка';
  for (const extraHeaders of headerVariants) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 170000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body,
      });
      clearTimeout(timeout);
      const text = await r.text();
      if (r.ok) {
        const d = JSON.parse(text);
        return (d.text || '').trim();
      }
      last = `${r.status}: ${text.slice(0, 300)}`;
      if (r.status !== 401 && r.status !== 403) break;
    } catch (e) {
      clearTimeout(timeout);
      last = e.name === 'AbortError' ? 'ландев не ответил за 170 секунд' : e.message;
      break;
    }
  }
  throw new Error('landev: ' + last);
}

const SYSTEM_PROMPT = `Ты — асессор в корпоративной проверке ИИ-грамотности сотрудников агентства AIC.
Оцениваешь один открытый ответ на рабочий кейс по заданным критериям, каждый по шкале 0–3.
Отвечай СТРОГО валидным JSON без пояснений вне JSON, форматом:
{"scores": {"<критерий>": {"score": 0-3, "comment": "1 короткое предложение по-русски"}}}
Учитывай только те критерии, что перечислены в задании. Будь доброжелателен, но честен: цель —
не наказать сотрудника, а показать реальный уровень для решения об обучении.`;

function buildPrompt({ caseText, criteria, answerText }) {
  const rubric = criteria.map(k => {
    const c = CRITERIA[k];
    return `### ${k} — ${c.label}\n0: ${c.anchors[0]}\n1: ${c.anchors[1]}\n2: ${c.anchors[2]}\n3: ${c.anchors[3]}`;
  }).join('\n\n');
  return `Кейс, который решал сотрудник:\n"""\n${caseText}\n"""\n\nОтвет сотрудника:\n"""\n${answerText || '(пусто — сотрудник не ответил)'}\n"""\n\nОцени ответ по следующим критериям и их шкалам:\n\n${rubric}\n\nВерни только JSON с ключами: ${criteria.join(', ')}.`;
}

// Оценивает один кейс, возвращает { criteria: { k: {score, comment} } }
async function gradeCase({ caseText, criteria, answerText }) {
  if (!answerText || !answerText.trim()) {
    const empty = {};
    criteria.forEach(k => { empty[k] = { score: 0, comment: 'ответ не был дан' }; });
    return { criteria: empty };
  }
  const prompt = buildPrompt({ caseText, criteria, answerText });
  const raw = await callLandev({ systemPrompt: SYSTEM_PROMPT, prompt });
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('landev вернул не-JSON: ' + raw.slice(0, 200));
  const parsed = JSON.parse(jsonMatch[0]);
  const scores = parsed.scores || parsed;
  const out = {};
  for (const k of criteria) {
    const entry = scores[k] || {};
    let score = Number(entry.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(0, Math.min(3, Math.round(score)));
    out[k] = { score, comment: String(entry.comment || '').slice(0, 400) };
  }
  return { criteria: out };
}

module.exports = { gradeCase, callLandev };
