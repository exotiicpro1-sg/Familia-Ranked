import { REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

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

  // ===== Report (ENV-BASED MATCH ID) =====
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
          { name: "Team A", value: "win" },
          { name: "Team B", value: "loss" }
        )
    ),

  // ===== Mod ELO Adjustment =====
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

  // ===== Rules Command =====
  new SlashCommandBuilder()
    .setName("rules")
    .setDescription("View the rules and how to play")
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

const CLIENT_ID = 1450391424569966642; // your bot client id
const GUILD_ID = 1354200815169961984;   // your test server id

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error(error);
  }
})();