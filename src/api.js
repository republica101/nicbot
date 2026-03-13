const express = require('express');
const { db, stmts } = require('./db');
const { getCurrentPhase, formatPhaseStatus, getDayNumber } = require('./taper');

const app = express();

// Simple API key auth
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!process.env.API_KEY || key === process.env.API_KEY) {
    next();
  } else {
    res.status(401).json({ error: 'unauthorized' });
  }
}

app.use(auth);

// Health check (no auth needed, override above)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Today's summary
app.get('/api/today', (_req, res) => {
  const phase = getCurrentPhase();
  const today = stmts.todayCount.get();
  const last = stmts.lastUsedTimestamp.get();
  const todayLogs = stmts.todayLogs.all();

  res.json({
    day: phase.day + 1,
    phase: phase.label,
    targetMg: phase.mg,
    targetCount: phase.dailyTarget,
    intervalMin: phase.intervalMin,
    actualCount: today.count,
    actualTotalMg: today.totalMg,
    overTarget: today.count > phase.dailyTarget,
    lastUsed: last?.timestamp || null,
    daysUntilNext: phase.daysUntilNext,
    nextPhase: phase.nextPhase ? {
      mg: phase.nextPhase.mg,
      intervalMin: phase.nextPhase.intervalMin,
    } : null,
    logs: todayLogs,
  });
});

// Weekly summary
app.get('/api/week', (_req, res) => {
  const phase = getCurrentPhase();
  const week = stmts.weekLogs.all();

  const avgCount = week.length > 0
    ? (week.reduce((sum, d) => sum + d.count, 0) / week.length).toFixed(1)
    : 0;

  res.json({
    phase: formatPhaseStatus(phase),
    days: week,
    avgDailyCount: parseFloat(avgCount),
    targetCount: phase.dailyTarget,
  });
});

// Full snapshot for external sync (Google Sheets, etc.)
app.get('/api/snapshot', (_req, res) => {
  const phase = getCurrentPhase();
  const today = stmts.todayCount.get();
  const week = stmts.weekLogs.all();
  const last = stmts.lastUsedTimestamp.get();

  const avgCount = week.length > 0
    ? (week.reduce((sum, d) => sum + d.count, 0) / week.length).toFixed(1)
    : 0;

  res.json({
    timestamp: new Date().toISOString(),
    day: phase.day + 1,
    phase: phase.label,
    targetMg: phase.mg,
    targetCount: phase.dailyTarget,
    intervalMin: phase.intervalMin,
    today: {
      count: today.count,
      totalMg: today.totalMg,
      overTarget: today.count > phase.dailyTarget,
    },
    week: week.map(d => ({
      date: d.day,
      count: d.count,
      totalMg: d.totalMg,
      skipped: d.skipped,
    })),
    avgDailyCount: parseFloat(avgCount),
    lastUsed: last?.timestamp || null,
    daysUntilNext: phase.daysUntilNext,
    nextPhase: phase.nextPhase ? {
      label: phase.nextPhase.label,
      mg: phase.nextPhase.mg,
      intervalMin: phase.nextPhase.intervalMin,
    } : null,
  });
});

// Full export for Google Sheets
app.get('/api/export', (_req, res) => {
  const allLogs = db.prepare(`
    SELECT
      id,
      timestamp,
      type,
      mg,
      date(timestamp) as day,
      strftime('%H', timestamp) as hour
    FROM logs
    ORDER BY timestamp ASC
  `).all();

  const phase = getCurrentPhase();

  res.json({
    exportedAt: new Date().toISOString(),
    taperStart: '2026-03-10',
    currentDay: phase.day + 1,
    currentPhase: phase.label,
    logs: allLogs,
  });
});

// Arbitrary range logs
app.get('/api/logs', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const logs = stmts.rangeLogs.all(`-${days}`);
  const phase = getCurrentPhase();

  res.json({
    phase: formatPhaseStatus(phase),
    days: logs,
    range: days,
  });
});

function start() {
  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`API server running on port ${port}`);
  });
}

module.exports = { app, start };
