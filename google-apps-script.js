/**
 * Google Apps Script — paste into a new Apps Script project.
 * Set up a daily time-driven trigger to run syncNicbotData().
 *
 * Setup:
 * 1. Create a new Google Sheet
 * 2. Go to Extensions > Apps Script
 * 3. Paste this code
 * 4. Update SHEET_ID and API_KEY below
 * 5. Run syncNicbotData() once manually to create headers
 * 6. Add a trigger: Edit > Triggers > Add > syncNicbotData > Time-driven > Day timer > 6am-7am
 */

const CONFIG = {
  API_URL: 'https://nicbot-production-c9ea.up.railway.app/api/snapshot',
  API_KEY: 'nicbot-abc123xyz', // your API key
  SHEET_ID: 'YOUR_SHEET_ID_HERE', // replace with your Google Sheet ID
};

function syncNicbotData() {
  const options = {
    method: 'get',
    headers: { 'x-api-key': CONFIG.API_KEY },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(CONFIG.API_URL, options);
  if (response.getResponseCode() !== 200) {
    Logger.log('API error: ' + response.getContentText());
    return;
  }

  const data = JSON.parse(response.getContentText());
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // === "Latest" sheet — single row, overwritten each sync ===
  let latest = ss.getSheetByName('Latest');
  if (!latest) {
    latest = ss.insertSheet('Latest');
    latest.appendRow([
      'timestamp', 'day', 'phase', 'targetMg', 'targetCount',
      'intervalMin', 'todayCount', 'todayMg', 'overTarget',
      'avgDailyCount', 'lastUsed', 'daysUntilNext',
      'nextPhaseLabel', 'nextPhaseMg', 'nextPhaseInterval',
    ]);
  }

  // Clear previous data row and write fresh
  if (latest.getLastRow() > 1) latest.deleteRow(2);
  latest.appendRow([
    data.timestamp,
    data.day,
    data.phase,
    data.targetMg,
    data.targetCount,
    data.intervalMin,
    data.today.count,
    data.today.totalMg,
    data.today.overTarget,
    data.avgDailyCount,
    data.lastUsed,
    data.daysUntilNext,
    data.nextPhase?.label || '',
    data.nextPhase?.mg || '',
    data.nextPhase?.intervalMin || '',
  ]);

  // === "Weekly" sheet — one row per day from the week array ===
  let weekly = ss.getSheetByName('Weekly');
  if (!weekly) {
    weekly = ss.insertSheet('Weekly');
    weekly.appendRow(['date', 'count', 'totalMg', 'skipped', 'targetCount', 'phase']);
  }

  // Clear old weekly data and rewrite
  if (weekly.getLastRow() > 1) {
    weekly.getRange(2, 1, weekly.getLastRow() - 1, 6).clear();
  }

  data.week.forEach(day => {
    weekly.appendRow([
      day.date,
      day.count,
      day.totalMg,
      day.skipped,
      data.targetCount,
      data.phase,
    ]);
  });

  // === "History" sheet — append-only daily log ===
  let history = ss.getSheetByName('History');
  if (!history) {
    history = ss.insertSheet('History');
    history.appendRow([
      'syncDate', 'day', 'phase', 'targetCount', 'actualCount',
      'totalMg', 'overTarget', 'avgDailyCount',
    ]);
  }

  // Only append if we haven't already logged today
  const today = new Date().toISOString().split('T')[0];
  const lastRow = history.getLastRow();
  const lastDate = lastRow > 1 ? history.getRange(lastRow, 1).getValue() : '';

  if (lastDate !== today) {
    history.appendRow([
      today,
      data.day,
      data.phase,
      data.targetCount,
      data.today.count,
      data.today.totalMg,
      data.today.overTarget,
      data.avgDailyCount,
    ]);
  }

  Logger.log('Sync complete: Day ' + data.day + ', ' + data.today.count + '/' + data.targetCount + ' pouches');
}
