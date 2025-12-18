import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import path from "path";
import http from "http";

dotenv.config();

/* =========================
   KEEP ALIVE (FREE HOSTS)
========================= */
http.createServer((req, res) => res.end("OK")).listen(process.env.PORT || 8080);

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

/* =========================
   DATABASE (SAFE SQLITE)
========================= */
const DB_PATH = path.resolve("./database.sqlite");
const db = new sqlite3.Database(DB_PATH);

/* =========================
   TABLES
========================= */
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      elo INTEGER DEFAULT 1000
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      format TEXT,
      channel_id TEXT,
      vcA TEXT,
      vcB TEXT,
      teamA TEXT,
      teamB TEXT,
      winner TEXT,
      reported INTEGER DEFAULT 0
    )
  `);
});

/* =========================
   CONFIG
========================= */
const QUEUE_CHANNEL_ID = process.env.QUEUE_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const STATS_CHANNEL_ID = process.env.STATS_CHANNEL_ID; // new for stats
const CATEGORY_MATCH_ID = process.env.CATEGORY_MATCH_ID;
const CATEGORY_VOICE_ID = process.env.CATEGORY_VOICE_ID;

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

function ensurePlayer(user) {
  db.run(
    "INSERT OR IGNORE INTO players (id, username) VALUES (?, ?)",
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
      .setColor(0x00AE86)
      .setDescription(
        players.length ? players.map(id => `<@${id}>`).join("\n") : "_No players queued_"
      )
      .setFooter({ text: `${players.length} / ${needed}` });

    if (!queueMessages[format]) {
      const msg = await channel.send({ embeds: [embed] });
      queueMessages[format] = msg.id;
    } else {
      const msg = await channel.messages.fetch(queueMessages[format]);
      await msg.edit({ embeds: [embed] });
    }

    // Check if enough players for a match
    if (players.length >= needed) {
      const teamA = players.splice(0, needed / 2);
      const teamB = players.splice(0, needed / 2);
      createMatch(guild, format, teamA, teamB);
      await updateQueueEmbeds(guild);
    }
  }
}

/* =========================
   MATCH CREATION
========================= */
async function createMatch(guild, format, teamA, teamB) {
  const matchId = id();
  const captainA = teamA[0];
  const captainB = teamB[0];

  // Temporary text channel for lobby
  const matchChannel = await guild.channels.create({
    name: `${captainA}-vs-${captainB}`,
    type: ChannelType.GuildText,
    parent: CATEGORY_MATCH_ID
  });

  // Voice channels for teams
  const vcA = await guild.channels.create({
    name: `Team-A-${matchId}`,
    type: ChannelType.GuildVoice,
    parent: CATEGORY_VOICE_ID
  });
  const vcB = await guild.channels.create({
    name: `Team-B-${matchId}`,
    type: ChannelType.GuildVoice,
    parent: CATEGORY_VOICE_ID
  });

  // Store in DB
  db.run(
    `INSERT INTO matches (id, format, channel_id, vcA, vcB, teamA, teamB) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [matchId, format, matchChannel.id, vcA.id, vcB.id, JSON.stringify(teamA), JSON.stringify(teamB)]
  );

  // Notify players
  matchChannel.send({
    content: `🏆 **Match ${matchId} Created!**
Team A: ${teamA.map(p => `<@${p}>`).join(", ")}
Team B: ${teamB.map(p => `<@${p}>`).join(", ")}
Use /report in <#${REPORT_CHANNEL_ID}> with Match ID **${matchId}** to report results.`
  });
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
  const guild = interaction.guild;

  /* ===== REMATCH BUTTON ===== */
  if (interaction.isButton() && interaction.customId.startsWith("rematch_")) {
    await interaction.deferReply({ ephemeral: true });
    const matchId = interaction.customId.split("_")[1];
    db.get("SELECT * FROM matches WHERE id=?", [matchId], async (_, match) => {
      if (!match) return interaction.editReply("❌ Match expired.");
      const players = [...JSON.parse(match.teamA), ...JSON.parse(match.teamB)];
      players.forEach(p => {
        if (!queues[match.format].includes(p)) queues[match.format].push(p);
      });
      await updateQueueEmbeds(guild);
      interaction.editReply("🔁 Rematch queued!");
    });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  /* ===== QUEUE ===== */
  if (interaction.commandName === "queue") {
    if (interaction.channel.id !== QUEUE_CHANNEL_ID) {
      return interaction.reply({
        content: `❌ Please use /queue in <#${QUEUE_CHANNEL_ID}>.`,
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });
    const format = interaction.options.getString("format");
    if (!queues[format]) return interaction.editReply("Invalid format.");
    if (queues[format].includes(interaction.user.id)) return interaction.editReply("Already queued.");
    queues[format].push(interaction.user.id);
    await updateQueueEmbeds(guild);
    interaction.editReply("✅ Queued!");
  }

  /* ===== LEAVE ===== */
  if (interaction.commandName === "leave") {
    if (interaction.channel.id !== QUEUE_CHANNEL_ID) {
      return interaction.reply({
        content: `❌ Please use /leave in <#${QUEUE_CHANNEL_ID}>.`,
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });
    let left = false;
    for (const format of Object.keys(queues)) {
      const i = queues[format].indexOf(interaction.user.id);
      if (i !== -1) { queues[format].splice(i, 1); left = true; }
    }
    if (!left) return interaction.editReply("❌ You are not in any queue.");
    await updateQueueEmbeds(guild);
    interaction.editReply("✅ You left the queue.");
  }

  /* ===== REPORT ===== */
  if (interaction.commandName === "report") {
    if (interaction.channel.id !== REPORT_CHANNEL_ID) {
      return interaction.reply({
        content: "❌ Please report matches in the designated report channel.",
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });
    const matchId = interaction.options.getString("match_id");
    const result = interaction.options.getString("result");

    db.get("SELECT * FROM matches WHERE id=? AND reported=0", [matchId], async (_, match) => {
      if (!match) return interaction.editReply("❌ Match not found or already reported.");

      const teamA = JSON.parse(match.teamA);
      const teamB = JSON.parse(match.teamB);
      const winners = result === "win" ? teamA : teamB;
      const losers = result === "win" ? teamB : teamA;

      winners.forEach(p => db.run("UPDATE players SET wins=wins+1, elo=elo+10 WHERE id=?", [p]));
      losers.forEach(p => db.run("UPDATE players SET losses=losses+1, elo=MAX(0,elo-10) WHERE id=?", [p]));

      db.run("UPDATE matches SET reported=1, winner=? WHERE id=?", [result, match.id]);

      const rematchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rematch_${match.id}`).setLabel("🔁 Rematch").setStyle(ButtonStyle.Success)
      );

      // Public announcement in match text channel
      const matchChannel = await guild.channels.fetch(match.channel_id).catch(() => null);
      if (matchChannel) {
        matchChannel.send({
          content: `✅ Match **${match.id}** reported!
Team A: ${teamA.map(p => `<@${p}>`).join(", ")}
Team B: ${teamB.map(p => `<@${p}>`).join(", ")}
🏆 Winner: ${result === "win" ? "Team A" : "Team B"}!`,
          components: [rematchRow]
        });
      }

      await interaction.editReply({
        content: `✅ Match **${match.id}** reported successfully! Announcement sent to the match channel.`,
        ephemeral: true
      });

      // Cleanup temporary channels
      setTimeout(async () => {
        if (match.channel_id) guild.channels.delete(match.channel_id).catch(() => {});
        if (match.vcA) guild.channels.delete(match.vcA).catch(() => {});
        if (match.vcB) guild.channels.delete(match.vcB).catch(() => {});
      }, 30000);
    });
  }

  /* ===== STATS ===== */
  if (interaction.commandName === "stats") {
    if (interaction.channel.id !== STATS_CHANNEL_ID) {
      return interaction.reply({
        content: `❌ Please use /stats in <#${STATS_CHANNEL_ID}>.`,
        ephemeral: true
      });
    }

    const user = interaction.options.getUser("player") || interaction.user;
    ensurePlayer(user);
    db.get("SELECT wins, losses, elo FROM players WHERE id=?", [user.id], (_, row) => {
      interaction.reply(`📊 **${user.username}**\nWins: ${row.wins}\nLosses: ${row.losses}\nELO: ${row.elo}`);
    });
  }

  /* ===== LEADERBOARD ===== */
  if (interaction.commandName === "leaderboard") {
    if (interaction.channel.id !== STATS_CHANNEL_ID) {
      return interaction.reply({
        content: `❌ Please use /leaderboard in <#${STATS_CHANNEL_ID}>.`,
        ephemeral: true
      });
    }

    await interaction.deferReply();
    db.all("SELECT username, elo FROM players ORDER BY elo DESC LIMIT 10", (_, rows) => {
      if (!rows.length) return interaction.editReply("No leaderboard data.");
      const text = rows.map((p, i) => `**${i + 1}. ${p.username}** — ${p.elo}`).join("\n");
      interaction.editReply(`🏆 **Leaderboard**\n${text}`);
    });
  }
});

/* =========================
   LOGIN
========================= */
client.login(process.env.DISCORD_TOKEN);