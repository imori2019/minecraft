import { system, world } from "@minecraft/server";
import {
  initializeReusableBarPersistence,
  registerBarCommandShortcuts
} from "./reusable_bar_commands.js";
import { registerReusableTeamAreaTool } from "./reusable_team_area.js";
import { registerTeamCommandShortcuts } from "./reusable_team_commands.js";
import { registerGameManagementCommands } from "./reusable_game_commands.js";
import { initializeReusableStats } from "./reusable_stats.js";
import { initializeReusableBossPad } from "./reusable_boss_pad.js";

var commandRegistrationOk = false;

system.beforeEvents.startup.subscribe(function (event) {
  var teamOk = false;
  var barOk = false;
  var gameOk = false;

  try {
    teamOk = registerTeamCommandShortcuts(event);
  } catch (e) {
    teamOk = false;
  }

  try {
    barOk = registerBarCommandShortcuts(event);
  } catch (e2) {
    barOk = false;
  }

  try {
    gameOk = registerGameManagementCommands(event);
  } catch (e3) {
    gameOk = false;
  }

  commandRegistrationOk = !!(teamOk || barOk || gameOk);
});

registerReusableTeamAreaTool();

try {
  initializeReusableStats();
} catch (eStats) {
  try {
    console.warn("[RT Stats] initialization failed: " + eStats);
  } catch (eLog) {}
}

system.run(function () {
  try {
    initializeReusableBarPersistence();
  } catch (e) {}
});

try {
  initializeReusableBossPad();
} catch (eBoss) {
  try {
    console.warn("[RT BossPad] initialization failed: " + eBoss);
  } catch (eLog2) {}
}

system.runTimeout(function () {
  try {
    world.sendMessage(
      "§aバーアドオン loaded"
      + (commandRegistrationOk ? " §7(commands ok)" : " §7(commands unavailable)")
    );
  } catch (e) {}
}, 40);
