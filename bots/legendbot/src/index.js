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

// data.json shape: { date: 'YYYY-MM-DD', entries: { [userId]: entry } }
let data = loadJson(DATA_FILE, { date: todayKey(), entries: {} });
// board.json shape: { messageId, channelId, notifiedSessions: { [game]: true } }
let boardState = loadJson(BOARD_STATE_FILE, { messageId: null, channelId: BOARD_CHANNEL_ID, notifiedSessions: {} });

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
// Split into pages so we can fit toggle buttons within Discord's 25-component-per-message limit.
// Page 1: first 20 games (4 rows × 5). Page 2: rest + Done + Custom (max 25).
const GAMES_PAGE_SIZE = 20;
const GAME_PAGE_COUNT = 2; // last page may carry up to GAMES_PAGE_SIZE+5 games (Discord 25-component cap)
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
const VIBES = [
  { id: 'chill',       label: '😎 Chill & casual' },
  { id: 'tryhard',     label: '🔥 Tryhard/ranked' },
  { id: 'learning',    label: '📚 Learning/new' },
  { id: 'competitive', label: '🏆 Competitive' },
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
// session: { userId, step, earliestHour, latestHour, games:Set, role, vibe, comms, squad, startedAt }
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
//  game:toggle:<idx>   (idx into sorted GAMES)
//  game:custom         (opens modal)
//  game:done
//  game:custom:modal   (modal id)
//  role:<id>
//  vibe:<id>
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

function buildGamePageButtons(session, pageIndex) {
  const start = pageIndex * GAMES_PAGE_SIZE;
  const end = Math.min(GAMES.length, start + GAMES_PAGE_SIZE + (pageIndex === GAME_PAGE_COUNT - 1 ? 5 : 0));
  const buttons = [];
  for (let i = start; i < end; i++) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`game:toggle:${i}`)
        .setLabel(GAMES[i])
        .setStyle(session.games.has(GAMES[i]) ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }
  return buttons;
}

function pageIndexForGameIdx(idx) {
  return Math.min(Math.floor(idx / GAMES_PAGE_SIZE), GAME_PAGE_COUNT - 1);
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
      .setLabel("📝 My game isn't listed — I'll type it")
      .setStyle(ButtonStyle.Secondary),
  );
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
    // Send game pages as separate DMs so we stay under Discord's 25-component-per-message cap.
    session.gameMessageIds = [];
    for (let p = 0; p < GAME_PAGE_COUNT; p++) {
      const rows = chunkButtons(buildGamePageButtons(session, p), 5);
      const content = p === 0
        ? `**Step 2 of 6 — Games**\nWhat games are you feeling today? Only pick ones you're really down to play 🎮 (tap to toggle, multi-select)`
        : `…more games:`;
      const msg = await user.send({ content, components: rows });
      session.gameMessageIds.push(msg.id);
    }
    const controlsMsg = await user.send({
      content: 'When you\'re done picking, hit ✅ — or add a custom game 👇',
      components: [buildGameControlsRow(session)],
    });
    session.gameControlsMessageId = controlsMsg.id;
  } else if (session.step === 'role') {
    const rows = chunkButtons(buildSimpleButtons('role', ROLES, session.role), 3);
    await user.send({
      content: `**Step 3 of 6 — Role**\nWhat role are you feeling today?`,
      components: rows,
    });
  } else if (session.step === 'vibe') {
    const rows = chunkButtons(buildSimpleButtons('vibe', VIBES, session.vibe), 4);
    await user.send({
      content: `**Step 4 of 6 — Vibe**\nWhat's your vibe tonight?`,
      components: rows,
    });
  } else if (session.step === 'comms') {
    const rows = chunkButtons(buildSimpleButtons('comms', COMMS, session.comms), 3);
    await user.send({
      content: `**Step 5 of 6 — Comms**\nMic check?`,
      components: rows,
    });
  } else if (session.step === 'squad') {
    const rows = chunkButtons(buildSimpleButtons('squad', SQUADS, session.squad), 3);
    await user.send({
      content: `**Step 6 of 6 — Squad size**\nWhat's your squad situation?`,
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
    `✨ Vibe: ${labelOf(VIBES, s.vibe)}`,
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
    gameMessageIds: [],
    gameControlsMessageId: null,
    role: null,
    vibe: null,
    comms: null,
    squad: null,
    startedAt: Date.now(),
  });
  try {
    await user.send("Let's get you locked in. I'll ask 6 quick things 👇");
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
    data = { date: today, entries: {} };
    boardState.notifiedSessions = {};
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
// Sweep-line over interval events: every point where the running set has 2+
// players AND mutual overlap (max(earliest) <= min(latest)) defines a session.
// We emit one session per maximal contiguous set of players that all pairwise overlap.
function computeSessionsForGame(game) {
  const players = activeEntries().filter((e) => e.gamesSelected.includes(game));
  if (players.length < 2) return [];
  // Build events: at each hour boundary, who is "live"
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
    // group is guaranteed pairwise-overlapping (all live at t)
    sessions.push(finalizeSession(game, group));
  }
  // Sort largest first, then earliest start
  sessions.sort((a, b) => b.players.length - a.players.length || a.startHour - b.startHour);
  return sessions;
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
        lines.push(`  • ${p.username} (${formatHour(p.earliestHour)}–${formatHour(p.latestHour)}, ${labelOf(ROLES, p.role)}, ${labelOf(VIBES, p.vibe)})`);
      }
      lines.push('');
      continue;
    }
    for (const s of sessions) {
      const dot = s.confirmed ? '🟢' : '🟡';
      lines.push(`${dot} **${game}** — Session ${formatHour(s.startHour)} → ${formatHour(s.endHour)}`);
      for (const p of s.players) {
        lines.push(`  • <@${p.userId}> — ${labelOf(ROLES, p.role)} · ${labelOf(VIBES, p.vibe)} · ${labelOf(COMMS, p.comms)} · ${formatHour(p.earliestHour)}–${formatHour(p.latestHour)}`);
      }
      lines.push(`  Roles still needed: ${s.rolesNeeded.length ? s.rolesNeeded.map((r) => labelOf(ROLES, r)).join(', ') : '_none — squad complete_'}`);
    }
    const inSessions = playersInAnySession(sessions);
    const leftovers = allPlayers.filter((p) => !inSessions.has(p.userId));
    if (leftovers.length) {
      lines.push(`  _Also interested in **${game}** (no overlap yet):_`);
      for (const p of leftovers) {
        lines.push(`    • ${p.username} (${formatHour(p.earliestHour)}–${formatHour(p.latestHour)}, ${labelOf(ROLES, p.role)}, ${labelOf(VIBES, p.vibe)})`);
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

async function checkSessionFormingNotifications() {
  const all = activeEntries();
  const byGame = {};
  for (const e of all) for (const g of e.gamesSelected) (byGame[g] ||= []).push(e);
  const pingChannel = await client.channels.fetch(PING_CHANNEL_ID).catch(() => null);
  if (!pingChannel) return;
  for (const game of Object.keys(byGame)) {
    const sessions = computeSessionsForGame(game);
    for (const s of sessions) {
      if (s.players.length >= 3) {
        const key = `${data.date}:${game}:${s.startHour}-${s.endHour}`;
        if (boardState.notifiedSessions[key]) continue;
        boardState.notifiedSessions[key] = true;
        persistBoard();
        const mentions = s.players.map((p) => `<@${p.userId}>`).join(' ');
        const rolesNeeded = s.rolesNeeded.length ? s.rolesNeeded.map((r) => labelOf(ROLES, r)).join(', ') : 'none — full squad!';
        await pingChannel.send({
          content: `👑 **Session forming!** ${s.players.length} legends are playing **${game}** tonight — window is **${formatHour(s.startHour)} → ${formatHour(s.endHour)}**.\nRoles still needed: ${rolesNeeded}\n${mentions} — click LFG in your DM to lock in!`,
          allowedMentions: { users: s.players.map((p) => p.userId) },
        });
      }
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
    if (id.startsWith('game:toggle:')) {
      const idx = parseInt(id.split(':')[2], 10);
      const game = GAMES[idx];
      if (!game) {
        await interaction.reply({ content: 'Unknown game.', ephemeral: true });
        return;
      }
      if (session.games.has(game)) session.games.delete(game);
      else session.games.add(game);
      const pageIdx = pageIndexForGameIdx(idx);
      const rows = chunkButtons(buildGamePageButtons(session, pageIdx), 5);
      await interaction.update({ components: rows });
      // Also refresh the controls message so the Done count updates.
      try {
        if (session.gameControlsMessageId) {
          const controlsMsg = await interaction.channel.messages.fetch(session.gameControlsMessageId);
          await controlsMsg.edit({ components: [buildGameControlsRow(session)] });
        }
      } catch (e) { /* ignore */ }
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
      advance(session, 'vibe');
      await sendStep(interaction.user, session);
      return;
    }
    if (id.startsWith('vibe:')) {
      session.vibe = id.split(':')[1];
      await interaction.update({ content: `✨ Vibe: ${labelOf(VIBES, session.vibe)}`, components: [] });
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
        gamesSelected: [...session.games].map((i) => GAMES[i]),
        earliestTime: formatHour(session.earliestHour),
        latestTime: formatHour(session.latestHour),
        earliestHour: session.earliestHour,
        latestHour: session.latestHour,
        role: session.role,
        vibe: session.vibe,
        comms: session.comms,
        squadSize: session.squad,
        timestamp: new Date().toISOString(),
      };
      data.entries[interaction.user.id] = entry;
      persistData();
      sessions.delete(interaction.user.id);
      await interaction.update({ content: '✅ Posted to the board! Good luck, Legend 👑', components: [] });
      await refreshBoard();
      await checkSessionFormingNotifications();
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
  // Normalise: collapse whitespace, cap length
  const game = raw.replace(/\s+/g, ' ').slice(0, 60);
  session.games.add(game);
  await interaction.reply({ content: `✅ Added **${game}** to your picks.`, ephemeral: true });
  // Refresh the controls message Done count
  try {
    if (session.gameControlsMessageId) {
      const controlsMsg = await interaction.channel.messages.fetch(session.gameControlsMessageId);
      await controlsMsg.edit({ components: [buildGameControlsRow(session)] });
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
  }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Manually trigger the daily ping (testing)'),
    new SlashCommandBuilder().setName('board').setDescription('Manually refresh and repost the live board'),
    new SlashCommandBuilder().setName('reset').setDescription("Clear today's data and start fresh"),
  ].map((c) => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
}

// ===== Ready =====
client.once(Events.ClientReady, async (c) => {
  console.log(`LegendBot ready as ${c.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Command registration failed', e); }
  // Schedule daily ping at PING_HOUR:00 every day
  cron.schedule(`0 ${PING_HOUR} * * *`, () => {
    sendDailyPing().catch((e) => console.error('Daily ping failed', e));
  });
  console.log(`Daily ping scheduled for ${PING_HOUR}:00 every day.`);
  // Ensure a board message exists so the channel always shows something
  try { await refreshBoard(); } catch (e) { console.error('Initial board refresh failed', e); }
});

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('Discord login failed:', e.message);
  process.exit(1);
});
