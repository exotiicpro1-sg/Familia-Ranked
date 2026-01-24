import { REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Your bot's client ID
const GUILD_ID = process.env.GUILD_ID;   // Your test server ID

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env");
  process.exit(1);
}

const commands = [
  // ===== Queue =====
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Join a queue")
    .addStringOption(option =>
      option.setName("format")
        .setDescription("8s, 6s, or 4s")
        .setRequired(true)
        .addChoices(
          { name: "8s", value: "8s" },
          { name: "6s", value: "6s" },
          { name: "4s", value: "4s" }
        )
    ),

  // ===== Leave =====
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave your current queue"),

  // ===== Stats =====
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View stats")
    .addUserOption(option =>
      option.setName("player")
        .setDescription("View another player's stats")
        .setRequired(false)
    ),

  // ===== Leaderboard =====
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View ELO leaderboard"),

  // ===== Report =====
  new SlashCommandBuilder()
    .setName("report")
    .setDescription("Report match result (captains only)")
    .addStringOption(option =>
      option.setName("match_id")
        .setDescription("The ID of the match to report")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("result")
        .setDescription("Which team won")
        .setRequired(true)
        .addChoices(
          { name: "Team A", value: "A" },
          { name: "Team B", value: "B" }
        )
    ),

  // ===== Adjust ELO (Admin/Mod Only) =====
  new SlashCommandBuilder()
    .setName("adjustelo")
    .setDescription("Adjust a player's ELO (mods only)")
    .addUserOption(option =>
      option.setName("player")
        .setDescription("Player to adjust")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("amount")
        .setDescription("Amount to add or subtract")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("Reason for adjustment")
        .setRequired(false)
    ),

  // ===== Rules =====
  new SlashCommandBuilder()
    .setName("rules")
    .setDescription("View the rules and how to play")
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log(`🚀 Started refreshing ${commands.length} slash commands...`);

    // Guild-based commands (fast, instant update)
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    // Uncomment below for global commands (may take up to 1 hour to update)
    // await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

    console.log(`✅ Successfully registered ${commands.length} slash commands.`);
  } catch (error) {
    console.error("❌ Failed to deploy commands:", error);
  }
})();
