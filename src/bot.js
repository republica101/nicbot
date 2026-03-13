const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { stmts } = require('./db');
const { getCurrentPhase, formatPhaseStatus, PHASES } = require('./taper');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const USER_ID = process.env.DISCORD_USER_ID;
let pingTimeout = null;
let pendingMgReply = null; // tracks DM channel awaiting mg follow-up

// --- Helpers ---

function getUser() {
  return client.users.cache.get(USER_ID);
}

async function sendDM(content) {
  const user = getUser();
  if (!user) return null;
  try {
    const dm = await user.createDM();
    return await dm.send(content);
  } catch (err) {
    console.error('Failed to send DM:', err.message);
    return null;
  }
}

function formatTimeSince(isoString) {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}min ago`;
  const hrs = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hrs}h${remainMin}min ago`;
}

function todaySummary() {
  const phase = getCurrentPhase();
  const today = stmts.todayCount.get();
  const last = stmts.lastUsedTimestamp.get();
  const count = today.count;
  const target = phase.dailyTarget;
  const indicator = count > target ? '🔴' : count === target ? '🟡' : '🟢';

  return `${indicator} ${count}/${target} today | ${phase.mg}mg | last: ${formatTimeSince(last?.timestamp)}`;
}

function getStreak() {
  const phase = getCurrentPhase();
  const days = stmts.dailyUseCounts.all();
  const today = new Date().toISOString().split('T')[0];
  let streak = 0;

  for (let i = 0; i < days.length; i++) {
    const row = days[i];
    // Skip today (incomplete day)
    if (i === 0 && row.day === today) {
      if (row.count <= phase.dailyTarget) streak++;
      continue;
    }
    if (row.count <= phase.dailyTarget) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function getAvgGapMin(timestamps) {
  if (timestamps.length < 2) return null;
  let totalGap = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const prev = new Date(timestamps[i - 1].timestamp + 'Z').getTime();
    const curr = new Date(timestamps[i].timestamp + 'Z').getTime();
    totalGap += curr - prev;
  }
  return Math.round(totalGap / (timestamps.length - 1) / 60000);
}

function progressBar(current, total, width = 10) {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(empty, 0));
}

function mgBudgetRemaining() {
  const phase = getCurrentPhase();
  const today = stmts.todayCount.get();
  const remaining = Math.max(phase.dailyTarget - today.count, 0);
  const mgLeft = remaining * phase.mg;
  return { remaining, mgLeft };
}

let endOfDayTimeout = null;

function scheduleEndOfDay() {
  if (endOfDayTimeout) clearTimeout(endOfDayTimeout);

  const now = new Date();
  const eod = new Date(now);
  const eodHour = parseInt(process.env.EOD_HOUR || '22'); // default 10pm
  eod.setHours(eodHour, 0, 0, 0);
  if (eod <= now) eod.setDate(eod.getDate() + 1);

  const delay = eod - now;
  console.log(`End-of-day summary scheduled in ${Math.round(delay / 3600000)}h`);

  endOfDayTimeout = setTimeout(async () => {
    const phase = getCurrentPhase();
    const today = stmts.todayCount.get();
    const streak = getStreak();
    const todayTs = stmts.todayUseTimestamps.all();
    const avgGap = getAvgGapMin(todayTs);
    const skips = stmts.weekSkipCount.get();

    let msg = `🌙 **End of Day Summary — Day ${phase.day + 1}**\n`;
    msg += `${todaySummary()}\n`;
    msg += `Streak: ${streak} day${streak !== 1 ? 's' : ''} at/under target\n`;
    if (avgGap) msg += `Avg gap between pouches: ${avgGap}min\n`;
    if (skips.count > 0) msg += `Cravings resisted this week: ${skips.count}\n`;

    if (today.count <= phase.dailyTarget) {
      msg += `\nNice work today.`;
    } else {
      const over = today.count - phase.dailyTarget;
      msg += `\n${over} over target today. Tomorrow's a new day.`;
    }

    await sendDM(msg);
    scheduleEndOfDay(); // schedule next
  }, delay);
}

async function checkMilestones() {
  const phase = getCurrentPhase();
  const today = stmts.todayCount.get();
  const streak = getStreak();
  const messages = [];

  const checks = [
    { key: 'day_1', condition: phase.day >= 0, msg: `🎉 **Day 1!** The taper begins. You got this.` },
    { key: 'day_7', condition: phase.day >= 6, msg: `🎉 **One week in!** 7 days of taper complete.` },
    { key: 'day_14', condition: phase.day >= 13, msg: `🎉 **Two weeks!** Halfway through the first month.` },
    { key: 'day_30', condition: phase.day >= 29, msg: `🎉 **30 days!** A full month of tapering.` },
    { key: 'streak_3', condition: streak >= 3, msg: `🔥 **3-day streak!** Three days at/under target in a row.` },
    { key: 'streak_7', condition: streak >= 7, msg: `🔥 **7-day streak!** A full week at/under target!` },
    { key: 'streak_14', condition: streak >= 14, msg: `🔥 **14-day streak!** Two weeks of discipline.` },
    { key: 'under_50mg', condition: today.totalMg > 0 && today.totalMg < 50, msg: `💪 **Under 50mg today!** First time below 50mg in a day.` },
    { key: 'phase_2', condition: phase.label === 'Phase 2', msg: `⬇️ **Phase 2 unlocked!** Stepping down to ${phase.mg}mg.` },
    { key: 'phase_3', condition: phase.label === 'Phase 3', msg: `⬇️ **Phase 3!** Intervals widening to ${phase.intervalMin}min.` },
    { key: 'phase_4', condition: phase.label === 'Phase 4', msg: `⬇️ **Phase 4!** Down to ${phase.mg}mg.` },
    { key: 'phase_5', condition: phase.label === 'Phase 5', msg: `⬇️ **Phase 5!** 2-hour intervals now.` },
    { key: 'phase_6', condition: phase.label === 'Phase 6', msg: `⬇️ **Phase 6!** 3-hour intervals. Almost there.` },
    { key: 'final', condition: phase.label === 'Final', msg: `🏁 **Final phase!** 1mg, 4 per day. The finish line is in sight.` },
  ];

  for (const { key, condition, msg } of checks) {
    if (condition && !stmts.getMilestone.get(key)) {
      stmts.setMilestone.run(key);
      messages.push(msg);
    }
  }

  return messages;
}

// --- Ping Scheduling (fires X min after last use) ---

function schedulePing() {
  if (pingTimeout) clearTimeout(pingTimeout);

  const phase = getCurrentPhase();
  const intervalMs = phase.intervalMin * 60 * 1000;

  // Calculate delay based on last use time
  const last = stmts.lastUsedTimestamp.get();
  let delay = intervalMs;
  if (last?.timestamp) {
    const elapsed = Date.now() - new Date(last.timestamp + 'Z').getTime();
    delay = Math.max(intervalMs - elapsed, 0);
  }

  console.log(`Next ping in ${Math.round(delay / 60000)}min (interval: ${phase.intervalMin}min)`);

  pingTimeout = setTimeout(async () => {
    const currentPhase = getCurrentPhase();
    const today = stmts.todayCount.get();

    stmts.logPing.run();

    const msg = await sendDM(
      `⏰ **${currentPhase.intervalMin}min since last** — pouch? (today: ${today.count}/${currentPhase.dailyTarget}, ${currentPhase.mg}mg)\n\n✅ = used | ⏭️ = skipped`
    );

    if (msg) {
      await msg.react('✅');
      await msg.react('⏭️');
    }

    // Schedule next ping (will wait full interval since no new use happened)
    schedulePing();
  }, delay);
}

// --- Server Command Handler ---

client.on('messageCreate', async (message) => {
  // !nictest in a server channel — fires a test DM
  if (message.guild && message.author.id === USER_ID && message.content.trim().toLowerCase() === '!nictest') {
    const phase = getCurrentPhase();
    const today = stmts.todayCount.get();
    const dm = await sendDM(
      `🧪 **Test ping** — NicBot is alive\n${formatPhaseStatus(phase)}\n${todaySummary()}`
    );
    if (dm) {
      await message.reply('✅ Test DM sent');
    } else {
      await message.reply('❌ Failed to send DM — check bot permissions');
    }
    return;
  }

  // Ignore all other server messages
  if (message.guild) return;

  // Only respond to DMs from the target user
  if (message.author.id !== USER_ID) return;

  const content = message.content.trim().toLowerCase();
  const phase = getCurrentPhase();

  // --- Handle pending mg follow-up from ping reaction ---
  if (pendingMgReply) {
    const elapsed = Date.now() - pendingMgReply.since;
    // Expire after 5 minutes
    if (elapsed > 5 * 60 * 1000) {
      pendingMgReply = null;
    } else {
      pendingMgReply = null;
      const mgMatch = content.match(/^(\d+)/);
      const mg = mgMatch ? parseInt(mgMatch[1]) : phase.mg;
      stmts.logUse.run('ping_used', mg, null);
      schedulePing(); // reset ping timer after use

      let reply = `📝 Logged ${mg}mg | ${todaySummary()}`;
      if (mg > phase.mg) {
        reply += `\n⚠️ Target is ${phase.mg}mg this phase`;
      }

      const milestones = await checkMilestones();
      if (milestones.length > 0) reply += '\n\n' + milestones.join('\n');

      await message.reply(reply);
      return;
    }
  }

  // --- Log a pouch: "1", "1 6", "1 4mg", "2", "2 4", etc ---
  const useMatch = content.match(/^(\d+)\s*(\d+)?\s*(mg)?$/);
  if (useMatch) {
    const count = parseInt(useMatch[1]);
    const mg = useMatch[2] ? parseInt(useMatch[2]) : phase.mg;

    // Check if logging early (before interval is up)
    const last = stmts.lastUsedTimestamp.get();
    let earlyWarning = '';
    if (last?.timestamp) {
      const elapsed = Date.now() - new Date(last.timestamp + 'Z').getTime();
      const intervalMs = phase.intervalMin * 60 * 1000;
      const remaining = intervalMs - elapsed;
      if (remaining > 60000) { // more than 1 min early
        const minLeft = Math.round(remaining / 60000);
        earlyWarning = `\n⏳ That's ${minLeft}min early — can you wait a bit longer?`;
      }
    }

    for (let i = 0; i < count; i++) {
      stmts.logUse.run('used', mg, null);
    }

    schedulePing(); // reset ping timer after use

    const today = stmts.todayCount.get();
    let reply = `📝 Logged ${count}x ${mg}mg | ${todaySummary()}`;

    // Flag if wrong strength
    if (mg > phase.mg) {
      reply += `\n⚠️ Target is ${phase.mg}mg this phase`;
    }
    reply += earlyWarning;

    // Check milestones
    const milestones = await checkMilestones();
    if (milestones.length > 0) reply += '\n\n' + milestones.join('\n');

    await message.reply(reply);
    return;
  }

  // --- Skip ---
  if (content === 'skip' || content === 's') {
    stmts.logUse.run('skipped', null, null);
    await message.reply(`⏭️ Skipped craving logged | ${todaySummary()}`);
    return;
  }

  // --- Undo ---
  if (content === 'undo' || content === 'u') {
    const last = stmts.getLastLog.get();
    if (last) {
      stmts.undoLast.run();
      await message.reply(`↩️ Removed last entry (${last.type}${last.mg ? ` ${last.mg}mg` : ''}) | ${todaySummary()}`);
    } else {
      await message.reply('Nothing to undo.');
    }
    return;
  }

  // --- Status ---
  if (content === 'status' || content === 'st') {
    const phaseStatus = formatPhaseStatus(phase);
    const summary = todaySummary();
    const last = stmts.lastUsedTimestamp.get();
    const streak = getStreak();
    const budget = mgBudgetRemaining();

    // Phase progress bar
    const totalDays = PHASES[PHASES.length - 1].startDay + 14; // final phase + 2 weeks
    const phaseDaysIn = phase.day - phase.startDay;
    const phaseDaysTotal = phase.nextPhase ? phase.nextPhase.startDay - phase.startDay : 14;

    let reply = `📊 **Status**\n${phaseStatus}\n`;
    reply += `Phase: ${progressBar(phaseDaysIn, phaseDaysTotal)} ${phaseDaysIn}/${phaseDaysTotal} days\n`;
    reply += `Overall: ${progressBar(phase.day, totalDays)} Day ${phase.day + 1}/${totalDays}\n`;
    reply += `${summary}\n`;
    if (last) reply += `Last pouch: ${formatTimeSince(last.timestamp)}\n`;
    reply += `Streak: ${streak} day${streak !== 1 ? 's' : ''} at/under target\n`;
    reply += `Budget: ${budget.remaining} pouches left (${budget.mgLeft}mg)`;

    await message.reply(reply);
    return;
  }

  // --- Stats (weekly) ---
  if (content === 'stats' || content === 'week') {
    const week = stmts.weekLogs.all();
    if (week.length === 0) {
      await message.reply('No data yet.');
      return;
    }

    let reply = '📈 **Last 7 days**\n```\n';
    reply += 'Date       | Used | mg   | Skips\n';
    reply += '-----------|------|------|------\n';

    for (const row of week) {
      const d = row.day.slice(5); // MM-DD
      reply += `${d.padEnd(10)} | ${String(row.count).padStart(4)} | ${String(row.totalMg).padStart(4)} | ${String(row.skipped).padStart(5)}\n`;
    }
    reply += '```';

    // Weekly comparison
    const thisWeek = stmts.thisWeekTotal.get();
    const lastWeek = stmts.lastWeekTotal.get();
    if (lastWeek.count > 0) {
      const countDiff = thisWeek.count - lastWeek.count;
      const mgDiff = thisWeek.totalMg - lastWeek.totalMg;
      const sign = (n) => n > 0 ? `+${n}` : `${n}`;
      reply += `\nvs last week: ${sign(countDiff)} pouches, ${sign(mgDiff)}mg`;
    }

    // Craving resistance
    const skips = stmts.weekSkipCount.get();
    if (skips.count > 0) {
      reply += `\n💪 Resisted ${skips.count} craving${skips.count !== 1 ? 's' : ''} this week`;
    }

    await message.reply(reply);
    return;
  }

  // --- Graph (last 24h mg timeline) ---
  if (content === 'graph' || content === 'g') {
    const uses = stmts.last24hUses.all();
    if (uses.length === 0) {
      await message.reply('No usage in the last 24 hours.');
      return;
    }

    // Build hourly buckets
    const now = new Date();
    const buckets = new Array(24).fill(0);
    const bucketCounts = new Array(24).fill(0);

    for (const row of uses) {
      const t = new Date(row.timestamp + 'Z');
      const hoursAgo = Math.floor((now - t) / 3600000);
      const idx = 23 - Math.min(hoursAgo, 23);
      buckets[idx] += row.mg || 0;
      bucketCounts[idx]++;
    }

    const maxMg = Math.max(...buckets, 1);
    const barHeight = 6;

    let chart = '📊 **Last 24h — mg per hour**\n```\n';

    // Rows top to bottom
    for (let row = barHeight; row >= 1; row--) {
      const threshold = (row / barHeight) * maxMg;
      let line = `${String(Math.round(threshold)).padStart(3)}│`;
      for (let col = 0; col < 24; col++) {
        line += buckets[col] >= threshold ? '█' : ' ';
      }
      chart += line + '\n';
    }

    // X-axis
    chart += '   └' + '─'.repeat(24) + '\n';

    // Hour labels (every 6h)
    const hourLabels = '    ';
    const labelParts = [];
    for (let i = 0; i < 24; i++) {
      const h = new Date(now - (23 - i) * 3600000);
      if (i % 6 === 0) {
        labelParts.push(String(h.getHours()).padStart(2, '0'));
      } else if (i % 6 === 1 && i > 0) {
        // skip — part of the 2-char label
      } else {
        labelParts.push(' ');
      }
    }
    chart += '    ' + labelParts.join('') + '\n';

    // Summary line
    const totalMg = buckets.reduce((a, b) => a + b, 0);
    const totalCount = bucketCounts.reduce((a, b) => a + b, 0);
    chart += `\nTotal: ${totalCount} pouches, ${totalMg}mg`;
    chart += '```';

    await message.reply(chart);
    return;
  }

  // --- Insights (avg gap, time-of-day breakdown) ---
  if (content === 'insights' || content === 'i') {
    const todayTs = stmts.todayUseTimestamps.all();
    const weekTs = stmts.weekUseTimestamps.all();
    const tod = stmts.timeOfDayBreakdown.get();

    let reply = '🔍 **Insights (last 7 days)**\n';

    // Today's avg gap
    const todayGap = getAvgGapMin(todayTs);
    if (todayGap) {
      reply += `\nToday's avg gap: **${todayGap}min** (target: ${phase.intervalMin}min)`;
      if (todayGap >= phase.intervalMin) reply += ' ✅';
      else reply += ` — ${phase.intervalMin - todayGap}min short`;
    }

    // Weekly avg gap
    // Group timestamps by day and compute avg gap per day
    const byDay = {};
    for (const row of weekTs) {
      const day = row.timestamp.split('T')[0] || row.timestamp.split(' ')[0];
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(row);
    }
    const dailyGaps = [];
    for (const [, rows] of Object.entries(byDay)) {
      const gap = getAvgGapMin(rows);
      if (gap) dailyGaps.push(gap);
    }
    if (dailyGaps.length > 0) {
      const avgWeekGap = Math.round(dailyGaps.reduce((a, b) => a + b, 0) / dailyGaps.length);
      reply += `\nWeek avg gap: **${avgWeekGap}min**`;
    }

    // Time of day breakdown
    if (tod) {
      const total = (tod.morning || 0) + (tod.afternoon || 0) + (tod.evening || 0) + (tod.night || 0);
      if (total > 0) {
        reply += `\n\n**When you use most:**\n`;
        const periods = [
          { label: 'Morning (6-12)', count: tod.morning || 0 },
          { label: 'Afternoon (12-6)', count: tod.afternoon || 0 },
          { label: 'Evening (6-12)', count: tod.evening || 0 },
          { label: 'Night (12-6)', count: tod.night || 0 },
        ];
        const maxCount = Math.max(...periods.map(p => p.count), 1);
        for (const p of periods) {
          const bar = progressBar(p.count, maxCount, 8);
          const pct = Math.round(p.count / total * 100);
          reply += `${p.label.padEnd(18)} ${bar} ${p.count} (${pct}%)\n`;
        }

        // Flag heaviest period
        const heaviest = periods.reduce((a, b) => a.count > b.count ? a : b);
        reply += `\nHeaviest: **${heaviest.label}**`;
      }
    }

    await message.reply(reply);
    return;
  }

  // --- Help ---
  if (content === 'help' || content === 'h' || content === '?') {
    await message.reply(
      '**NicBot Commands**\n' +
      '`1` or `3` — log pouch(es) at current target mg\n' +
      '`1 6` or `2 4` — log with explicit mg\n' +
      '`skip` / `s` — log a skipped craving\n' +
      '`undo` / `u` — remove last entry\n' +
      '`status` / `st` — phase, streak, progress, mg budget\n' +
      '`stats` / `week` — last 7 days + weekly comparison\n' +
      '`graph` / `g` — last 24h mg usage graph\n' +
      '`insights` / `i` — avg gap, time-of-day breakdown\n' +
      '`help` / `h` — this message\n\n' +
      '_Auto: end-of-day summary at 10pm, milestones on achievements_'
    );
    return;
  }
});

// --- Reaction Handler (for ping responses) ---

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.id !== USER_ID) return;
  if (reaction.message.author.id !== client.user.id) return;

  // Check if this is a ping message
  const msgContent = reaction.message.content || '';
  if (!msgContent.includes('⏰')) return;

  const phase = getCurrentPhase();
  const lastPing = stmts.lastPing.get();

  if (reaction.emoji.name === '✅') {
    if (lastPing && !lastPing.responded) {
      stmts.respondPing.run('used', lastPing.id);
    }
    // Ask for mg instead of auto-logging
    pendingMgReply = { since: Date.now() };
    await reaction.message.reply(`How many mg? (default: ${phase.mg}mg — just hit enter or type a number)`);
  } else if (reaction.emoji.name === '⏭️') {
    stmts.logUse.run('ping_skipped', null, null);
    if (lastPing && !lastPing.responded) {
      stmts.respondPing.run('skipped', lastPing.id);
    }
    await reaction.message.reply(`💪 Skipped | ${todaySummary()}`);
  }
});

// --- Ready ---

client.once('ready', () => {
  console.log(`NicBot online as ${client.user.tag}`);
  schedulePing();
  scheduleEndOfDay();
});

function login() {
  return client.login(process.env.DISCORD_TOKEN);
}

module.exports = { client, login, sendDM };
