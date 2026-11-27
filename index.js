// Bot Monitor Status — detects when other Discord bots go online/offline
// Stack: Node.js 18+, discord.js v14. Storage: JSON file (no native deps, Termux-friendly).
// Supports both slash commands (/monitor ...) and prefix commands (default "?").
try { require('dotenv').config(); } catch (_) { /* dotenv is optional */ }

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  Events,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const DEFAULT_PREFIX = process.env.DEFAULT_PREFIX || '?';
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 5000);   // ignore very short flaps
const SWEEP_MS = Number(process.env.SWEEP_MS || 30000);        // fallback re-check + reminders
const PANEL_MS = Number(process.env.PANEL_MS || 60000);        // live panel refresh
const REPORT_TZ_OFFSET = Number(process.env.REPORT_TZ_OFFSET ?? 7);       // hours from UTC for the daily report (7 = WIB)
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 8000);        // timeout for HTTP health checks
const MAX_DM_USERS = 10;
const MAX_BOTS = 25;
const MAX_LOG = 500;
const DATA_FILE = path.join(__dirname, 'data.json');

if (!TOKEN) {
  console.error('DISCORD_TOKEN is not set (environment variable).');
  process.exit(1);
}

// ---------- Storage ----------
let db = { guilds: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('Could not read data.json, starting empty:', e.message);
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
    catch (e) { console.error('Could not save data.json:', e.message); }
  }, 300);
}
function g(guildId) {
  if (!db.guilds[guildId]) db.guilds[guildId] = { channelId: null, roleId: null, panel: null, bots: {} };
  const cfg = db.guilds[guildId];
  if (cfg.roleId === undefined) cfg.roleId = null;
  if (cfg.panel === undefined) cfg.panel = null;
  if (cfg.prefix === undefined) cfg.prefix = null;
  if (cfg.reminderMin === undefined) cfg.reminderMin = 0;
  if (!Array.isArray(cfg.dmUsers)) cfg.dmUsers = [];
  if (cfg.reportHour === undefined) cfg.reportHour = null;
  if (cfg.lastReportDay === undefined) cfg.lastReportDay = null;
  return cfg;
}
const prefixOf = (guildId) => (db.guilds[guildId] && db.guilds[guildId].prefix) || DEFAULT_PREFIX;

// ---------- Helpers ----------
function toState(presence) {
  const s = presence && presence.status;
  return s && s !== 'offline' && s !== 'invisible' ? 'online' : 'offline';
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${sec}s`);
  return parts.join(' ');
}
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
const rel = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const icon = (s) => (s === 'online' ? '🟢' : s === 'offline' ? '🔴' : '⚪');

// Presence + optional HTTP health check combine into one effective state:
// a bot with a health URL counts as online only if presence is online AND the URL responds.
function effective(rec, presenceState) {
  return rec && rec.url && rec.httpUp === false ? 'offline' : presenceState;
}
async function checkUrl(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctl.signal, redirect: 'follow' });
    return res.status < 500;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Append a state change to the history log (seeds old records that have no log yet)
function pushLog(rec, status, t) {
  rec.log = rec.log || [];
  if (!rec.log.length && rec.status && rec.status !== 'unknown' && rec.since) {
    rec.log.push({ s: rec.status, t: rec.since });
  }
  rec.log.push({ s: status, t });
  if (rec.log.length > MAX_LOG) rec.log.splice(0, rec.log.length - MAX_LOG);
}

// Uptime percentage over a window, based only on the time we have actually tracked
function calcUptime(rec, windowMs, now = Date.now()) {
  const log = rec.log || [];
  if (!log.length) return null;
  const start = Math.max(now - windowMs, log[0].t);
  const total = now - start;
  if (total <= 0) return null;
  let online = 0;
  for (let i = 0; i < log.length; i++) {
    const segEnd = i + 1 < log.length ? log[i + 1].t : now;
    if (segEnd <= start) continue;
    const segStart = Math.max(log[i].t, start);
    if (log[i].s === 'online') online += segEnd - segStart;
  }
  return { pct: (online / total) * 100, tracked: total };
}
function fmtUptime(rec, windowMs) {
  const u = calcUptime(rec, windowMs);
  return u ? `${u.pct.toFixed(2)}%` : 'n/a';
}
function downtimeMs(rec, windowMs) {
  const u = calcUptime(rec, windowMs);
  return u ? Math.round(u.tracked * (1 - u.pct / 100)) : 0;
}

// Offline periods, newest first
function incidents(rec) {
  const log = rec.log || [];
  const out = [];
  for (let i = 0; i < log.length; i++) {
    if (log[i].s !== 'offline') continue;
    out.push({ start: log[i].t, end: i + 1 < log.length ? log[i + 1].t : null });
  }
  return out.reverse();
}

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,    // privileged
    GatewayIntentBits.GuildPresences,  // privileged — required to see online/offline
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // privileged — required for prefix commands
  ],
  partials: [Partials.GuildMember],
});

// ---------- Live status panel ----------
function buildPanelEmbed(guild) {
  const cfg = g(guild.id);
  const ids = Object.keys(cfg.bots);
  const lines = ids.map((id) => {
    const r = cfg.bots[id];
    const state = r.paused ? '⏸️ paused' : `${icon(r.status)} ${r.status}`;
    return `${state} — <@${id}>\n└ since ${rel(r.since || Date.now())} • 24h uptime **${fmtUptime(r, 86400000)}**`;
  });
  const online = ids.filter((id) => cfg.bots[id].status === 'online').length;
  return new EmbedBuilder()
    .setColor(online === ids.length && ids.length ? 0x2ecc71 : ids.length ? 0xe67e22 : 0x95a5a6)
    .setTitle('Bot Status Panel')
    .setDescription(lines.length ? lines.join('\n\n') : 'No bots are being monitored yet.')
    .setFooter({ text: `${online}/${ids.length} online • refreshes every ${Math.round(PANEL_MS / 1000)}s` })
    .setTimestamp();
}

async function updatePanel(guild) {
  const cfg = g(guild.id);
  if (!cfg.panel) return;
  try {
    const ch = await guild.channels.fetch(cfg.panel.channelId).catch(() => null);
    const msg = ch && (await ch.messages.fetch(cfg.panel.messageId).catch(() => null));
    if (!msg) { cfg.panel = null; save(); return; }
    await msg.edit({ embeds: [buildPanelEmbed(guild)] });
  } catch (e) {
    console.error('Panel update failed:', e.message);
  }
}

// ---------- Core: state change + notification ----------
const pending = new Map(); // "guildId:botId" -> { status, timer }

function report(guild, botId, status) {
  const cfg = g(guild.id);
  const rec = cfg.bots[botId];
  if (!rec) return;
  const key = `${guild.id}:${botId}`;
  const p = pending.get(key);

  if (rec.status === status) {
    if (p) { clearTimeout(p.timer); pending.delete(key); }
    return;
  }
  if (p && p.status === status) return;
  if (p) clearTimeout(p.timer);

  const timer = setTimeout(() => {
    pending.delete(key);
    commit(guild, botId, status).catch((e) => console.error('commit error:', e.message));
  }, DEBOUNCE_MS);
  pending.set(key, { status, timer });
}

async function buildNotice(botId, status, durationMs, now, kind) {
  const user = await client.users.fetch(botId).catch(() => null);
  const name = user ? user.username : botId;
  const embed = new EmbedBuilder().setTimestamp(now);
  if (user) embed.setThumbnail(user.displayAvatarURL());
  if (kind === 'reminder') {
    embed
      .setColor(0xe67e22)
      .setTitle(`🟠 ${name} is still OFFLINE`)
      .setDescription(`<@${botId}> has been **down for ${fmtDuration(durationMs)}**.`)
      .addFields({ name: 'Down since', value: ts(now - durationMs) });
  } else if (status === 'offline') {
    embed
      .setColor(0xe74c3c)
      .setTitle(`🔴 ${name} is OFFLINE`)
      .setDescription(`<@${botId}> just went **down**.`)
      .addFields(
        { name: 'Was online for', value: fmtDuration(durationMs), inline: true },
        { name: 'Went down at', value: ts(now) },
      );
  } else {
    embed
      .setColor(0x2ecc71)
      .setTitle(`🟢 ${name} is ONLINE`)
      .setDescription(`<@${botId}> is **back up**.`)
      .addFields(
        { name: 'Was down for', value: fmtDuration(durationMs), inline: true },
        { name: 'Back online at', value: ts(now) },
      );
  }
  return embed;
}

async function sendNotice(guild, cfg, botId, status, durationMs, now, opts = {}) {
  const { kind = 'change', ping = true, dm = true } = opts;
  const embed = await buildNotice(botId, status, durationMs, now, kind);
  if (dm && cfg.dmUsers && cfg.dmUsers.length) {
    const dmEmbed = EmbedBuilder.from(embed).setFooter({ text: guild.name });
    for (const uid of cfg.dmUsers) {
      client.users.fetch(uid).then((u) => u.send({ embeds: [dmEmbed] })).catch(() => {});
    }
  }
  const channel = cfg.channelId && (await guild.channels.fetch(cfg.channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return false;
  const doPing = ping && status === 'offline' && cfg.roleId;
  await channel
    .send({
      content: doPing ? `<@&${cfg.roleId}>` : undefined,
      embeds: [embed],
      allowedMentions: { roles: doPing ? [cfg.roleId] : [] },
    })
    .catch((e) => console.error('Could not send notice:', e.message));
  return true;
}

async function commit(guild, botId, status) {
  const cfg = g(guild.id);
  const rec = cfg.bots[botId];
  if (!rec || rec.status === status) return;

  const now = Date.now();
  const prev = rec.status;
  const prevSince = rec.since || now;
  pushLog(rec, status, now);
  rec.status = status;
  rec.since = now;
  rec.lastReminder = null;
  if (status === 'offline') rec.lastOffline = now;
  if (status === 'online') rec.lastOnline = now;
  save();

  updatePanel(guild);

  // First detection or maintenance mode: record only, no notification
  if (prev === 'unknown' || rec.paused) return;
  await sendNotice(guild, cfg, botId, status, now - prevSince, now);
}

// Repeat an alert while a bot stays offline (per-server interval, 0 = off)
async function checkReminders(guild) {
  const cfg = db.guilds[guild.id];
  if (!cfg || !cfg.reminderMin) return;
  const now = Date.now();
  for (const [id, rec] of Object.entries(cfg.bots)) {
    if (rec.status !== 'offline' || rec.paused) continue;
    const last = rec.lastReminder || rec.since || now;
    if (now - last < cfg.reminderMin * 60000) continue;
    rec.lastReminder = now;
    save();
    await sendNotice(guild, cfg, id, 'offline', now - (rec.since || now), now, { kind: 'reminder' });
  }
}

// ---------- Initial sync & periodic sweep ----------
async function syncGuild(guild) {
  const cfg = g(guild.id);
  const ids = Object.keys(cfg.bots);
  if (!ids.length) return;
  try { await guild.members.fetch({ user: ids, withPresences: true }); } catch (_) { /* ignore */ }
  for (const id of ids) {
    const member = guild.members.cache.get(id);
    report(guild, id, effective(cfg.bots[id], member ? toState(member.presence) : 'offline'));
  }
}

// Daily uptime summary, posted once at the configured hour
async function checkDailyReport(guild) {
  const cfg = db.guilds[guild.id];
  if (!cfg || cfg.reportHour === null || cfg.reportHour === undefined) return;
  const local = new Date(Date.now() + REPORT_TZ_OFFSET * 3600000);
  const dayKey = local.toISOString().slice(0, 10);
  if (local.getUTCHours() !== cfg.reportHour || cfg.lastReportDay === dayKey) return;
  const ids = Object.keys(cfg.bots);
  if (!ids.length) return;
  cfg.lastReportDay = dayKey;
  save();
  const channel = cfg.channelId && (await guild.channels.fetch(cfg.channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return;
  const now = Date.now();
  const lines = ids.map((id) => {
    const r = cfg.bots[id];
    const inc = incidents(r).filter((x) => x.start >= now - 86400000).length;
    return `${icon(r.status)} <@${id}>\n└ uptime **${fmtUptime(r, 86400000)}** • incidents **${inc}** • downtime **${fmtDuration(downtimeMs(r, 86400000))}**`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Daily uptime report')
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: 'Last 24 hours' })
    .setTimestamp(now);
  await channel.send({ embeds: [embed] }).catch((e) => console.error('Could not send report:', e.message));
}

// Periodic sweep: HTTP checks, state re-check, reminders, daily report
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      const cfg = db.guilds[guild.id];
      if (!cfg) continue;
      try {
        await Promise.all(
          Object.values(cfg.bots)
            .filter((rec) => rec.url)
            .map((rec) => checkUrl(rec.url).then((up) => { rec.httpUp = up; })),
        );
        for (const id of Object.keys(cfg.bots)) {
          const member = guild.members.cache.get(id);
          report(guild, id, effective(cfg.bots[id], member ? toState(member.presence) : 'offline'));
        }
        await checkReminders(guild);
        await checkDailyReport(guild);
      } catch (e) {
        console.error('sweep error:', e.message);
      }
    }
  } finally {
    sweeping = false;
  }
}

client.on(Events.PresenceUpdate, (oldP, newP) => {
  if (!newP || !newP.guild) return;
  const cfg = db.guilds[newP.guild.id];
  if (!cfg || !cfg.bots[newP.userId]) return;
  report(newP.guild, newP.userId, effective(cfg.bots[newP.userId], toState(newP)));
});

// ---------- Slash command definitions ----------
const botOpt = (desc) => (o) => o.setName('bot').setDescription(desc).setRequired(true);
const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const commands = [
  new SlashCommandBuilder()
    .setName('monitor')
    .setDescription('Monitor the online/offline status of bots')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('add').setDescription('Start monitoring a bot').addUserOption(botOpt('Bot to monitor')))
    .addSubcommand((s) => s.setName('remove').setDescription('Stop monitoring a bot').addUserOption(botOpt('Bot to remove')))
    .addSubcommand((s) =>
      s.setName('channel').setDescription('Set the notification channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Notification channel').addChannelTypes(...textTypes).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('role').setDescription('Set a role to ping when a bot goes offline (leave empty to clear)')
        .addRoleOption((o) => o.setName('role').setDescription('Role to ping')))
    .addSubcommand((s) => s.setName('list').setDescription('Show the status of all monitored bots'))
    .addSubcommand((s) => s.setName('stats').setDescription('Detailed stats and uptime for one bot').addUserOption(botOpt('Bot to inspect')))
    .addSubcommand((s) => s.setName('history').setDescription('Recent downtime incidents for one bot').addUserOption(botOpt('Bot to inspect')))
    .addSubcommand((s) =>
      s.setName('panel').setDescription('Post a live status panel that updates automatically')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel for the panel (default: here)').addChannelTypes(...textTypes)))
    .addSubcommand((s) => s.setName('pause').setDescription('Maintenance mode: stop alerts for a bot').addUserOption(botOpt('Bot to pause')))
    .addSubcommand((s) => s.setName('resume').setDescription('End maintenance mode for a bot').addUserOption(botOpt('Bot to resume')))
    .addSubcommand((s) =>
      s.setName('reminder').setDescription('Repeat the alert while a bot stays offline')
        .addIntegerOption((o) => o.setName('minutes').setDescription('Interval in minutes (5-1440, 0 = off)').setMinValue(0).setMaxValue(1440)))
    .addSubcommand((s) => s.setName('dm').setDescription('Toggle DM alerts for yourself'))
    .addSubcommand((s) =>
      s.setName('url').setDescription('Add an HTTP health check URL for a bot (leave URL empty to clear)')
        .addUserOption(botOpt('Bot to check'))
        .addStringOption((o) => o.setName('url').setDescription('http(s) URL to check').setMaxLength(300)))
    .addSubcommand((s) =>
      s.setName('report').setDescription('Daily uptime report at a given hour')
        .addIntegerOption((o) => o.setName('hour').setDescription('Hour 0-23 (report time zone), -1 = off').setMinValue(-1).setMaxValue(23)))
    .addSubcommand((s) =>
      s.setName('prefix').setDescription('Show or change the prefix for chat commands')
        .addStringOption((o) => o.setName('prefix').setDescription('New prefix (1-5 characters)').setMaxLength(5)))
    .addSubcommand((s) => s.setName('test').setDescription('Send a test notification to the alert channel'))
    .addSubcommand((s) => s.setName('ping').setDescription('Check bot latency'))
    .addSubcommand((s) => s.setName('help').setDescription('Show all commands')),
].map((c) => c.toJSON());

// ---------- Prefix command aliases ----------
const ALIASES = {
  add: 'add', watch: 'add',
  remove: 'remove', delete: 'remove', rm: 'remove', unwatch: 'remove',
  channel: 'channel', ch: 'channel',
  role: 'role',
  list: 'list', ls: 'list', status: 'list',
  stats: 'stats', info: 'stats',
  history: 'history', log: 'history',
  panel: 'panel',
  pause: 'pause', resume: 'resume',
  reminder: 'reminder', remind: 'reminder',
  prefix: 'prefix',
  dm: 'dm',
  url: 'url', health: 'url',
  report: 'report', daily: 'report',
  test: 'test',
  ping: 'ping',
  help: 'help', h: 'help',
};

function helpEmbed(guildId) {
  const p = prefixOf(guildId);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Bot Monitor — Commands')
    .setDescription(`Use \`/monitor <command>\` or the prefix \`${p}<command>\`. Prefix commands need **Manage Server**.`)
    .addFields(
      { name: 'Setup', value: [
        `\`${p}add @bot\` — start monitoring (max ${MAX_BOTS})`,
        `\`${p}remove @bot\` — stop monitoring`,
        `\`${p}channel #channel\` — alert channel`,
        `\`${p}role @role\` — role to ping on offline (no arg = clear)`,
        `\`${p}reminder <minutes>\` — repeat alert while offline (0 = off)`,
        `\`${p}prefix <new>\` — change the chat prefix`,
        `\`${p}dm\` — toggle DM alerts for yourself`,
        `\`${p}url @bot <url>\` — HTTP health check (no url = clear)`,
        `\`${p}report <hour|off>\` — daily uptime report`,
      ].join('\n') },
      { name: 'Info', value: [
        `\`${p}list\` — status of all bots`,
        `\`${p}stats @bot\` — uptime and last on/off`,
        `\`${p}history @bot\` — last downtime incidents`,
        `\`${p}panel [#channel]\` — live status panel`,
        `\`${p}ping\` — bot latency`,
      ].join('\n') },
      { name: 'Maintenance', value: [
        `\`${p}pause @bot\` — track but don't alert`,
        `\`${p}resume @bot\` — alerts back on`,
        `\`${p}test\` — send a sample alert`,
      ].join('\n') },
    );
}

// ---------- Shared command logic ----------
// ctx: { guild, guildId, channel, sub, reply(payload), defer(), getBot(), getChannel(), getRole(), getNumber(), getText() }
async function run(ctx) {
  const cfg = g(ctx.guildId);
  const guild = ctx.guild;
  const sub = ctx.sub;
  const needBot = async () => {
    const user = await ctx.getBot();
    if (!user) await ctx.reply('❌ Tell me which bot: mention it or paste its ID.');
    return user;
  };

  try {
    if (sub === 'help') return ctx.reply({ embeds: [helpEmbed(ctx.guildId)] });

    if (sub === 'ping') return ctx.reply(`🏓 Pong! WebSocket latency: **${Math.round(client.ws.ping)}ms**`);

    if (sub === 'channel') {
      const ch = await ctx.getChannel();
      if (!ch || !ch.isTextBased()) return ctx.reply('❌ Pick a text channel (mention it or paste its ID).');
      cfg.channelId = ch.id;
      save();
      return ctx.reply(`✅ Alerts will be sent to ${ch}.`);
    }

    if (sub === 'role') {
      const role = await ctx.getRole();
      cfg.roleId = role ? role.id : null;
      save();
      return ctx.reply(role ? `✅ ${role} will be pinged when a bot goes offline.` : '✅ Role ping cleared.');
    }

    if (sub === 'reminder') {
      const n = await ctx.getNumber();
      if (n === null || n === undefined || Number.isNaN(n)) {
        return ctx.reply(cfg.reminderMin
          ? `ℹ️ Reminders repeat every **${cfg.reminderMin} min** while a bot stays offline.`
          : 'ℹ️ Reminders are **off**. Set minutes (5-1440) to turn them on.');
      }
      if (n !== 0 && (n < 5 || n > 1440)) return ctx.reply('❌ Use 0 (off) or a value between 5 and 1440 minutes.');
      cfg.reminderMin = n;
      save();
      return ctx.reply(n ? `✅ Offline bots will be re-announced every **${n} min**.` : '✅ Reminders turned off.');
    }

    if (sub === 'dm') {
      const uid = ctx.userId;
      const idx = cfg.dmUsers.indexOf(uid);
      if (idx >= 0) {
        cfg.dmUsers.splice(idx, 1);
        save();
        return ctx.reply('🔕 DM alerts turned off for you.');
      }
      if (cfg.dmUsers.length >= MAX_DM_USERS) return ctx.reply(`❌ Limit reached (${MAX_DM_USERS} people per server).`);
      const u = await client.users.fetch(uid).catch(() => null);
      const sent = u && (await u.send(`🔔 DM alerts are on for **${guild.name}**. Use the dm command again to turn them off.`).then(() => true).catch(() => false));
      if (!sent) return ctx.reply('❌ I could not DM you. Allow DMs from server members, then try again.');
      cfg.dmUsers.push(uid);
      save();
      return ctx.reply('🔔 DM alerts turned on. Check your DMs.');
    }

    if (sub === 'url') {
      const user = await needBot();
      if (!user) return;
      const rec = cfg.bots[user.id];
      if (!rec) return ctx.reply('ℹ️ That bot is not monitored.');
      const url = await ctx.getUrl();
      if (!url) {
        delete rec.url;
        delete rec.httpUp;
        save();
        return ctx.reply(`✅ Health check cleared for <@${user.id}>.`);
      }
      if (!/^https?:\/\/\S+$/i.test(url)) return ctx.reply('❌ Use a full URL starting with http:// or https://');
      await ctx.defer();
      const up = await checkUrl(url);
      rec.url = url;
      rec.httpUp = up;
      save();
      const member = guild.members.cache.get(user.id);
      report(guild, user.id, effective(rec, member ? toState(member.presence) : 'offline'));
      return ctx.reply(`✅ Health check set for <@${user.id}>. The URL is currently ${up ? '🟢 up' : '🔴 down'}.\nThe bot counts as online only when its presence is online **and** the URL responds.`);
    }

    if (sub === 'report') {
      const h = await ctx.getNumber();
      const tz = `UTC${REPORT_TZ_OFFSET >= 0 ? '+' : ''}${REPORT_TZ_OFFSET}`;
      if (h === null || h === undefined || Number.isNaN(h)) {
        return ctx.reply(cfg.reportHour === null
          ? 'ℹ️ Daily report is **off**. Set an hour (0-23) to turn it on.'
          : `ℹ️ Daily report is posted at **${String(cfg.reportHour).padStart(2, '0')}:00** (${tz}).`);
      }
      if (h < -1 || h > 23) return ctx.reply('❌ Use an hour from 0 to 23, or off.');
      cfg.reportHour = h < 0 ? null : h;
      save();
      return ctx.reply(h < 0
        ? '✅ Daily report turned off.'
        : `✅ Daily uptime report will be posted at **${String(h).padStart(2, '0')}:00** (${tz}) in the alert channel.`);
    }

    if (sub === 'prefix') {
      const val = await ctx.getText();
      if (!val) return ctx.reply(`ℹ️ Current prefix: \`${prefixOf(ctx.guildId)}\``);
      if (/\s/.test(val) || val.length > 5) return ctx.reply('❌ Prefix must be 1-5 characters with no spaces.');
      cfg.prefix = val;
      save();
      return ctx.reply(`✅ Prefix changed to \`${val}\`. Try \`${val}help\`.`);
    }

    if (sub === 'add') {
      const user = await needBot();
      if (!user) return;
      if (!user.bot) return ctx.reply('❌ That user is not a bot.');
      if (user.id === client.user.id) return ctx.reply('❌ I cannot monitor myself.');
      if (cfg.bots[user.id]) return ctx.reply('ℹ️ That bot is already monitored.');
      if (Object.keys(cfg.bots).length >= MAX_BOTS) return ctx.reply(`❌ Limit reached (${MAX_BOTS} bots per server).`);
      cfg.bots[user.id] = { status: 'unknown', since: Date.now() };
      save();
      await ctx.defer();
      await syncGuild(guild);
      const member = guild.members.cache.get(user.id);
      const state = member ? toState(member.presence) : 'offline';
      const rec = cfg.bots[user.id];
      if (rec.status === 'unknown') {
        const now = Date.now();
        pushLog(rec, state, now);
        rec.status = state;
        rec.since = now;
        save();
      }
      updatePanel(guild);
      const warn = cfg.channelId ? '' : `\n⚠️ No alert channel set yet — use \`${prefixOf(ctx.guildId)}channel\`.`;
      return ctx.reply(`✅ Now monitoring <@${user.id}>. Current status: ${icon(state)} ${state}.${warn}`);
    }

    if (sub === 'remove') {
      const user = await needBot();
      if (!user) return;
      if (!cfg.bots[user.id]) return ctx.reply('ℹ️ That bot is not in the list.');
      delete cfg.bots[user.id];
      const key = `${ctx.guildId}:${user.id}`;
      const p = pending.get(key);
      if (p) { clearTimeout(p.timer); pending.delete(key); }
      save();
      updatePanel(guild);
      return ctx.reply(`🗑️ <@${user.id}> removed from monitoring.`);
    }

    if (sub === 'list') {
      const ids = Object.keys(cfg.bots);
      if (!ids.length) return ctx.reply(`No bots are monitored yet. Use \`${prefixOf(ctx.guildId)}add @bot\`.`);
      const now = Date.now();
      const lines = ids.map((id) => {
        const r = cfg.bots[id];
        const flag = (r.paused ? ' ⏸️ paused' : '') + (r.url ? (r.httpUp === false ? ' 🌐❌' : ' 🌐✅') : '');
        return `${icon(r.status)} <@${id}> — ${r.status} for ${fmtDuration(now - (r.since || now))}${flag}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Monitored bots')
        .setDescription(lines.join('\n'))
        .setFooter({ text: cfg.channelId ? 'Alerts enabled' : 'Alert channel not set' });
      return ctx.reply({ embeds: [embed] });
    }

    if (sub === 'stats') {
      const user = await needBot();
      if (!user) return;
      const rec = cfg.bots[user.id];
      if (!rec) return ctx.reply('ℹ️ That bot is not monitored.');
      const now = Date.now();
      const week = incidents(rec).filter((x) => x.start >= now - 7 * 86400000);
      const embed = new EmbedBuilder()
        .setColor(rec.status === 'online' ? 0x2ecc71 : 0xe74c3c)
        .setTitle(`${icon(rec.status)} ${user.username}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: 'Status', value: `${rec.status}${rec.paused ? ' (paused)' : ''} for ${fmtDuration(now - (rec.since || now))}`, inline: false },
          { name: 'Uptime 24h', value: fmtUptime(rec, 86400000), inline: true },
          { name: 'Uptime 7d', value: fmtUptime(rec, 7 * 86400000), inline: true },
          { name: 'Uptime 30d', value: fmtUptime(rec, 30 * 86400000), inline: true },
          { name: 'Incidents (7d)', value: String(week.length), inline: true },
          { name: 'Last offline', value: rec.lastOffline ? ts(rec.lastOffline) : 'never seen', inline: false },
          { name: 'Last online', value: rec.lastOnline ? ts(rec.lastOnline) : 'never seen', inline: false },
        )
        .setFooter({ text: 'Uptime counts only time since monitoring started' });
      return ctx.reply({ embeds: [embed] });
    }

    if (sub === 'history') {
      const user = await needBot();
      if (!user) return;
      const rec = cfg.bots[user.id];
      if (!rec) return ctx.reply('ℹ️ That bot is not monitored.');
      const list = incidents(rec).slice(0, 10);
      if (!list.length) return ctx.reply(`✅ No downtime recorded for <@${user.id}>.`);
      const lines = list.map((x) =>
        x.end
          ? `🔴 ${ts(x.start)}\n└ down for **${fmtDuration(x.end - x.start)}**`
          : `🔴 ${ts(x.start)}\n└ **still down** (${fmtDuration(Date.now() - x.start)})`);
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`Downtime history — ${user.username}`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `Showing the last ${list.length} incident(s)` });
      return ctx.reply({ embeds: [embed] });
    }

    if (sub === 'panel') {
      const ch = (await ctx.getChannel()) || ctx.channel;
      if (!ch || !ch.isTextBased()) return ctx.reply('❌ Pick a text channel.');
      await ctx.defer();
      if (cfg.panel) {
        const oldCh = await guild.channels.fetch(cfg.panel.channelId).catch(() => null);
        const oldMsg = oldCh && (await oldCh.messages.fetch(cfg.panel.messageId).catch(() => null));
        if (oldMsg) await oldMsg.delete().catch(() => {});
      }
      const msg = await ch.send({ embeds: [buildPanelEmbed(guild)] });
      cfg.panel = { channelId: ch.id, messageId: msg.id };
      save();
      return ctx.reply(`✅ Live panel posted in ${ch}. It refreshes automatically.`);
    }

    if (sub === 'pause' || sub === 'resume') {
      const user = await needBot();
      if (!user) return;
      const rec = cfg.bots[user.id];
      if (!rec) return ctx.reply('ℹ️ That bot is not monitored.');
      rec.paused = sub === 'pause';
      save();
      updatePanel(guild);
      return ctx.reply(rec.paused
        ? `⏸️ Maintenance mode on for <@${user.id}>. Status is still tracked, but no alerts are sent.`
        : `▶️ Alerts resumed for <@${user.id}>.`);
    }

    if (sub === 'test') {
      if (!cfg.channelId) return ctx.reply(`❌ Set an alert channel first with \`${prefixOf(ctx.guildId)}channel\`.`);
      const ok = await sendNotice(guild, cfg, client.user.id, 'offline', 3600000, Date.now(), { ping: false, dm: false });
      return ctx.reply(ok ? '✅ Test alert sent (it uses this bot as the sample, no role ping).' : '❌ I cannot access the alert channel.');
    }
  } catch (e) {
    console.error('Command error:', e);
    return ctx.reply('❌ Something went wrong. Please try again.').catch(() => {});
  }
}

// ---------- Slash adapter ----------
const toPayload = (p) => (typeof p === 'string' ? { content: p } : p);

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'monitor') return;
  const ctx = {
    guild: i.guild,
    guildId: i.guildId,
    channel: i.channel,
    sub: i.options.getSubcommand(),
    userId: i.user.id,
    reply: (p) => (i.deferred || i.replied
      ? i.editReply(toPayload(p))
      : i.reply({ ...toPayload(p), ephemeral: true })),
    defer: async () => { if (!i.deferred && !i.replied) await i.deferReply({ ephemeral: true }); },
    getBot: async () => i.options.getUser('bot'),
    getChannel: async () => i.options.getChannel('channel'),
    getRole: async () => i.options.getRole('role'),
    getNumber: async () => {
      const v = i.options.getInteger('minutes');
      return v !== null ? v : i.options.getInteger('hour');
    },
    getUrl: async () => i.options.getString('url'),
    getText: async () => i.options.getString('prefix'),
  };
  await run(ctx);
});

// ---------- Prefix adapter ----------
const idFrom = (s) => {
  const m = s && s.match(/\d{17,20}/);
  return m ? m[0] : null;
};

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const prefix = prefixOf(msg.guild.id);
  const text = msg.content.trim();

  // Mentioning the bot alone shows the prefix
  if (text === `<@${client.user.id}>` || text === `<@!${client.user.id}>`) {
    return msg.reply({ content: `My prefix here is \`${prefix}\` — try \`${prefix}help\`.`, allowedMentions: { repliedUser: false } }).catch(() => {});
  }
  if (!text.startsWith(prefix)) return;

  const args = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  let name = (args.shift() || '').toLowerCase();
  if (name === 'monitor') name = (args.shift() || 'help').toLowerCase();
  const sub = ALIASES[name];
  if (!sub) return;

  const open = sub === 'help' || sub === 'ping';
  if (!open && !(msg.member && msg.member.permissions.has(PermissionFlagsBits.ManageGuild))) {
    return msg.reply({ content: '❌ You need the **Manage Server** permission.', allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  const ctx = {
    guild: msg.guild,
    guildId: msg.guild.id,
    channel: msg.channel,
    sub,
    userId: msg.author.id,
    reply: (p) => msg.reply({ ...toPayload(p), allowedMentions: { parse: [], repliedUser: false } }),
    defer: async () => { await msg.channel.sendTyping().catch(() => {}); },
    getBot: async () => {
      const id = idFrom(args[0]);
      return id ? client.users.fetch(id).catch(() => null) : null;
    },
    getChannel: async () => {
      const id = idFrom(args[0]);
      return id ? msg.guild.channels.cache.get(id) || null : null;
    },
    getRole: async () => {
      const id = idFrom(args[0]);
      return id ? msg.guild.roles.cache.get(id) || null : null;
    },
    getNumber: async () => (args[0] === undefined ? null : /^off$/i.test(args[0]) ? -1 : parseInt(args[0], 10)),
    getUrl: async () => args[1] || null,
    getText: async () => args[0] || null,
  };
  await run(ctx);
});

// ---------- Ready ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Remove old GLOBAL slash commands left over from the previous bot setup.
  // (Per-server commands are overwritten below by guild.commands.set.)
  try {
    await client.application.commands.set([]);
    console.log('Old global commands cleared');
  } catch (e) {
    console.error('Could not clear global commands:', e.message);
  }
  for (const guild of client.guilds.cache.values()) {
    try { await guild.commands.set(commands); } catch (e) { console.error(`Could not register commands in ${guild.name}:`, e.message); }
    await syncGuild(guild);
    updatePanel(guild);
  }
  setInterval(() => { sweep().catch((e) => console.error('sweep error:', e.message)); }, SWEEP_MS);
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) updatePanel(guild);
  }, PANEL_MS);
});

client.on(Events.GuildCreate, async (guild) => {
  try { await guild.commands.set(commands); } catch (_) { /* ignore */ }
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
client.login(TOKEN);
