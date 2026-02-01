import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
  REST,
  Routes
} from "discord.js";
import dotenv from "dotenv";
import pkg from "pg";
import { MODES, MAPS } from "./maps.js";

dotenv.config();
const { Pool } = pkg;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const queues = {
  "2v2": [],
  "3v3": [],
  "4v4": []
};

const generateCode = () =>
  Math.random().toString(36).substring(2, 8).toUpperCase();

/* ========================
   DATABASE HELPERS
======================== */

const ensurePlayer = async (id) => {
  await pool.query(
    `INSERT INTO players (discord_id)
     VALUES ($1)
     ON CONFLICT DO NOTHING`,
    [id]
  );
};

const getPlayer = async (id) => {
  const res = await pool.query(
    `SELECT * FROM players WHERE discord_id = $1`,
    [id]
  );
  return res.rows[0];
};

/* ========================
   TEMP CHANNEL CREATION
======================== */

const createMatchChannels = async (guild, code, teamA, teamB) => {
  const category = await guild.channels.create({
    name: `📘 Match ${code}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        deny: [PermissionsBitField.Flags.ViewChannel]
      }
    ]
  });

  const allowPlayers = [...teamA, ...teamB].map(id => ({
    id,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.SendMessages
    ]
  }));

  const teamAVoice = await guild.channels.create({
    name: "🔊 Team A",
    type: ChannelType.GuildVoice,
    parent: category,
    permissionOverwrites: [
      ...allowPlayers,
      ...teamB.map(id => ({
        id,
        deny: [PermissionsBitField.Flags.Connect]
      }))
    ]
  });

  const teamBVoice = await guild.channels.create({
    name: "🔊 Team B",
    type: ChannelType.GuildVoice,
    parent: category,
    permissionOverwrites: [
      ...allowPlayers,
      ...teamA.map(id => ({
        id,
        deny: [PermissionsBitField.Flags.Connect]
      }))
    ]
  });

  const text = await guild.channels.create({
    name: `match-${code.toLowerCase()}`,
    type: ChannelType.GuildText,
    parent: category,
    permissionOverwrites: allowPlayers
  });

  return { category, teamAVoice, teamBVoice, text };
};

/* ========================
   READY + COMMAND REGISTER
======================== */

client.once("ready", async () => {
  console.log(`✅ Familia Ranked online as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Join a ranked queue")
      .addStringOption(o =>
        o.setName("mode")
          .setRequired(true)
          .addChoices(
            { name: "2v2", value: "2v2" },
            { name: "3v3", value: "3v3" },
            { name: "4v4", value: "4v4" }
          )
      ),

    new SlashCommandBuilder()
      .setName("report")
      .setDescription("Report match result")
      .addStringOption(o =>
        o.setName("code").setRequired(true)
      )
      .addStringOption(o =>
        o.setName("result")
          .setRequired(true)
          .addChoices(
            { name: "Win", value: "win" },
            { name: "Loss", value: "loss" }
          )
      ),

    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("View your stats"),

    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("Top ranked players")
  ];

  const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );
});

/* ========================
   INTERACTIONS
======================== */

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, guild } = interaction;

  /* ===== QUEUE ===== */
  if (commandName === "queue") {
    const mode = interaction.options.getString("mode");
    if (queues[mode].includes(user.id))
      return interaction.reply({ content: "Already queued.", ephemeral: true });

    queues[mode].push(user.id);
    interaction.reply(`Joined **${mode}** queue.`);

    const needed = parseInt(mode[0]) * 2;
    if (queues[mode].length < needed) return;

    const players = queues[mode].splice(0, needed);
    const teamA = players.slice(0, needed / 2);
    const teamB = players.slice(needed / 2);

    const code = generateCode();
    const gameMode = MODES[Math.floor(Math.random() * MODES.length)];
    const map = MAPS[gameMode][Math.floor(Math.random() * MAPS[gameMode].length)];

    await pool.query(`INSERT INTO matches (code) VALUES ($1)`, [code]);

    for (const id of teamA) {
      await ensurePlayer(id);
      await pool.query(
        `INSERT INTO match_players VALUES ($1,$2,'A')`,
        [code, id]
      );
    }

    for (const id of teamB) {
      await ensurePlayer(id);
      await pool.query(
        `INSERT INTO match_players VALUES ($1,$2,'B')`,
        [code, id]
      );
    }

    const channels = await createMatchChannels(guild, code, teamA, teamB);

    interaction.followUp(
      `🎮 **MATCH CREATED**
**Code:** ${code}
**Mode:** ${gameMode}
**Map:** ${map}

🅰️ <@${teamA.join("> <@")}>
🅱️ <@${teamB.join("> <@")}>

💬 ${channels.text}`
    );
  }

  /* ===== REPORT ===== */
  if (commandName === "report") {
    const code = interaction.options.getString("code");
    const result = interaction.options.getString("result");

    const match = await pool.query(
      `SELECT * FROM matches WHERE code = $1`,
      [code]
    );

    if (!match.rows.length || match.rows[0].reported)
      return interaction.reply({ content: "Invalid match.", ephemeral: true });

    const players = await pool.query(
      `SELECT * FROM match_players WHERE code = $1`,
      [code]
    );

    const reporter = players.rows.find(p => p.discord_id === user.id);
    if (!reporter)
      return interaction.reply({ content: "You were not in this match.", ephemeral: true });

    const winningTeam =
      (result === "win" && reporter.team === "A") ||
      (result === "loss" && reporter.team === "B")
        ? "A"
        : "B";

    for (const p of players.rows) {
      const player = await getPlayer(p.discord_id);

      if (p.team === winningTeam) {
        const gain =
          player.streak >= 9 ? 70 :
          player.streak >= 3 ? 40 : 25;

        await pool.query(
          `UPDATE players
           SET elo = elo + $1,
               wins = wins + 1,
               streak = streak + 1
           WHERE discord_id = $2`,
          [gain, p.discord_id]
        );
      } else {
        await pool.query(
          `UPDATE players
           SET elo = elo - 15,
               losses = losses + 1,
               streak = 0
           WHERE discord_id = $1`,
          [p.discord_id]
        );
      }
    }

    await pool.query(
      `UPDATE matches SET reported = TRUE WHERE code = $1`,
      [code]
    );

    guild.channels.cache
      .filter(c => c.name.includes(code))
      .forEach(c => c.delete().catch(() => {}));

    interaction.reply(`✅ Match **${code}** reported.`);
  }

  /* ===== STATS ===== */
  if (commandName === "stats") {
    const p = await getPlayer(user.id);
    interaction.reply(
      `📊 **Your Stats**
ELO: ${p.elo}
Wins: ${p.wins}
Losses: ${p.losses}
Streak: ${p.streak}`
    );
  }

  /* ===== LEADERBOARD ===== */
  if (commandName === "leaderboard") {
    const top = await pool.query(
      `SELECT * FROM players ORDER BY elo DESC LIMIT 10`
    );

    interaction.reply(
      `🏆 **Leaderboard**\n` +
      top.rows.map((p, i) =>
        `${i + 1}. <@${p.discord_id}> — ${p.elo}`
      ).join("\n")
    );
  }
});

client.login(process.env.DISCORD_TOKEN);