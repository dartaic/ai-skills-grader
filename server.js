// ai-skills-grader — маленький изолированный сервис, который проксирует запросы на оценку
// открытых ответов (проверка ИИ-грамотности AIC) в тот же ландев-стенд, что использует
// trends-card-generator. Не читает и не пишет ничего из того сервиса, кроме одной
// переменной окружения LANDEV_API_KEY (передаётся через ссылку на переменную в Railway).
//
// POST /grade   { prompt, systemPrompt? }  ->  { ok:true, text }
// GET  /health  ->  { ok:true, hasKey, hasToken }
//
// Авторизация: заголовок x-grade-token должен совпадать с process.env.GRADE_TOKEN.

const express = require('express');
const app = express();
app.use(express.json({ limit: '256kb' }));

const LANDEV_BASE = process.env.LANDEV_BASE || 'https://gpt.lanit.dev/api/rest-adapter';
const LANDEV_ASSISTANT_ID = process.env.LANDEV_ASSISTANT_ID || 'c2552014-ab5e-11f1-99fd-c645def4f0dd';

function requireToken(req, res, next) {
  const token = process.env.GRADE_TOKEN;
  if (!token) return res.status(500).json({ error: 'GRADE_TOKEN не задан на сервере' });
  if (req.headers['x-grade-token'] !== token) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

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

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.LANDEV_API_KEY),
    hasToken: Boolean(process.env.GRADE_TOKEN),
  });
});

app.post('/grade', requireToken, async (req, res) => {
  try {
    const { prompt, systemPrompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt (строка) обязателен' });
    }
    const text = await callLandev({ prompt, systemPrompt });
    res.json({ ok: true, text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('ai-skills-grader listening on', PORT));
