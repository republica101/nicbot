const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { stmts } = require('./db');
const { getCurrentPhase, formatPhaseStatus } = require('./taper');

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
      await message.reply(reply);
      return;
    }
  }

  // --- Log a pouch: "1", "1 6", "1 4mg", "2", "2 4", etc ---
  const useMatch = content.match(/^(\d+)\s*(\d+)?\s*(mg)?$/);
  if (useMatch) {
    const count = parseInt(useMatch[1]);
    const mg = useMatch[2] ? parseInt(useMatch[2]) : phase.mg;

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

    let reply = `📊 **Status**\n${phaseStatus}\n${summary}`;
    if (last) reply += `\nLast pouch: ${formatTimeSince(last.timestamp)}`;

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

  // --- Help ---
  if (content === 'help' || content === 'h' || content === '?') {
    await message.reply(
      '**NicBot Commands**\n' +
      '`1` or `3` — log pouch(es) at current target mg\n' +
      '`1 6` or `2 4` — log with explicit mg\n' +
      '`skip` / `s` — log a skipped craving\n' +
      '`undo` / `u` — remove last entry\n' +
      '`status` / `st` — current phase + today\'s count\n' +
      '`stats` / `week` — last 7 days summary\n' +
      '`graph` / `g` — last 24h mg usage graph\n' +
      '`help` / `h` — this message'
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
});

function login() {
  return client.login(process.env.DISCORD_TOKEN);
}

module.exports = { client, login, sendDM };
