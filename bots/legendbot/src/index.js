require('dotenv').config();

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  ChannelType,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const {
  DISCORD_TOKEN,
  GUILD_ID,
  PING_CHANNEL_ID,
  BOARD_CHANNEL_ID,
  DAILY_PING_HOUR,
} = process.env;

const MISSING = ['DISCORD_TOKEN', 'GUILD_ID', 'PING_CHANNEL_ID', 'BOARD_CHANNEL_ID', 'DAILY_PING_HOUR']
  .filter((k) => !process.env[k]);
if (MISSING.length) {
  console.error('Missing required env vars:', MISSING.join(', '));
  process.exit(1);
}

const PING_HOUR = parseInt(DAILY_PING_HOUR, 10);
if (Number.isNaN(PING_HOUR) || PING_HOUR < 0 || PING_HOUR > 23) {
  console.error('DAILY_PING_HOUR must be an integer between 0 and 23');
  process.exit(1);
}

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const BOARD_STATE_FILE = path.join(__dirname, '..', 'board.json');

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('Failed to read', file, e);
    return fallback;
  }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// data.json shape: { date, entries: { [userId]: entry }, ratings: { [sessionId]: {...} } }
let data = loadJson(DATA_FILE, { date: todayKey(), entries: {}, ratings: {} });
if (!data.ratings) data.ratings = {};
// board.json shape: { messageId, channelId, notifiedSessions, liveSessions }
let boardState = loadJson(BOARD_STATE_FILE, { messageId: null, channelId: BOARD_CHANNEL_ID, notifiedSessions: {}, liveSessions: {} });
if (!boardState.liveSessions) boardState.liveSessions = {};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function persistData() { saveJson(DATA_FILE, data); }
function persistBoard() { saveJson(BOARD_STATE_FILE, boardState); }

// ===== Time slots =====
// Hours are absolute: 6..23 for today, 24..28 for early morning the next day (12AM..4AM).
const EARLIEST_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]; // 6AM..11PM
const LATEST_MAX = 28; // 4AM next day
function formatHour(h) {
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh >= 12 ? 'PM' : 'AM';
  let display = hh % 12;
  if (display === 0) display = 12;
  return `${display}${ampm}`;
}

// ===== Catalogs =====
const GAMES = [
  'Among Us', 'Apex Legends', 'Ark Survival Evolved', 'Back 4 Blood',
  'Call of Duty Warzone', 'Conan Exiles', 'DayZ', 'Dead by Daylight',
  'Deep Rock Galactic', 'Destiny 2', 'Dota 2', 'Elden Ring',
  'Escape from Tarkov', 'Fall Guys', 'Final Fantasy XIV', 'Fortnite',
  'Green Hell', 'GTA Online', 'Helldivers 2', 'Hunt Showdown',
  'League of Legends', 'Minecraft', 'Monster Hunter World', "No Man's Sky",
  'Overwatch 2', 'Palworld', 'Path of Titans', 'Phasmophobia',
  'Rainbow Six Siege', 'Roblox', 'Rust', 'Sea of Thieves',
  'Sons of the Forest', 'Star Wars The Old Republic', 'Terraria', 'The Forest',
  'The Isle', 'Unturned', 'Valheim', 'Valorant', 'World of Warcraft',
].sort((a, b) => a.localeCompare(b));
// Game picker uses 2 StringSelectMenus (≤25 options each) + a controls row,
// all in ONE message. Split roughly in half alphabetically.
const GAME_MENU_SPLIT = Math.ceil(GAMES.length / 2); // first menu = first half
const ROLES = [
  { id: 'tank',     label: '🛡️ Tank' },
  { id: 'dps',      label: '⚔️ DPS/Fragger' },
  { id: 'healer',   label: '💚 Healer/Support' },
  { id: 'igl',      label: '🧠 Strategist/IGL' },
  { id: 'cc',       label: '🌀 Crowd Control' },
  { id: 'scout',    label: '👁️ Scout/Flanker' },
  { id: 'engineer', label: '🔧 Engineer/Builder' },
  { id: 'sniper',   label: '🎯 Sniper/Range' },
  { id: 'fill',     label: '🃏 Fill/Whatever' },
];
const COMMS = [
  { id: 'mic',      label: '🎙️ On mic' },
  { id: 'text',     label: '💬 Text only' },
  { id: 'flexible', label: '🤷 Flexible' },
];
const SQUADS = [
  { id: 'solo',  label: '🙋 Solo looking for full squad' },
  { id: 'duo',   label: '👥 Got 2-3 need more' },
  { id: 'open',  label: '🤝 Open to anything' },
];

function labelOf(list, id) {
  const found = list.find((x) => x.id === id);
  return found ? found.label : id;
}

// ===== Per-user wizard sessions (in memory) =====
// session: { userId, step, earliestHour, latestHour, games:Set, role, comms, squad, startedAt }
const sessions = new Map();
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function getActiveSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.startedAt > SESSION_MAX_AGE_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

// ===== Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Custom IDs:
//  daily:yes / daily:no
//  time:early:<hour>   (Q1 — pick earliest)
//  time:late:<hour>    (Q2 — pick latest)
//  game:select:<menuIdx>  (StringSelectMenu, values = full selection in that menu)
//  game:custom            (opens modal)
//  game:done
//  game:custom:modal      (modal id)
//  role:<id>
//  comms:<id>
//  squad:<id>
//  final:lfg / final:nope

function chunkButtons(buttons, perRow = 5) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + perRow)));
  }
  return rows;
}

function buildEarliestButtons() {
  return EARLIEST_HOURS.map((h) =>
    new ButtonBuilder()
      .setCustomId(`time:early:${h}`)
      .setLabel(formatHour(h))
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildLatestButtons(earliestHour) {
  const hours = [];
  for (let h = earliestHour + 1; h <= LATEST_MAX; h++) hours.push(h);
  return hours.map((h) =>
    new ButtonBuilder()
      .setCustomId(`time:late:${h}`)
      .setLabel(formatHour(h))
      .setStyle(ButtonStyle.Secondary),
  );
}

function gameMenuSlice(menuIdx) {
  return menuIdx === 0 ? GAMES.slice(0, GAME_MENU_SPLIT) : GAMES.slice(GAME_MENU_SPLIT);
}

function buildGameSelectRow(session, menuIdx) {
  const slice = gameMenuSlice(menuIdx);
  const firstLetter = slice[0][0];
  const lastLetter = slice[slice.length - 1][0];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`game:select:${menuIdx}`)
    .setPlaceholder(`Pick games (${firstLetter}–${lastLetter}) — tap to multi-select`)
    .setMinValues(0)
    .setMaxValues(slice.length)
    .addOptions(
      slice.map((g) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(g)
          .setValue(g)
          .setDefault(session.games.has(g)),
      ),
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildGameControlsRow(session) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('game:done')
      .setLabel(`✅ Done${session.games.size ? ` (${session.games.size})` : ''}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.games.size === 0),
    new ButtonBuilder()
      .setCustomId('game:custom')
      .setLabel("📝 Custom game")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildGameMessageComponents(session) {
  return [
    buildGameSelectRow(session, 0),
    buildGameSelectRow(session, 1),
    buildGameControlsRow(session),
  ];
}

function buildGameMessageContent(session) {
  const customs = [...session.games].filter((g) => !GAMES.includes(g));
  const customLine = customs.length ? `\n📝 _Custom picks:_ ${customs.join(', ')}` : '';
  return `**Step 2 of 5 — Games**\nWhat games are you feeling today? Tap a dropdown to multi-select 🎮${customLine}`;
}

function buildSimpleButtons(prefix, options, selected) {
  return options.map((o) =>
    new ButtonBuilder()
      .setCustomId(`${prefix}:${o.id}`)
      .setLabel(o.label)
      .setStyle(selected === o.id ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

async function sendStep(user, session) {
  if (session.step === 'time_early') {
    const rows = chunkButtons(buildEarliestButtons(), 5);
    await user.send({
      content: "👑 What's the earliest you might jump on today?",
      components: rows,
    });
  } else if (session.step === 'time_late') {
    const rows = chunkButtons(buildLatestButtons(session.earliestHour), 5);
    await user.send({
      content: "👑 And what's the latest you'd game till? (be real with yourself — work and school wait for no one 😅)",
      components: rows,
    });
  } else if (session.step === 'games') {
    const msg = await user.send({
      content: buildGameMessageContent(session),
      components: buildGameMessageComponents(session),
    });
    session.gameMessageId = msg.id;
  } else if (session.step === 'role') {
    const rows = chunkButtons(buildSimpleButtons('role', ROLES, session.role), 3);
    await user.send({
      content: `**Step 3 of 5 — Role**\nWhat role are you feeling today?`,
      components: rows,
    });
  } else if (session.step === 'comms') {
    const rows = chunkButtons(buildSimpleButtons('comms', COMMS, session.comms), 3);
    await user.send({
      content: `**Step 4 of 5 — Comms**\nMic check?`,
      components: rows,
    });
  } else if (session.step === 'squad') {
    const rows = chunkButtons(buildSimpleButtons('squad', SQUADS, session.squad), 3);
    await user.send({
      content: `**Step 5 of 5 — Squad size**\nWhat's your squad situation?`,
      components: rows,
    });
  } else if (session.step === 'final') {
    const summary = formatSessionSummary(session);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('final:lfg').setLabel('🎮 LFG — Post me to the board!').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('final:nope').setLabel('😴 Nevermind').setStyle(ButtonStyle.Secondary),
    );
    await user.send({ content: `Here's what I got:\n${summary}`, components: [row] });
  }
}

function formatSessionSummary(s) {
  const earliest = s.earliestHour != null ? formatHour(s.earliestHour) : '?';
  const latest = s.latestHour != null ? formatHour(s.latestHour) : '?';
  const games = [...s.games].join(', ') || '—';
  return [
    `⏰ Time: **${earliest} – ${latest}**`,
    `🎮 Games: ${games}`,
    `🎭 Role: ${labelOf(ROLES, s.role)}`,
    `🎙️ Comms: ${labelOf(COMMS, s.comms)}`,
    `👥 Squad: ${labelOf(SQUADS, s.squad)}`,
  ].join('\n');
}

async function startWizard(user) {
  sessions.set(user.id, {
    userId: user.id,
    step: 'time_early',
    earliestHour: null,
    latestHour: null,
    games: new Set(),
    gameMessageId: null,
    role: null,
    comms: null,
    squad: null,
    startedAt: Date.now(),
  });
  try {
    await user.send("Let's get you locked in. I'll ask 5 quick things 👇");
    await sendStep(user, sessions.get(user.id));
  } catch (e) {
    console.error('Failed to DM user', user.id, e.message);
    throw e;
  }
}

function advance(session, nextStep) {
  session.step = nextStep;
}

// ===== Daily ping =====
async function sendDailyPing() {
  ensureFreshDay(true);
  const channel = await client.channels.fetch(PING_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('PING_CHANNEL_ID not found');
    return;
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('daily:yes').setLabel("✅ Yes, let's game").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('daily:no').setLabel('❌ Not today').setStyle(ButtonStyle.Secondary),
  );
  await channel.send({
    content: '@everyone Hey Legend! 👑 Are you planning on gaming today?',
    components: [row],
    allowedMentions: { parse: ['everyone'] },
  });
  await refreshBoard();
}

function ensureFreshDay(forceReset = false) {
  const today = todayKey();
  if (forceReset || data.date !== today) {
    const preservedRatings = data.ratings || {};
    data = { date: today, entries: {}, ratings: preservedRatings };
    boardState.notifiedSessions = {};
    boardState.liveSessions = {};
    sessions.clear();
    persistData();
    persistBoard();
  }
}

// ===== Board / session logic =====
function activeEntries() {
  return Object.values(data.entries);
}

// For a given game, compute maximal-overlap sessions of 2+ players.
//
// "Overlap" means: there is a non-empty time window [start, end) during which
// every player in the group is online. Equivalently, max(earliestHours) <
// min(latestHours) across the group. We do NOT require identical or matching
// windows — only that the windows intersect.
//
// Sweep-line: walk every hour boundary in the day. At each boundary t we take
// the set of players "live at t" (earliest <= t <= latest). Any such set is
// pairwise-overlapping by construction, with shared window
// [max(earliests), min(latests)]. We dedupe by player-set so each maximal
// grouping is emitted once. Players naturally appear in multiple sessions if
// their window overlaps multiple groups (e.g. B overlaps both A and C in the
// classic A(1-3) B(2-6) C(5-10) case → emits {A,B} 2-3 and {B,C} 5-6).
function computeSessionsForGame(game) {
  const players = activeEntries().filter((e) => e.gamesSelected.includes(game));
  if (players.length < 2) return [];
  const points = new Set();
  for (const p of players) { points.add(p.earliestHour); points.add(p.latestHour); }
  const sortedPts = [...points].sort((a, b) => a - b);
  const seen = new Set(); // dedupe by player-set signature
  const sessions = [];
  for (const t of sortedPts) {
    const group = players.filter((p) => p.earliestHour <= t && p.latestHour >= t);
    if (group.length < 2) continue;
    const sig = group.map((p) => p.userId).sort().join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const s = finalizeSession(game, group);
    // Reject zero-width touches (e.g. A ends 3PM, B starts 3PM): need real shared time.
    if (s.endHour <= s.startHour) continue;
    sessions.push(s);
  }
  // Sort largest first, then earliest start
  sessions.sort((a, b) => b.players.length - a.players.length || a.startHour - b.startHour);
  return sessions;
}

// Stable signature for a player group — used in session ids so two different
// groups that happen to share the same start/end window don't collide.
function playerSetSig(players) {
  return players.map((p) => p.userId).sort().join('-').slice(0, 40);
}

function playersInAnySession(sessions) {
  const ids = new Set();
  for (const s of sessions) for (const p of s.players) ids.add(p.userId);
  return ids;
}

function finalizeSession(game, players) {
  const startHour = Math.max(...players.map((p) => p.earliestHour));
  const endHour = Math.min(...players.map((p) => p.latestHour));
  const rolesFilled = new Set(players.map((p) => p.role));
  const allRoleIds = ROLES.map((r) => r.id);
  const rolesNeeded = allRoleIds.filter((r) => !rolesFilled.has(r) && r !== 'fill');
  return { game, players, startHour, endHour, rolesNeeded, confirmed: players.length >= 3 };
}

function buildBoardContent() {
  ensureFreshDay(false);
  const all = activeEntries();
  if (all.length === 0) {
    return `👑 **Legend Board — ${data.date}**\n_No one's checked in yet today. Click ✅ on the daily ping to join the board!_`;
  }
  // Group players by game
  const byGame = {};
  for (const e of all) {
    for (const g of e.gamesSelected) {
      (byGame[g] ||= []).push(e);
    }
  }
  const games = Object.keys(byGame).sort();
  const lines = [`👑 **Legend Board — ${data.date}**`, `_${all.length} legend${all.length === 1 ? '' : 's'} checked in_`, ''];

  for (const game of games) {
    const sessions = computeSessionsForGame(game);
    const allPlayers = byGame[game];
    if (sessions.length === 0) {
      lines.push(`🎮 **${game}** — ${allPlayers.length} interested`);
      for (const p of allPlayers) {
        lines.push(`  • ${p.username} (${formatHour(p.earliestHour)}–${formatHour(p.latestHour)}, ${labelOf(ROLES, p.role)}, ${labelOf(COMMS, p.comms)})`);
      }
      lines.push('');
      continue;
    }
    for (const s of sessions) {
      const dot = s.confirmed ? '🟢' : '🟡';
      lines.push(`${dot} **${game}** — 🕒 Shared window **${formatHour(s.startHour)}–${formatHour(s.endHour)}** _(when all ${s.players.length} are online together)_`);
      for (const p of s.players) {
        lines.push(`  • <@${p.userId}> — ${labelOf(ROLES, p.role)} · ${labelOf(COMMS, p.comms)} · _online ${formatHour(p.earliestHour)}–${formatHour(p.latestHour)}_`);
      }
      lines.push(`  Roles still needed: ${s.rolesNeeded.length ? s.rolesNeeded.map((r) => labelOf(ROLES, r)).join(', ') : '_none — squad complete_'}`);
    }
    const inSessions = playersInAnySession(sessions);
    const leftovers = allPlayers.filter((p) => !inSessions.has(p.userId));
    if (leftovers.length) {
      lines.push(`  _Also interested in **${game}** (no overlap yet):_`);
      for (const p of leftovers) {
        lines.push(`    • ${p.username} (${formatHour(p.earliestHour)}–${formatHour(p.latestHour)}, ${labelOf(ROLES, p.role)}, ${labelOf(COMMS, p.comms)})`);
      }
    }
    lines.push('');
  }
  let content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1890) + '\n…(truncated)';
  return content;
}

async function refreshBoard() {
  const channel = await client.channels.fetch(BOARD_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('BOARD_CHANNEL_ID not found');
    return;
  }
  const content = buildBoardContent();
  let msg = null;
  if (boardState.messageId) {
    msg = await channel.messages.fetch(boardState.messageId).catch(() => null);
  }
  if (msg) {
    await msg.edit({ content, allowedMentions: { parse: [] } });
  } else {
    msg = await channel.send({ content, allowedMentions: { parse: [] } });
    boardState.messageId = msg.id;
    boardState.channelId = channel.id;
    persistBoard();
    try { await msg.pin(); } catch (e) { /* ignore if no permission */ }
  }
}

// ===== Live session lifecycle (Phases 2-4) =====
function anchorDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function sessionStartDate(ls) {
  return new Date(anchorDate(ls.date).getTime() + ls.startHour * 3600 * 1000);
}
function sessionActualEndHour(ls) {
  // End = latest 'latestHour' among confirmed players who have entries; fallback to ls.endHour.
  const byId = data.entries;
  const ends = ls.confirmed.map((u) => byId[u]?.latestHour).filter((h) => typeof h === 'number');
  if (!ends.length) return ls.endHour;
  return Math.max(...ends);
}
function sessionActualEndDate(ls) {
  return new Date(anchorDate(ls.date).getTime() + sessionActualEndHour(ls) * 3600 * 1000);
}

function buildSessionCardContent(ls) {
  const byId = data.entries;
  const filledRoles = new Set();
  for (const uid of ls.confirmed) {
    const e = byId[uid];
    if (e && e.role && e.role !== 'fill') filledRoles.add(e.role);
  }
  const roleLine = ROLES
    .filter((r) => r.id !== 'fill')
    .map((r) => `${filledRoles.has(r.id) ? '✅' : '⚠️'} ${r.label}`)
    .join(' · ');
  const confMentions = ls.confirmed.length ? ls.confirmed.map((u) => `<@${u}>`).join(' ') : '_nobody yet_';
  const lateLine = ls.late.length ? ls.late.map((u) => `<@${u}>`).join(' ') : '_nobody_';
  const outLine = ls.cantMake.length ? ls.cantMake.map((u) => `<@${u}>`).join(' ') : '_nobody_';
  return [
    `👑 **Session locked in!** **${ls.game}**`,
    `🕒 **Shared window:** **${formatHour(ls.startHour)}–${formatHour(sessionActualEndHour(ls))}** _(when everyone's online together)_`,
    `${confMentions} are all down!`,
    `**Roles:** ${roleLine}`,
    '',
    `✅ **Confirmed (${ls.confirmed.length}):** ${confMentions}`,
    `👀 **Joining late (${ls.late.length}):** ${lateLine}`,
    `😴 **Can't make it (${ls.cantMake.length}):** ${outLine}`,
  ].join('\n');
}

function buildSessionRow(ls) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sess:in:${ls.id}`).setLabel("✅ I'm in — confirm me").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sess:late:${ls.id}`).setLabel("👀 I'll be joining late").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sess:out:${ls.id}`).setLabel("😴 Can't make it").setStyle(ButtonStyle.Secondary),
  );
}

async function fetchSessionMessage(ls) {
  const channel = await client.channels.fetch(ls.channelId).catch(() => null);
  if (!channel || !ls.messageId) return { channel, msg: null };
  const msg = await channel.messages.fetch(ls.messageId).catch(() => null);
  return { channel, msg };
}

async function updateSessionCard(ls) {
  const { msg } = await fetchSessionMessage(ls);
  if (!msg) return;
  await msg.edit({
    content: buildSessionCardContent(ls),
    components: ls.fellApart || ls.endedPosted ? [] : [buildSessionRow(ls)],
    allowedMentions: { users: [...ls.confirmed, ...ls.late] },
  });
}

async function handleSessionFellApart(ls) {
  const { channel, msg } = await fetchSessionMessage(ls);
  if (msg) { try { await msg.unpin(); } catch {} }
  ls.pinned = false;
  const stillInterested = activeEntries().filter((e) => e.gamesSelected.includes(ls.game)).length;
  if (channel) {
    await channel.send({
      content: `Session fell apart 😢 — still **${stillInterested}** people interested in **${ls.game}** if anyone wants to rally!`,
      allowedMentions: { parse: [] },
    });
  }
  await updateSessionCard(ls);
  persistBoard();
}

async function createOrSyncSessionCards() {
  const channel = await client.channels.fetch(PING_CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const all = activeEntries();
  const byGame = {};
  for (const e of all) for (const g of e.gamesSelected) (byGame[g] ||= []).push(e);
  for (const game of Object.keys(byGame)) {
    const groups = computeSessionsForGame(game);
    for (const s of groups) {
      if (s.players.length < 3) continue;
      const id = `${data.date}:${game}:${s.startHour}-${s.endHour}:${playerSetSig(s.players)}`;
      let ls = boardState.liveSessions[id];
      // Allow a fell-apart session to recover if 3+ overlap again.
      if (ls && ls.fellApart && !ls.endedPosted) {
        ls.fellApart = false;
        const known = new Set([...ls.confirmed, ...ls.late, ...ls.cantMake]);
        for (const p of s.players) if (!known.has(p.userId)) ls.confirmed.push(p.userId);
        const channel2 = await client.channels.fetch(ls.channelId).catch(() => null);
        const oldMsg = ls.messageId && channel2 ? await channel2.messages.fetch(ls.messageId).catch(() => null) : null;
        if (oldMsg) { try { await oldMsg.unpin(); } catch {} try { await oldMsg.delete(); } catch {} }
        ls.messageId = null;
        const newMsg = await channel.send({
          content: `🔁 **Session relocked!** ${buildSessionCardContent(ls)}`,
          components: [buildSessionRow(ls)],
          allowedMentions: { users: ls.confirmed },
        });
        ls.messageId = newMsg.id;
        try { await newMsg.pin(); ls.pinned = true; } catch {}
        persistBoard();
        continue;
      }
      if (!ls) {
        ls = {
          id, date: data.date, game,
          startHour: s.startHour, endHour: s.endHour,
          confirmed: s.players.map((p) => p.userId),
          late: [], cantMake: [],
          channelId: PING_CHANNEL_ID, messageId: null, pinned: false,
          preSessionPosted: false, endedPosted: false, fellApart: false,
          ratings: {},
        };
        boardState.liveSessions[id] = ls;
        const msg = await channel.send({
          content: buildSessionCardContent(ls),
          components: [buildSessionRow(ls)],
          allowedMentions: { users: ls.confirmed },
        });
        ls.messageId = msg.id;
        try { await msg.pin(); ls.pinned = true; } catch {}
        persistBoard();
      } else if (!ls.fellApart && !ls.endedPosted) {
        // Sync: any newly-submitted players who overlap this window and aren't already tracked
        // get auto-added to confirmed (they can click "Can't make it" to drop out).
        let changed = false;
        for (const p of s.players) {
          if (!ls.confirmed.includes(p.userId) && !ls.late.includes(p.userId) && !ls.cantMake.includes(p.userId)) {
            ls.confirmed.push(p.userId);
            changed = true;
          }
        }
        if (changed) { persistBoard(); await updateSessionCard(ls); }
      }
    }
  }
}

async function sendPreSessionPing(ls) {
  const channel = await client.channels.fetch(PING_CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const confList = ls.confirmed.length ? ls.confirmed.map((u) => `<@${u}>`).join(' ') : '_nobody yet_';
  const lateList = ls.late.length ? ls.late.map((u) => `<@${u}>`).join(' ') : '_nobody_';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sess:late:${ls.id}`).setLabel("👀 Joining late — count me in").setStyle(ButtonStyle.Primary),
  );
  await channel.send({
    content: `⏰ **${ls.game}** session starts in 30 minutes!\n**Confirmed:** ${confList}\n**Joining late:** ${lateList}\nGet your game open! 🎮`,
    components: [row],
    allowedMentions: { users: [...ls.confirmed, ...ls.late] },
  });
}

function buildRatingRow(sessionId) {
  return new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((n) =>
      new ButtonBuilder().setCustomId(`rate:${sessionId}:${n}`).setLabel(`⭐${n}`).setStyle(ButtonStyle.Secondary),
    ),
  );
}

async function sendSessionEndedMessage(ls) {
  const { channel, msg } = await fetchSessionMessage(ls);
  if (msg) { try { await msg.unpin(); } catch {} }
  ls.pinned = false;
  if (!channel) return;
  const players = [...new Set([...ls.confirmed, ...ls.late])];
  const mentions = players.map((u) => `<@${u}>`).join(' ');
  const ratingMsg = await channel.send({
    content: `🎮 **GG Legends!** How was the **${ls.game}** session tonight? ${mentions}\nRate it! Your ratings help us find better sessions next time 👑`,
    components: [buildRatingRow(ls.id)],
    allowedMentions: { users: players },
  });
  ls.ratingMessageId = ratingMsg.id;
  // Seed rating record
  if (!data.ratings[ls.id]) {
    data.ratings[ls.id] = {
      sessionId: ls.id, game: ls.game, date: ls.date,
      players, ratings: {}, average: null,
    };
    persistData();
  }
  // Also refresh the session card (strip buttons)
  await updateSessionCard(ls);
}

// Scheduler tick — checks every minute for pre-session pings and session ends.
async function liveSessionTick() {
  const now = new Date();
  for (const ls of Object.values(boardState.liveSessions)) {
    try {
      if (ls.endedPosted) continue;
      const startAt = sessionStartDate(ls);
      const endAt = sessionActualEndDate(ls);
      if (!ls.fellApart && !ls.preSessionPosted && now >= new Date(startAt.getTime() - 30 * 60 * 1000) && now < startAt) {
        await sendPreSessionPing(ls);
        ls.preSessionPosted = true;
        persistBoard();
      }
      if (now >= endAt) {
        await sendSessionEndedMessage(ls);
        ls.endedPosted = true;
        persistBoard();
      }
    } catch (e) {
      console.error('liveSessionTick error for', ls.id, e);
    }
  }
}

// ===== Interaction handling =====
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      return handleSlash(interaction);
    }
    if (interaction.isModalSubmit()) {
      return handleModal(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      return handleSelectMenu(interaction);
    }
    if (!interaction.isButton()) return;

    const id = interaction.customId;

    if (id === 'daily:yes') {
      await interaction.reply({ content: "Sliding into your DMs 👑", ephemeral: true });
      try {
        await startWizard(interaction.user);
      } catch (e) {
        await interaction.followUp({ content: "I couldn't DM you — enable DMs from server members and try again.", ephemeral: true });
      }
      return;
    }
    if (id === 'daily:no') {
      await interaction.reply({ content: 'No worries! See you tomorrow 👋', ephemeral: true });
      return;
    }

    // ===== Session card buttons (public channels) =====
    if (id.startsWith('sess:')) {
      const parts = id.split(':');
      const action = parts[1]; // in | late | out
      const sessionId = parts.slice(2).join(':');
      const ls = boardState.liveSessions[sessionId];
      if (!ls) {
        await interaction.reply({ content: 'That session is no longer active.', ephemeral: true });
        return;
      }
      if (ls.endedPosted) {
        await interaction.reply({ content: 'That session has already ended.', ephemeral: true });
        return;
      }
      const uid = interaction.user.id;
      ls.confirmed = ls.confirmed.filter((u) => u !== uid);
      ls.late = ls.late.filter((u) => u !== uid);
      ls.cantMake = ls.cantMake.filter((u) => u !== uid);
      let label = '';
      if (action === 'in') { ls.confirmed.push(uid); label = "you're confirmed ✅"; ls.fellApart = false; }
      else if (action === 'late') { ls.late.push(uid); label = 'marked as joining late 👀'; }
      else if (action === 'out') { ls.cantMake.push(uid); label = "marked as can't make it 😴"; }
      persistBoard();
      if (ls.confirmed.length < 3 && !ls.fellApart && action !== 'in') {
        ls.fellApart = true;
        persistBoard();
        await handleSessionFellApart(ls);
      } else {
        await updateSessionCard(ls);
      }
      await interaction.reply({ content: `Got it — ${label}.`, ephemeral: true });
      return;
    }

    // ===== Rating buttons (public channel) =====
    if (id.startsWith('rate:')) {
      const parts = id.split(':');
      const stars = parseInt(parts[parts.length - 1], 10);
      const sessionId = parts.slice(1, -1).join(':');
      const ls = boardState.liveSessions[sessionId];
      const rec = data.ratings[sessionId];
      if (!ls || !rec) {
        await interaction.reply({ content: 'That rating window is closed.', ephemeral: true });
        return;
      }
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        await interaction.reply({ content: 'Invalid rating.', ephemeral: true });
        return;
      }
      if (!rec.players.includes(interaction.user.id)) {
        await interaction.reply({ content: 'Only players from that session can rate it 👑', ephemeral: true });
        return;
      }
      rec.ratings[interaction.user.id] = stars;
      const vals = Object.values(rec.ratings);
      rec.average = vals.reduce((a, b) => a + b, 0) / vals.length;
      persistData();
      await interaction.reply({ content: `Thanks for rating ${ls.game} — ⭐${stars}!`, ephemeral: true });
      return;
    }

    // Wizard buttons (DM only)
    if (interaction.channel?.type !== ChannelType.DM) {
      await interaction.reply({ content: 'That button only works in our DM 😉', ephemeral: true });
      return;
    }

    const session = getActiveSession(interaction.user.id);
    if (!session) {
      await interaction.reply({ content: 'This session expired. Click ✅ on the daily ping again to restart.', ephemeral: true });
      return;
    }

    if (id.startsWith('time:early:')) {
      const hour = parseInt(id.split(':')[2], 10);
      session.earliestHour = hour;
      session.latestHour = null;
      await interaction.update({
        content: `Earliest: **${formatHour(hour)}** ✅`,
        components: [],
      });
      advance(session, 'time_late');
      await sendStep(interaction.user, session);
      return;
    }
    if (id.startsWith('time:late:')) {
      const hour = parseInt(id.split(':')[2], 10);
      if (session.earliestHour == null || hour <= session.earliestHour) {
        await interaction.reply({ content: 'Pick a time after your earliest.', ephemeral: true });
        return;
      }
      session.latestHour = hour;
      await interaction.update({
        content: `Latest: **${formatHour(hour)}** ✅`,
        components: [],
      });
      await interaction.user.send(
        `Got it! You're online from **${formatHour(session.earliestHour)}** to **${formatHour(session.latestHour)}** 🎮 Let's find your squad!`,
      );
      advance(session, 'games');
      await sendStep(interaction.user, session);
      return;
    }
    if (id === 'game:custom') {
      const modal = new ModalBuilder()
        .setCustomId('game:custom:modal')
        .setTitle('Add a custom game')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('gameName')
              .setLabel("What's the game?")
              .setPlaceholder('e.g. Lethal Company')
              .setStyle(TextInputStyle.Short)
              .setMinLength(2)
              .setMaxLength(60)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return;
    }
    if (id === 'game:done') {
      if (session.games.size === 0) {
        await interaction.reply({ content: 'Pick at least one game.', ephemeral: true });
        return;
      }
      const picked = [...session.games].join(', ');
      await interaction.update({
        content: `🎮 **Games locked in:** ${picked}\nNice taste 👀`,
        components: [],
      });
      advance(session, 'role');
      await sendStep(interaction.user, session);
      return;
    }
    if (id.startsWith('role:')) {
      session.role = id.split(':')[1];
      await interaction.update({ content: `🎭 Role: ${labelOf(ROLES, session.role)}`, components: [] });
      advance(session, 'comms');
      await sendStep(interaction.user, session);
      return;
    }
    if (id.startsWith('comms:')) {
      session.comms = id.split(':')[1];
      await interaction.update({ content: `🎙️ Comms: ${labelOf(COMMS, session.comms)}`, components: [] });
      advance(session, 'squad');
      await sendStep(interaction.user, session);
      return;
    }
    if (id.startsWith('squad:')) {
      session.squad = id.split(':')[1];
      await interaction.update({ content: `👥 Squad: ${labelOf(SQUADS, session.squad)}`, components: [] });
      advance(session, 'final');
      await sendStep(interaction.user, session);
      return;
    }
    if (id === 'final:lfg') {
      ensureFreshDay(false);
      const entry = {
        userId: interaction.user.id,
        username: interaction.user.username,
        gamesSelected: [...session.games],
        earliestTime: formatHour(session.earliestHour),
        latestTime: formatHour(session.latestHour),
        earliestHour: session.earliestHour,
        latestHour: session.latestHour,
        role: session.role,
        comms: session.comms,
        squadSize: session.squad,
        timestamp: new Date().toISOString(),
      };
      data.entries[interaction.user.id] = entry;
      persistData();
      sessions.delete(interaction.user.id);
      await interaction.update({ content: '✅ Posted to the board! Good luck, Legend 👑', components: [] });
      await refreshBoard();
      await createOrSyncSessionCards();
      return;
    }
    if (id === 'final:nope') {
      sessions.delete(interaction.user.id);
      await interaction.update({ content: 'No problem — maybe next time 👋', components: [] });
      return;
    }
  } catch (err) {
    console.error('Interaction error', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: 'Something went sideways. Try again.', ephemeral: true }); } catch {}
    }
  }
});

// ===== Select-menu submissions =====
async function handleSelectMenu(interaction) {
  if (!interaction.customId.startsWith('game:select:')) return;
  const session = getActiveSession(interaction.user.id);
  if (!session) {
    await interaction.reply({ content: 'This session expired. Click ✅ on the daily ping to restart.', ephemeral: true });
    return;
  }
  const menuIdx = parseInt(interaction.customId.split(':')[2], 10);
  const sliceSet = new Set(gameMenuSlice(menuIdx));
  const newSelections = new Set(interaction.values);
  // Replace this menu's contribution: drop all of this slice's games, then re-add what's selected.
  for (const g of sliceSet) session.games.delete(g);
  for (const g of newSelections) session.games.add(g);
  await interaction.update({
    content: buildGameMessageContent(session),
    components: buildGameMessageComponents(session),
  });
}

// ===== Modal submissions =====
async function handleModal(interaction) {
  if (interaction.customId !== 'game:custom:modal') return;
  const session = getActiveSession(interaction.user.id);
  if (!session) {
    await interaction.reply({ content: 'This session expired. Click ✅ on the daily ping to restart.', ephemeral: true });
    return;
  }
  const raw = interaction.fields.getTextInputValue('gameName').trim();
  if (!raw) {
    await interaction.reply({ content: 'Empty game name — try again.', ephemeral: true });
    return;
  }
  const game = raw.replace(/\s+/g, ' ').slice(0, 60);
  session.games.add(game);
  await interaction.reply({ content: `✅ Added **${game}** to your picks.`, ephemeral: true });
  // Refresh the single game message so Done count + custom-picks line update.
  try {
    if (session.gameMessageId) {
      const msg = await interaction.channel.messages.fetch(session.gameMessageId);
      await msg.edit({
        content: buildGameMessageContent(session),
        components: buildGameMessageComponents(session),
      });
    }
  } catch (e) { /* ignore */ }
}

// ===== Slash commands =====
async function handleSlash(interaction) {
  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: 'Triggering daily ping…', ephemeral: true });
    await sendDailyPing();
  } else if (interaction.commandName === 'board') {
    await interaction.reply({ content: 'Refreshing board…', ephemeral: true });
    // Force fresh board message (unpin old, post new)
    const channel = await client.channels.fetch(BOARD_CHANNEL_ID).catch(() => null);
    if (channel && boardState.messageId) {
      const old = await channel.messages.fetch(boardState.messageId).catch(() => null);
      if (old) { try { await old.unpin(); } catch {} try { await old.delete(); } catch {} }
      boardState.messageId = null;
      persistBoard();
    }
    await refreshBoard();
  } else if (interaction.commandName === 'reset') {
    ensureFreshDay(true);
    await refreshBoard();
    await interaction.reply({ content: "Today's data cleared.", ephemeral: true });
  } else if (interaction.commandName === 'testsession') {
    ensureFreshDay(false);
    const stamp = Date.now();
    const fakes = [
      { id: `test-${stamp}-tank`,   username: 'TestLegend_Tank',   role: 'tank' },
      { id: `test-${stamp}-dps`,    username: 'TestLegend_DPS',    role: 'dps' },
      { id: `test-${stamp}-healer`, username: 'TestLegend_Healer', role: 'healer' },
    ];
    for (const u of fakes) {
      data.entries[u.id] = {
        userId: u.id, username: u.username,
        gamesSelected: ['The Isle'],
        earliestHour: 21, latestHour: 24,
        earliestTime: '9PM', latestTime: '12AM',
        role: u.role, comms: 'mic', squadSize: 'open',
        timestamp: new Date().toISOString(),
      };
    }
    persistData();
    await interaction.reply({
      content: '🧪 Simulated 3 players on **The Isle** 9PM–12AM. Posting session card to the ping channel now…\n_(Player names will show as raw IDs since they are fake users.)_',
      ephemeral: true,
    });
    await refreshBoard();
    await createOrSyncSessionCards();
  }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Manually trigger the daily ping (testing)'),
    new SlashCommandBuilder().setName('board').setDescription('Manually refresh and repost the live board'),
    new SlashCommandBuilder().setName('reset').setDescription("Clear today's data and start fresh"),
    new SlashCommandBuilder().setName('testsession').setDescription('Simulate a 3-player session on The Isle to preview the card'),
  ].map((c) => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
}

// ===== Ready =====
client.once(Events.ClientReady, async (c) => {
  console.log(`LegendBot ready as ${c.user.tag}`);
  // Clear any stuck in-memory wizard sessions so DMs always start fresh on restart.
  sessions.clear();
  try { await registerCommands(); } catch (e) { console.error('Command registration failed', e); }
  // Schedule daily ping at PING_HOUR:00 every day
  cron.schedule(`0 ${PING_HOUR} * * *`, () => {
    sendDailyPing().catch((e) => console.error('Daily ping failed', e));
  });
  console.log(`Daily ping scheduled for ${PING_HOUR}:00 every day.`);
  // Ensure a board message exists so the channel always shows something
  try { await refreshBoard(); } catch (e) { console.error('Initial board refresh failed', e); }
  // Tick every minute for pre-session pings and session-ended ratings
  liveSessionTick().catch((e) => console.error('liveSessionTick init failed', e));
  setInterval(() => { liveSessionTick().catch((e) => console.error('liveSessionTick failed', e)); }, 60 * 1000);
});

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('Discord login failed:', e.message);
  process.exit(1);
});
