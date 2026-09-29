// ai-skills-quiz — отдельное веб-приложение для проверки ИИ-грамотности AIC.
// Свой логин (регистрация по рабочей почте), свой sqlite, оценка кейсов через Ландев.
// Не связано с trends-card-generator и не требует входа через claude.ai.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');

const db = require('./db');
const D = require('./data');
const { gradeCase } = require('./grade');

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(cookieSession({
  name: 'sess',
  keys: [process.env.SESSION_SECRET || 'dev-secret-change-me'],
  maxAge: 60 * 24 * 60 * 60 * 1000, // 60 дней
  sameSite: 'lax',
}));

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
function isAdminEmail(email) { return ADMIN_EMAILS.has(String(email || '').toLowerCase()); }

// ---------- вспомогательные запросы к БД ----------
const stmts = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`INSERT INTO users (email, password_hash, full_name, roles, shuffle_seed, created_at)
                          VALUES (@email, @password_hash, @full_name, @roles, @shuffle_seed, @created_at)`),
  allUsers: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
  submissionByUser: db.prepare('SELECT * FROM submissions WHERE user_id = ?'),
  upsertSubmission: db.prepare(`
    INSERT INTO submissions (user_id, self_report, risk_answers, cases, points, case_scores, graded,
                              criteria_avg, overall_avg, overall_level, confidence_gap, submitted_at, updated_at)
    VALUES (@user_id, @self_report, @risk_answers, @cases, @points, @case_scores, @graded,
            @criteria_avg, @overall_avg, @overall_level, @confidence_gap, @submitted_at, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      self_report=excluded.self_report, risk_answers=excluded.risk_answers, cases=excluded.cases,
      points=excluded.points, case_scores=excluded.case_scores, graded=excluded.graded,
      criteria_avg=excluded.criteria_avg, overall_avg=excluded.overall_avg,
      overall_level=excluded.overall_level, confidence_gap=excluded.confidence_gap,
      updated_at=excluded.updated_at
  `),
  updateGraded: db.prepare(`
    UPDATE submissions SET case_scores=@case_scores, graded=1, points=@points,
      criteria_avg=@criteria_avg, overall_avg=@overall_avg, overall_level=@overall_level,
      confidence_gap=@confidence_gap, updated_at=@updated_at
    WHERE id=@id
  `),
  ungraded: db.prepare('SELECT * FROM submissions WHERE graded = 0'),
  allSubmissions: db.prepare('SELECT * FROM submissions'),
};

function publicUser(u) {
  return { id: u.id, email: u.email, fullName: u.full_name, roles: JSON.parse(u.roles), isAdmin: isAdminEmail(u.email) };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'нужно войти' });
  const u = stmts.userById.get(req.session.userId);
  if (!u) { req.session = null; return res.status(401).json({ error: 'нужно войти' }); }
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdminEmail(req.user.email)) return res.status(403).json({ error: 'доступно только руководству' });
  next();
}

// ---------- авторизация ----------
app.post('/api/register', (req, res) => {
  const { email, password, fullName, roles } = req.body || {};
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) return res.status(400).json({ error: 'некорректный email' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'пароль — минимум 6 символов' });
  if (!fullName || !String(fullName).trim()) return res.status(400).json({ error: 'укажите имя и фамилию' });
  const roleList = Array.isArray(roles) ? roles.filter(r => D.ROLES[r]) : [];
  if (roleList.length === 0) return res.status(400).json({ error: 'выберите хотя бы одну роль' });
  if (stmts.userByEmail.get(emailNorm)) return res.status(409).json({ error: 'этот email уже зарегистрирован — войдите' });

  const password_hash = bcrypt.hashSync(String(password), 10);
  const info = stmts.insertUser.run({
    email: emailNorm, password_hash, full_name: String(fullName).trim(),
    roles: JSON.stringify(roleList), shuffle_seed: crypto.randomInt(1, 2 ** 31 - 1),
    created_at: new Date().toISOString(),
  });
  req.session.userId = info.lastInsertRowid;
  res.json({ user: publicUser(stmts.userById.get(info.lastInsertRowid)) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = stmts.userByEmail.get(String(email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    return res.status(401).json({ error: 'неверный email или пароль' });
  }
  req.session.userId = u.id;
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- данные опросника под пользователя ----------
app.get('/api/quiz-data', requireAuth, (req, res) => {
  const roles = JSON.parse(req.user.roles);
  const cases = D.casesForRoles(roles).map(c => ({ id: c.id, roleKey: c.roleKey, criteria: c.criteria, prompt: c.prompt }));
  const riskQuestions = D.RISK_QUESTIONS.map(q => ({
    id: q.id, q: q.q,
    options: D.seededShuffle(q.options.map((o, i) => ({ idx: i, t: o.t, s: o.s })), req.user.shuffle_seed + q.id.charCodeAt(1)),
  }));
  res.json({
    criteria: D.CRITERIA, criteriaOrder: D.CRIT_ORDER, roles: D.ROLES,
    obstacles: D.OBSTACLES, toolsList: D.TOOLS_LIST,
    cases, riskQuestions,
  });
});

app.get('/api/submission', requireAuth, (req, res) => {
  const s = stmts.submissionByUser.get(req.user.id);
  if (!s) return res.json({ submission: null });
  res.json({ submission: serializeSubmission(s) });
});

function serializeSubmission(s) {
  return {
    selfReport: JSON.parse(s.self_report),
    riskAnswers: JSON.parse(s.risk_answers),
    cases: JSON.parse(s.cases),
    points: JSON.parse(s.points),
    caseScores: s.case_scores ? JSON.parse(s.case_scores) : null,
    graded: !!s.graded,
    criteriaAvg: JSON.parse(s.criteria_avg),
    overallAvg: s.overall_avg, overallLevel: s.overall_level, confidenceGap: s.confidence_gap,
    submittedAt: s.submitted_at, updatedAt: s.updated_at,
  };
}

app.post('/api/submission', requireAuth, (req, res) => {
  const { selfReport, riskAnswers, cases } = req.body || {};
  if (!selfReport || !Array.isArray(riskAnswers) || !Array.isArray(cases)) {
    return res.status(400).json({ error: 'неполные данные' });
  }
  // кейсы (промпт и критерии) берём из своих данных по роли пользователя, у клиента
  // забираем только текст ответа — так подмена критериев в запросе ничего не даёт
  const roles = JSON.parse(req.user.roles);
  const expectedCases = D.casesForRoles(roles);
  const resolvedCases = expectedCases.map(ec => {
    const submitted = cases.find(c => c.id === ec.id);
    return { id: ec.id, roleKey: ec.roleKey, criteria: ec.criteria, prompt: ec.prompt, answerText: submitted ? String(submitted.answerText || '') : '' };
  });

  // счёт и текст варианта берём из своих же данных по индексу, а не от клиента — так
  // сотрудник не может подделать себе балл, подменив score в запросе
  const resolvedRiskAnswers = riskAnswers.map(r => {
    const q = D.RISK_QUESTIONS.find(x => x.id === r.id);
    const opt = q && q.options[r.idx];
    return { id: r.id, idx: r.idx, choiceText: opt ? opt.t : null, score: opt ? opt.s : null, criterion: q ? q.criterion : null };
  });

  // риск-баллы — по критерию, самоотчёт (частота) — в process; остальное довесит грейдинг кейсов
  const points = { task: [], verify: [], safety: [], tool: [], process: [] };
  for (const r of resolvedRiskAnswers) {
    if (r.criterion && Number.isFinite(r.score)) points[r.criterion].push(r.score);
  }
  if (Number.isFinite(selfReport.frequency)) points.process.push(selfReport.frequency);

  const { criteriaAvg, overallAvg, overallLevel } = D.computeFromPoints(points);
  const confidenceGap = overallAvg !== null && Number.isFinite(selfReport.selfRating) ? selfReport.selfRating - overallAvg : null;

  const now = new Date().toISOString();
  const existing = stmts.submissionByUser.get(req.user.id);
  stmts.upsertSubmission.run({
    user_id: req.user.id,
    self_report: JSON.stringify(selfReport),
    risk_answers: JSON.stringify(resolvedRiskAnswers),
    cases: JSON.stringify(resolvedCases),
    points: JSON.stringify(points),
    case_scores: null,
    graded: 0,
    criteria_avg: JSON.stringify(criteriaAvg),
    overall_avg: overallAvg, overall_level: overallLevel, confidence_gap: confidenceGap,
    submitted_at: existing ? existing.submitted_at : now,
    updated_at: now,
  });
  res.json({ submission: serializeSubmission(stmts.submissionByUser.get(req.user.id)) });
});

// ---------- админ-панель ----------
app.get('/api/admin/submissions', requireAuth, requireAdmin, (req, res) => {
  const rows = stmts.allSubmissions.all();
  const out = rows.map(s => {
    const u = stmts.userById.get(s.user_id);
    return { user: { id: u.id, email: u.email, fullName: u.full_name, roles: JSON.parse(u.roles) }, ...serializeSubmission(s) };
  });
  res.json({ submissions: out });
});

app.get('/api/admin/export.csv', requireAuth, requireAdmin, (req, res) => {
  const rows = stmts.allSubmissions.all();
  const header = ['дата', 'email', 'имя', 'роли', 'статус', 'итог', ...D.CRIT_ORDER.map(k => D.CRITERIA[k].label),
    'частота использования', 'самооценка',
    'кейс1_вопрос', 'кейс1_ответ', 'кейс2_вопрос', 'кейс2_ответ', 'кейс3_вопрос', 'кейс3_ответ',
    'риск1_вопрос', 'риск1_ответ', 'риск1_балл', 'риск2_вопрос', 'риск2_ответ', 'риск2_балл',
    'риск3_вопрос', 'риск3_ответ', 'риск3_балл', 'риск4_вопрос', 'риск4_ответ', 'риск4_балл'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(';')];
  for (const s of rows) {
    const u = stmts.userById.get(s.user_id);
    const sub = serializeSubmission(s);
    const cases = sub.cases || [];
    const risks = sub.riskAnswers || [];
    const cell = [
      sub.submittedAt, u.email, u.full_name, JSON.parse(u.roles).map(r => D.ROLES[r]?.label || r).join(', '),
      sub.graded ? D.LEVEL_LABEL[sub.overallLevel] : 'ожидает оценки',
      sub.overallAvg != null ? sub.overallAvg.toFixed(2) : '',
      ...D.CRIT_ORDER.map(k => sub.criteriaAvg[k] != null ? sub.criteriaAvg[k].toFixed(2) : ''),
      sub.selfReport?.frequency, sub.selfReport?.selfRating,
    ];
    for (let i = 0; i < 3; i++) { cell.push(cases[i]?.prompt || '', cases[i]?.answerText || ''); }
    for (let i = 0; i < 4; i++) {
      const r = risks[i];
      const q = r ? D.RISK_QUESTIONS.find(x => x.id === r.id) : null;
      cell.push(q?.q || '', r?.choiceText || '', r?.score ?? '');
    }
    lines.push(cell.map(esc).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ai-skills-check.csv"');
  res.send('﻿' + lines.join('\n'));
});

// ---------- оценка кейсов (вызывается вручную/по расписанию, не самой страницей) ----------
app.post('/api/admin/grade', async (req, res) => {
  const token = process.env.GRADE_TOKEN;
  if (!token || req.headers['x-grade-token'] !== token) return res.status(401).json({ error: 'unauthorized' });

  const pending = stmts.ungraded.all();
  const results = [];
  for (const s of pending) {
    try {
      const cases = JSON.parse(s.cases);
      const points = JSON.parse(s.points);
      const caseScores = [];
      for (const c of cases) {
        const graded = await gradeCase({ caseText: c.prompt, criteria: c.criteria, answerText: c.answerText });
        caseScores.push({ caseId: c.id, criteria: graded.criteria });
        for (const k of c.criteria) points[k].push(graded.criteria[k].score);
      }
      const { criteriaAvg, overallAvg, overallLevel } = D.computeFromPoints(points);
      const selfReport = JSON.parse(s.self_report);
      const confidenceGap = overallAvg !== null && Number.isFinite(selfReport.selfRating) ? selfReport.selfRating - overallAvg : null;
      stmts.updateGraded.run({
        id: s.id, case_scores: JSON.stringify(caseScores), points: JSON.stringify(points),
        criteria_avg: JSON.stringify(criteriaAvg), overall_avg: overallAvg, overall_level: overallLevel,
        confidence_gap: confidenceGap, updated_at: new Date().toISOString(),
      });
      results.push({ userId: s.user_id, ok: true });
    } catch (e) {
      results.push({ userId: s.user_id, ok: false, error: e.message });
    }
  }
  res.json({ graded: results.length, results });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, hasLandevKey: Boolean(process.env.LANDEV_API_KEY), hasSessionSecret: Boolean(process.env.SESSION_SECRET), adminCount: ADMIN_EMAILS.size });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('ai-skills-quiz listening on', PORT));
