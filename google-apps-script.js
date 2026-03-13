/**
 * Google Apps Script — NicBot -> Google Sheets data-rich sync
 *
 * Pulls full export from NicBot API and builds:
 *   Raw Logs    — every event with computed columns
 *   Daily Summary — one row per day, formula-driven
 *   Phases      — static reference table
 *   Dashboard   — KPIs, line chart, time-of-day heatmap
 *
 * Setup:
 *   1. Create a new Google Sheet
 *   2. Extensions > Apps Script, paste this code
 *   3. Update CONFIG below (API_URL, API_KEY, SHEET_ID)
 *   4. Run syncNicbotData() once manually
 *   5. Add trigger: Triggers > syncNicbotData > Time-driven > Day timer
 */

const CONFIG = {
  API_URL: 'https://nicbot-production-c9ea.up.railway.app/api/export',
  API_KEY: 'nicbot-abc123xyz',
  SHEET_ID: '11cCHlvuDKWJKc1ms2eYvK5DBnZZnLKvV-W4i0ygT1D8',
};

const TAPER_START = '2026-03-10';
const TOTAL_TAPER_DAYS = 98;

const PHASES_DATA = [
  [1,  'Phase 1', 13, 6, 75],
  [15, 'Phase 2', 13, 4, 75],
  [29, 'Phase 3', 11, 4, 90],
  [43, 'Phase 4', 11, 2, 90],
  [57, 'Phase 5', 8,  2, 120],
  [71, 'Phase 6', 5,  2, 180],
  [85, 'Final',   4,  1, 240],
];

// ─── Main ──────────────────────────────────────────────

function syncNicbotData() {
  const res = UrlFetchApp.fetch(CONFIG.API_URL, {
    method: 'get',
    headers: { 'x-api-key': CONFIG.API_KEY },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('API error: ' + res.getContentText());
    return;
  }

  const data = JSON.parse(res.getContentText());
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const uniqueDates = [...new Set(data.logs.map(l => l.day))];

  buildPhasesTab(ss);
  buildRawLogsTab(ss, data.logs);
  buildDailySummaryTab(ss, uniqueDates);
  buildDashboardTab(ss, data, uniqueDates);

  Logger.log(
    'Sync complete: ' + data.logs.length + ' logs, ' +
    uniqueDates.length + ' days, Day ' + data.currentDay
  );
}

// ─── Phases (static reference) ─────────────────────────

function buildPhasesTab(ss) {
  const sheet = getOrCreateSheet(ss, 'Phases');
  sheet.clear();

  const rows = [
    ['Day Start', 'Phase', 'Daily Target', 'Target mg', 'Interval (min)'],
    ...PHASES_DATA,
  ];
  sheet.getRange(1, 1, rows.length, 5).setValues(rows);
  sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

// ─── Raw Logs ──────────────────────────────────────────

function buildRawLogsTab(ss, logs) {
  const sheet = getOrCreateSheet(ss, 'Raw Logs');
  sheet.clear();

  const headers = ['Timestamp', 'Type', 'mg', 'Day #', 'Gap (min)', 'Hour', 'Day of Week'];
  sheet.getRange(1, 1, 1, 7).setValues([headers]);
  sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (!logs.length) return;

  // Columns A-C: data values
  const values = logs.map(l => [
    new Date(l.timestamp.replace(' ', 'T') + 'Z'),
    l.type,
    l.mg || '',
  ]);
  sheet.getRange(2, 1, values.length, 3).setValues(values);

  // Columns D-G: formulas
  const formulas = logs.map((_, i) => {
    const r = i + 2;
    return [
      '=INT(A' + r + ')-DATE(2026,3,10)+1',
      i === 0 ? '=""' : '=ROUND((A' + r + '-A' + (r - 1) + ')*1440,1)',
      '=HOUR(A' + r + ')',
      '=TEXT(A' + r + ',"ddd")',
    ];
  });
  sheet.getRange(2, 4, formulas.length, 4).setFormulas(formulas);

  // Format timestamp column
  sheet.getRange(2, 1, values.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

// ─── Daily Summary ─────────────────────────────────────

function buildDailySummaryTab(ss, uniqueDates) {
  const sheet = getOrCreateSheet(ss, 'Daily Summary');
  sheet.clear();

  const headers = [
    'Date', 'Day #', 'Phase', 'Target Count', 'Target mg',
    'Actual Count', 'Actual mg', 'Delta', 'Skipped',
    'Avg Gap (min)', 'First Use', 'Last Use', 'At/Under Target',
  ];
  sheet.getRange(1, 1, 1, 13).setValues([headers]);
  sheet.getRange(1, 1, 1, 13).setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (!uniqueDates.length) return;

  // Column A: dates
  const dates = uniqueDates.map(d => [new Date(d + 'T00:00:00')]);
  sheet.getRange(2, 1, dates.length, 1).setValues(dates);
  sheet.getRange(2, 1, dates.length, 1).setNumberFormat('yyyy-mm-dd');

  // Columns B-M: formulas referencing Raw Logs and Phases
  var rl = "'Raw Logs'";
  const formulas = uniqueDates.map((_, i) => {
    const r = i + 2;
    return [
      // B: Day #
      '=INT(A' + r + ')-DATE(2026,3,10)+1',
      // C: Phase
      '=VLOOKUP(B' + r + ',Phases!A:B,2,TRUE)',
      // D: Target Count
      '=VLOOKUP(B' + r + ',Phases!A:C,3,TRUE)',
      // E: Target mg
      '=VLOOKUP(B' + r + ',Phases!A:D,4,TRUE)',
      // F: Actual Count (used + ping_used)
      '=COUNTIFS(' + rl + '!A:A,">="&A' + r + ',' + rl + '!A:A,"<"&A' + r + '+1,' + rl + '!B:B,"*used")',
      // G: Actual mg
      '=SUMIFS(' + rl + '!C:C,' + rl + '!A:A,">="&A' + r + ',' + rl + '!A:A,"<"&A' + r + '+1,' + rl + '!B:B,"*used")',
      // H: Delta
      '=F' + r + '-D' + r,
      // I: Skipped (skipped + ping_skipped)
      '=COUNTIFS(' + rl + '!A:A,">="&A' + r + ',' + rl + '!A:A,"<"&A' + r + '+1,' + rl + '!B:B,"*skipped")',
      // J: Avg Gap (min)
      '=IFERROR(AVERAGEIFS(' + rl + '!E:E,' + rl + '!A:A,">="&A' + r + ',' + rl + '!A:A,"<"&A' + r + '+1,' + rl + '!E:E,">0"),"")',
      // K: First Use
      '=IFERROR(TEXT(MINIFS(' + rl + '!A:A,' + rl + '!A:A,">="&A' + r + ',' + rl + '!A:A,"<"&A' + r + '+1,' + rl + '!B:B,"*used"),"hh:mm"),"")',
      // L: Last Use
      '=IFERROR(TEXT(MAXIFS(' + rl + '!A:A,' + rl + '!A:A,">="&A' + r + ',' + rl + '!A:A,"<"&A' + r + '+1,' + rl + '!B:B,"*used"),"hh:mm"),"")',
      // M: At/Under Target
      '=IF(F' + r + '<=D' + r + ',"' + "\u2705" + '","' + "\u274C" + '")',
    ];
  });
  sheet.getRange(2, 2, formulas.length, 12).setFormulas(formulas);
}

// ─── Dashboard ─────────────────────────────────────────

function buildDashboardTab(ss, data, uniqueDates) {
  const sheet = getOrCreateSheet(ss, 'Dashboard');
  sheet.clear();
  sheet.getCharts().forEach(c => sheet.removeChart(c));

  // ── KPIs ──
  const stats = computeStats(data.logs, uniqueDates);

  sheet.getRange('A1').setValue('NicBot Dashboard').setFontSize(18).setFontWeight('bold');

  const kpis = [
    ['Metric',              'Value',                                                       ''],
    ['Current Streak',      stats.streak,                                                  'days at/under target'],
    ['Skipped Cravings',    stats.totalSkipped,                                            'total resisted'],
    ['Phase Progress',      'Day ' + data.currentDay + ' of ' + TOTAL_TAPER_DAYS,          data.currentPhase],
    ['Avg Pouches (7d)',    stats.avgCountLast7.toFixed(1),                                'per day'],
    ['mg Reduction',        stats.mgReduction !== null ? stats.mgReduction.toFixed(0) + ' mg/day' : 'N/A', 'vs week 1 avg'],
    ['Total Pouches',       stats.totalUsed,                                               'all time'],
  ];
  sheet.getRange(3, 1, kpis.length, 3).setValues(kpis);
  sheet.getRange(3, 1, 1, 3).setFontWeight('bold');
  sheet.getRange(4, 1, kpis.length - 1, 1).setFontWeight('bold');
  sheet.getRange(4, 2, kpis.length - 1, 1).setFontSize(12);

  // ── Line chart: Daily Usage vs Target ──
  if (uniqueDates.length > 1) {
    var ds = ss.getSheetByName('Daily Summary');
    var n = uniqueDates.length + 1; // rows including header
    var chart = sheet.newChart()
      .setChartType(Charts.ChartType.LINE)
      .addRange(ds.getRange(1, 1, n, 1))   // A: Date (domain)
      .addRange(ds.getRange(1, 4, n, 1))   // D: Target Count
      .addRange(ds.getRange(1, 6, n, 1))   // F: Actual Count
      .setMergeStrategy(Charts.ChartMergeStrategy.MERGE_ALL)
      .setNumHeaders(1)
      .setPosition(11, 1, 0, 0)
      .setOption('title', 'Daily Usage vs Target')
      .setOption('useFirstColumnAsDomain', true)
      .setOption('hAxis.title', 'Date')
      .setOption('vAxis.title', 'Pouches')
      .setOption('width', 700)
      .setOption('height', 350)
      .setOption('series', { 0: { color: '#BDBDBD' }, 1: { color: '#1A73E8' } })
      .build();
    sheet.insertChart(chart);
  }

  // ── Heatmap: Usage by Hour x Day of Week ──
  var hmRow = 30;
  sheet.getRange(hmRow, 1).setValue('Usage by Hour & Day of Week').setFontWeight('bold').setFontSize(12);

  var dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  sheet.getRange(hmRow + 1, 1, 1, 8).setValues([['Hour'].concat(dayNames)]);
  sheet.getRange(hmRow + 1, 1, 1, 8).setFontWeight('bold');

  // Hour labels (column A)
  var hourLabels = [];
  for (var h = 0; h < 24; h++) hourLabels.push([h]);
  sheet.getRange(hmRow + 2, 1, 24, 1).setValues(hourLabels);

  // COUNTIFS formulas (columns B-H)
  var rl = "'Raw Logs'";
  var hmFormulas = [];
  for (var h = 0; h < 24; h++) {
    var row = [];
    for (var d = 0; d < dayNames.length; d++) {
      row.push(
        '=COUNTIFS(' + rl + '!F:F,' + h + ',' + rl + '!G:G,"' + dayNames[d] + '",' + rl + '!B:B,"*used")'
      );
    }
    hmFormulas.push(row);
  }
  sheet.getRange(hmRow + 2, 2, 24, 7).setFormulas(hmFormulas);

  // Gradient conditional formatting on heatmap cells
  var hmRange = sheet.getRange(hmRow + 2, 2, 24, 7);
  var rule = SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpoint('#FFFFFF')
    .setGradientMaxpoint('#E65100')
    .setRanges([hmRange])
    .build();
  sheet.setConditionalFormatRules([rule]);
}

// ─── Helpers ───────────────────────────────────────────

function getOrCreateSheet(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function computeStats(logs, uniqueDates) {
  // Per-day tallies
  var daily = {};
  for (var i = 0; i < logs.length; i++) {
    var l = logs[i];
    if (!daily[l.day]) daily[l.day] = { used: 0, mg: 0, skipped: 0 };
    if (l.type === 'used' || l.type === 'ping_used') {
      daily[l.day].used++;
      daily[l.day].mg += l.mg || 0;
    } else {
      daily[l.day].skipped++;
    }
  }

  // Target count for a given 1-indexed day number
  function targetForDay(dayNum) {
    var target = PHASES_DATA[0][2];
    for (var i = 0; i < PHASES_DATA.length; i++) {
      if (dayNum >= PHASES_DATA[i][0]) target = PHASES_DATA[i][2];
      else break;
    }
    return target;
  }

  // Streak: consecutive days at/under target from most recent day backwards
  var streak = 0;
  for (var i = uniqueDates.length - 1; i >= 0; i--) {
    var d = uniqueDates[i];
    var dayNum = daysBetween(TAPER_START, d) + 1;
    var target = targetForDay(dayNum);
    if ((daily[d] ? daily[d].used : 0) <= target) streak++;
    else break;
  }

  // Totals
  var totalSkipped = 0, totalUsed = 0;
  for (var i = 0; i < logs.length; i++) {
    if (logs[i].type.indexOf('skipped') >= 0) totalSkipped++;
    if (logs[i].type.indexOf('used') >= 0) totalUsed++;
  }

  // Last 7 days average count
  var last7 = uniqueDates.slice(-7);
  var sumLast7 = 0;
  for (var i = 0; i < last7.length; i++) sumLast7 += (daily[last7[i]] ? daily[last7[i]].used : 0);
  var avgCountLast7 = last7.length > 0 ? sumLast7 / last7.length : 0;

  // mg reduction: first 7 days avg vs last 7 days avg
  var first7 = uniqueDates.slice(0, 7);
  var sumMgFirst = 0, sumMgLast = 0;
  for (var i = 0; i < first7.length; i++) sumMgFirst += (daily[first7[i]] ? daily[first7[i]].mg : 0);
  for (var i = 0; i < last7.length; i++) sumMgLast += (daily[last7[i]] ? daily[last7[i]].mg : 0);
  var avgMgFirst = first7.length > 0 ? sumMgFirst / first7.length : null;
  var avgMgLast = last7.length > 0 ? sumMgLast / last7.length : null;
  var mgReduction = (avgMgFirst !== null && avgMgLast !== null) ? avgMgFirst - avgMgLast : null;

  return { streak: streak, totalSkipped: totalSkipped, totalUsed: totalUsed, avgCountLast7: avgCountLast7, mgReduction: mgReduction };
}

function daysBetween(startStr, endStr) {
  var start = new Date(startStr + 'T00:00:00Z');
  var end = new Date(endStr + 'T00:00:00Z');
  return Math.floor((end - start) / 86400000);
}
