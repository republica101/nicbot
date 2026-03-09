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
let pingInterval = null;

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

// --- Ping Loop ---

function startPingLoop() {
  if (pingInterval) clearInterval(pingInterval);

  const phase = getCurrentPhase();
  const ms = phase.intervalMin * 60 * 1000;

  console.log(`Ping loop started: every ${phase.intervalMin}min (${ms}ms)`);

  pingInterval = setInterval(async () => {
    // Recalculate phase in case it changed
    const currentPhase = getCurrentPhase();
    const today = stmts.todayCount.get();

    stmts.logPing.run();

    const msg = await sendDM(
      `⏰ **${currentPhase.intervalMin}min** — pouch? (today: ${today.count}/${currentPhase.dailyTarget}, ${currentPhase.mg}mg)\n\n✅ = used | ⏭️ = skipped`
    );

    if (msg) {
      await msg.react('✅');
      await msg.react('⏭️');
    }

    // Check if interval needs updating for new phase
    if (currentPhase.intervalMin !== phase.intervalMin) {
      console.log(`Phase changed, restarting ping loop at ${currentPhase.intervalMin}min`);
      startPingLoop();
    }
  }, ms);
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

  // --- Log a pouch: "1", "1 6", "1 4mg", "2", "2 4", etc ---
  const useMatch = content.match(/^(\d+)\s*(\d+)?\s*(mg)?$/);
  if (useMatch) {
    const count = parseInt(useMatch[1]);
    const mg = useMatch[2] ? parseInt(useMatch[2]) : phase.mg;

    for (let i = 0; i < count; i++) {
      stmts.logUse.run('used', mg, null);
    }

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
    stmts.logUse.run('ping_used', phase.mg, null);
    if (lastPing && !lastPing.responded) {
      stmts.respondPing.run('used', lastPing.id);
    }
    await reaction.message.reply(`📝 Logged ${phase.mg}mg | ${todaySummary()}`);
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
  startPingLoop();
});

function login() {
  return client.login(process.env.DISCORD_TOKEN);
}

module.exports = { client, login, sendDM };
