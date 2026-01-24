import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField
} from "discord.js";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

/* ================== CONFIG ================== */
const TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const GUILD_ID = "YOUR_GUILD_ID";
const QUEUE_CHANNEL_ID = "QUEUE_CHANNEL_ID";
const ADMIN_ROLE_ID = "ADMIN_ROLE_ID";

/* ================== CLIENT ================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

/* ================== DATABASE ================== */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================== CONSTANTS ================== */
const formats = {
  bo3: { players: 6 },
  bo5: { players: 8 },
  bo7: { players: 10 }
};

const maps = ["Rio", "Highrise", "Invasion", "Karachi", "Sub Base"];
const modes = ["Hardpoint", "Search & Destroy", "Control"];

const queues = { bo3: [], bo5: [], bo7: [] };
const activeMatches = new Map();

/* ================== HELPERS ================== */
const isAdmin = (member) =>
  member.roles.cache.has(ADMIN_ROLE_ID) ||
  member.permissions.has(PermissionsBitField.Flags.Administrator);

async function ensurePlayer(user) {
  await pool.query(
    `INSERT INTO players (id, username)
     VALUES ($1,$2)
     ON CONFLICT (id) DO NOTHING`,
    [user.id, user.username]
  );
}

async function updateQueueEmbeds(guild) {
  const channel = guild.channels.cache.get(QUEUE_CHANNEL_ID);
  if (!channel) return;

  await channel.bulkDelete(10, true);

  for (const format of Object.keys(queues)) {
    const embed = new EmbedBuilder()
      .setTitle(`${format.toUpperCase()} Queue`)
      .setDescription(
        queues[format].length
          ? queues[format].map((id) => `<@${id}>`).join("\n")
          : "Empty"
      )
      .setColor(0x00ffcc);

    await channel.send({ embeds: [embed] });
  }
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ================== MATCH CREATION ================== */
async function tryCreateMatch(format, guild) {
  if (queues[format].length < formats[format].players) return;

  const players = queues[format].splice(0, formats[format].players);
  const captainA = players[0];
  const captainB = players[1];

  const teamA = players.filter((_, i) => i % 2 === 0);
  const teamB = players.filter((_, i) => i % 2 !== 0);

  const map = randomFrom(maps);
  const mode = randomFrom(modes);

  const channel = await guild.channels.create({
    name: `match-${Date.now()}`,
    type: 0
  });

  const matchId = channel.id;

  activeMatches.set(matchId, {
    format,
    captainA,
    captainB,
    teamA,
    teamB,
    channelId: channel.id
  });

  await pool.query(
    `INSERT INTO matches
     (id, format, captain_a, captain_b, team_a, team_b, map, mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      matchId,
      format,
      captainA,
      captainB,
      JSON.stringify(teamA),
      JSON.stringify(teamB),
      map,
      mode
    ]
  );

  const embed = new EmbedBuilder()
    .setTitle("🎮 Match Created")
    .addFields(
      { name: "Format", value: format.toUpperCase(), inline: true },
      { name: "Map", value: map, inline: true },
      { name: "Mode", value: mode, inline: true },
      { name: "Captain A", value: `<@${captainA}>`, inline: true },
      { name: "Captain B", value: `<@${captainB}>`, inline: true },
      {
        name: "Team A",
        value: teamA.map((id) => `<@${id}>`).join("\n")
      },
      {
        name: "Team B",
        value: teamB.map((id) => `<@${id}>`).join("\n")
      }
    )
    .setColor(0xff9900);

  await channel.send({ embeds: [embed] });
}

/* ================== EVENTS ================== */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

/* ================== COMMAND HANDLER ================== */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;

  /* ===== QUEUE ===== */
  if (commandName === "queue") {
    if (interaction.channel.id !== QUEUE_CHANNEL_ID)
      return interaction.reply({ content: "❌ Use the queue channel.", ephemeral: true });

    const format = interaction.options.getString("format");
    if (!formats[format])
      return interaction.reply({ content: "❌ Invalid format.", ephemeral: true });

    if (queues[format].includes(interaction.user.id))
      return interaction.reply({ content: "❌ Already queued.", ephemeral: true });

    await ensurePlayer(interaction.user);
    queues[format].push(interaction.user.id);

    await updateQueueEmbeds(guild);
    await tryCreateMatch(format, guild);

    return interaction.reply({ content: "✅ Joined queue.", ephemeral: true });
  }

  /* ===== LEAVE ===== */
  if (commandName === "leave") {
    let removed = false;
    for (const f of Object.keys(queues)) {
      const i = queues[f].indexOf(interaction.user.id);
      if (i !== -1) {
        queues[f].splice(i, 1);
        removed = true;
      }
    }

    if (!removed)
      return interaction.reply({ content: "❌ Not in a queue.", ephemeral: true });

    await updateQueueEmbeds(guild);
    return interaction.reply({ content: "✅ Left queue.", ephemeral: true });
  }

  /* ===== REPORT / FORCE REPORT ===== */
  if (commandName === "report" || commandName === "force-report") {
    const matchId = interaction.options.getString("match_id", true);
    const result = interaction.options.getString("result", true);

    const res = await pool.query(`SELECT * FROM matches WHERE id=$1`, [matchId]);
    if (!res.rows.length)
      return interaction.reply({ content: "❌ Match not found.", ephemeral: true });

    const match = res.rows[0];

    const teamA = Array.isArray(match.team_a) ? match.team_a : JSON.parse(match.team_a);
    const teamB = Array.isArray(match.team_b) ? match.team_b : JSON.parse(match.team_b);

    if (commandName === "report") {
      if (
        interaction.user.id !== match.captain_a &&
        interaction.user.id !== match.captain_b &&
        !isAdmin(member)
      ) {
        return interaction.reply({
          content: "❌ Only captains or admins can report.",
          ephemeral: true
        });
      }
    }

    if (commandName === "force-report" && !isAdmin(member)) {
      return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
    }

    const winners = result === "team_a" ? teamA : teamB;
    const losers = result === "team_a" ? teamB : teamA;

    for (const id of winners)
      await pool.query(
        `UPDATE players SET wins = wins + 1 WHERE id=$1`,
        [id]
      );

    for (const id of losers)
      await pool.query(
        `UPDATE players SET losses = losses + 1 WHERE id=$1`,
        [id]
      );

    await pool.query(`DELETE FROM matches WHERE id=$1`, [matchId]);
    activeMatches.delete(matchId);

    const channel = guild.channels.cache.get(matchId);
    if (channel) setTimeout(() => channel.delete().catch(() => {}), 5000);

    return interaction.reply({ content: "✅ Match reported.", ephemeral: true });
  }

  /* ===== STATS ===== */
  if (commandName === "stats") {
    const user = interaction.options.getUser("player") || interaction.user;
    const res = await pool.query(`SELECT * FROM players WHERE id=$1`, [user.id]);

    if (!res.rows.length)
      return interaction.reply({ content: "❌ No stats.", ephemeral: true });

    const p = res.rows[0];
    return interaction.reply(
      `📊 **${user.username}** — Wins: ${p.wins} | Losses: ${p.losses}`
    );
  }

  /* ===== LEADERBOARD ===== */
  if (commandName === "leaderboard") {
    const res = await pool.query(
      `SELECT username, wins FROM players ORDER BY wins DESC LIMIT 10`
    );

    const embed = new EmbedBuilder()
      .setTitle("🏆 Leaderboard")
      .setDescription(
        res.rows.map((p, i) => `**${i + 1}.** ${p.username} — ${p.wins}W`).join("\n")
      )
      .setColor(0x00ff00);

    return interaction.reply({ embeds: [embed] });
  }
});

/* ================== LOGIN ================== */
client.login(TOKEN);
