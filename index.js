import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType
} from "discord.js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pg;

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

/* =========================
   DATABASE (POSTGRES)
========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test DB connection (Railway-safe)
await pool.query("SELECT 1");
console.log("✅ PostgreSQL connected");

/* =========================
   INIT TABLES
========================= */
await pool.query(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  username TEXT,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  elo INT DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  format TEXT,
  map TEXT,
  mode TEXT,
  captainA TEXT,
  captainB TEXT,
  channel_id TEXT,
  vcA TEXT,
  vcB TEXT,
  teamA JSONB,
  teamB JSONB,
  winner TEXT,
  reported BOOLEAN DEFAULT FALSE
);
`);

/* =========================
   CONFIG
========================= */
const QUEUE_CHANNEL_ID = process.env.QUEUE_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const CATEGORY_MATCH_ID = process.env.CATEGORY_MATCH_ID;
const CATEGORY_VOICE_ID = process.env.CATEGORY_VOICE_ID;

/* =========================
   MAPS & MODES
========================= */
const MAPS = ["Skidrow", "Terminal", "Highrise", "Invasion"];
const MODES = ["Hardpoint", "Search & Destroy", "Control"];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/* =========================
   QUEUES
========================= */
const formats = { "8s": 8, "6s": 6, "4s": 4 };
let queues = { "8s": [], "6s": [], "4s": [] };
let queueMessages = {};

/* =========================
   HELPERS
========================= */
const id = () => Math.random().toString(36).slice(2, 9);

async function ensurePlayer(user) {
  await pool.query(
    `INSERT INTO players (id, username)
     VALUES ($1,$2)
     ON CONFLICT (id) DO NOTHING`,
    [user.id, user.username]
  );
}

/* =========================
   QUEUE EMBEDS
========================= */
async function updateQueueEmbeds(guild) {
  const channel = await guild.channels.fetch(QUEUE_CHANNEL_ID);

  for (const format of Object.keys(formats)) {
    const needed = formats[format];
    const players = queues[format];

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${format.toUpperCase()} Queue`)
      .setColor(0x00ae86)
      .setDescription(
        players.length
          ? players.map(p => `<@${p}>`).join("\n")
          : "_No players queued_"
      )
      .setFooter({ text: `${players.length} / ${needed}` });

    if (!queueMessages[format]) {
      const msg = await channel.send({ embeds: [embed] });
      queueMessages[format] = msg.id;
    } else {
      const msg = await channel.messages.fetch(queueMessages[format]);
      await msg.edit({ embeds: [embed] });
    }

    if (players.length >= needed) {
      const teamA = players.splice(0, needed / 2);
      const teamB = players.splice(0, needed / 2);
      await createMatch(guild, format, teamA, teamB);
      await updateQueueEmbeds(guild);
    }
  }
}

/* =========================
   MATCH CREATION
========================= */
async function createMatch(guild, format, teamA, teamB) {
  const matchId = id();
  const map = pick(MAPS);
  const mode = pick(MODES);

  const captainA = teamA[0];
  const captainB = teamB[0];

  const textChannel = await guild.channels.create({
    name: `${captainA}-vs-${captainB}`,
    type: ChannelType.GuildText,
    parent: CATEGORY_MATCH_ID
  });

  const vcA = await guild.channels.create({
    name: "Team A",
    type: ChannelType.GuildVoice,
    parent: CATEGORY_VOICE_ID
  });

  const vcB = await guild.channels.create({
    name: "Team B",
    type: ChannelType.GuildVoice,
    parent: CATEGORY_VOICE_ID
  });

  await pool.query(
    `INSERT INTO matches
     (id, format, map, mode, captainA, captainB, channel_id, vcA, vcB, teamA, teamB)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      matchId,
      format,
      map,
      mode,
      captainA,
      captainB,
      textChannel.id,
      vcA.id,
      vcB.id,
      JSON.stringify(teamA),
      JSON.stringify(teamB)
    ]
  );

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Match ${matchId}`)
    .setColor(0xffb703)
    .addFields(
      { name: "Format", value: format.toUpperCase(), inline: true },
      { name: "Map", value: map, inline: true },
      { name: "Mode", value: mode, inline: true },
      { name: "Captain A", value: `<@${captainA}>`, inline: true },
      { name: "Captain B", value: `<@${captainB}>`, inline: true },
      { name: "Team A", value: teamA.map(p => `<@${p}>`).join("\n") },
      { name: "Team B", value: teamB.map(p => `<@${p}>`).join("\n") }
    )
    .setFooter({ text: `Report with /report ${matchId}` });

  await textChannel.send({ embeds: [embed] });
}

/* =========================
   READY
========================= */
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  client.guilds.cache.forEach(g => updateQueueEmbeds(g));
});

/* =========================
   INTERACTIONS
========================= */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  /* ===== REPORT ===== */
  if (interaction.commandName === "report") {
    if (interaction.channel.id !== REPORT_CHANNEL_ID) {
      return interaction.reply({ content: "❌ Wrong channel.", ephemeral: true });
    }

    const matchId = interaction.options.getString("match_id");
    const result = interaction.options.getString("result");

    const { rows } = await pool.query(
      `SELECT * FROM matches WHERE id=$1 AND reported=FALSE`,
      [matchId]
    );

    if (!rows.length) {
      return interaction.reply({ content: "❌ Match not found or already reported.", ephemeral: true });
    }

    const match = rows[0];

    const captainA = match.capitana;
    const captainB = match.captainb;

    if (interaction.user.id !== captainA && interaction.user.id !== captainB) {
      return interaction.reply({
        content: "❌ Only captains can report this match.",
        ephemeral: true
      });
    }

    const teamA = match.teama;
    const teamB = match.teamb;

    const winners = result === "A" ? teamA : teamB;
    const losers = result === "A" ? teamB : teamA;

    for (const p of winners) {
      await pool.query(
        `UPDATE players SET wins=wins+1, elo=elo+10 WHERE id=$1`,
        [p]
      );
    }

    for (const p of losers) {
      await pool.query(
        `UPDATE players SET losses=losses+1, elo=GREATEST(0, elo-10) WHERE id=$1`,
        [p]
      );
    }

    await pool.query(
      `UPDATE matches SET reported=TRUE, winner=$1 WHERE id=$2`,
      [result, matchId]
    );

    await interaction.reply({ content: "✅ Match reported successfully.", ephemeral: true });
  }
});

/* =========================
   SAFETY
========================= */
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

/* =========================
   LOGIN
========================= */
client.login(process.env.DISCORD_TOKEN);
