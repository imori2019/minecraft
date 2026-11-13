import * as minecraftServer from "@minecraft/server";
import {
  clearReusableBarCommandScores,
  getReusableBarInfo,
  getReusableBarRuntimeStats,
  hardResetReusableBar,
  pauseReusableBarTimer,
  resetReusableBarForGame,
  startReusableBarTimer
} from "./reusable_bar_commands.js";
import {
  getReusableTeamAreaState,
  removeReusableTeamAreas
} from "./reusable_team_area.js";
import {
  HUD_RATIO_TEAM_ORDER,
  getHudTeamRuntimeStats,
  hudAdvanceTeamResetEpoch,
  hudClearRatioTeamTags,
  hudNormalizeRatioTeamTags,
  hudRatioTeamTagState
} from "./reusable_team_ratio_bar.js";

var world = minecraftServer.world;
var system = minecraftServer.system;
var CustomCommandParamType = minecraftServer.CustomCommandParamType || {};
var CustomCommandPermissionLevel =
  minecraftServer.CustomCommandPermissionLevel
  || minecraftServer.CommandPermissionLevel
  || {};
var CustomCommandStatus = minecraftServer.CustomCommandStatus || {};

var CUSTOM_COMMAND_PARAM_STRING =
  CustomCommandParamType.String || "String";
var CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS =
  CustomCommandPermissionLevel.GameDirectors || 1;
var CUSTOM_COMMAND_STATUS_SUCCESS =
  CustomCommandStatus.Success || 0;
var CUSTOM_COMMAND_STATUS_FAILURE =
  CustomCommandStatus.Failure || 1;

var gameCommandsRegistered = false;

function commandResult(status, message) {
  return {
    status: status,
    message: String(message || "")
  };
}

function commandSuccess(message) {
  return commandResult(
    CUSTOM_COMMAND_STATUS_SUCCESS,
    message
  );
}

function commandFailure(message) {
  return commandResult(
    CUSTOM_COMMAND_STATUS_FAILURE,
    message
  );
}

function senderFromOrigin(origin) {
  try {
    if (
      origin
      && origin.sourceEntity
      && origin.sourceEntity.typeId === "minecraft:player"
    ) {
      return origin.sourceEntity;
    }
  } catch (e) {}

  try {
    if (
      origin
      && origin.initiator
      && origin.initiator.typeId === "minecraft:player"
    ) {
      return origin.initiator;
    }
  } catch (e2) {}

  return undefined;
}

function allPlayers() {
  try {
    return world.getPlayers();
  } catch (e) {}
  return [];
}

function normalizeAllTeams() {
  var players = allPlayers();
  var conflicts = 0;

  for (var i = 0; i < players.length; i++) {
    var state = hudNormalizeRatioTeamTags(players[i]);
    if (state && state.cleared) conflicts += 1;
  }

  return conflicts;
}

function clearAllTeams() {
  var players = allPlayers();

  for (var i = 0; i < players.length; i++) {
    hudClearRatioTeamTags(players[i]);
  }

  return players.length;
}

function teamCounts() {
  var counts = {
    none: 0
  };

  for (var i = 0; i < HUD_RATIO_TEAM_ORDER.length; i++) {
    counts[HUD_RATIO_TEAM_ORDER[i]] = 0;
  }

  var players = allPlayers();

  for (var p = 0; p < players.length; p++) {
    var state = hudRatioTeamTagState(players[p]);
    var team = state.team;

    if (team && counts[team] !== undefined) {
      counts[team] += 1;
    } else {
      counts.none += 1;
    }
  }

  return counts;
}

function teamCountsText() {
  var counts = teamCounts();
  var parts = [];

  for (var i = 0; i < HUD_RATIO_TEAM_ORDER.length; i++) {
    var color = HUD_RATIO_TEAM_ORDER[i];
    if (counts[color] > 0) {
      parts.push(color + "=" + counts[color]);
    }
  }

  parts.push("none=" + counts.none);
  return parts.join(",");
}

function gameStart() {
  var bar = getReusableBarInfo();

  if (!bar.mode) {
    return commandFailure(
      "Game start failed: configure a bar first"
    );
  }

  var conflicts = normalizeAllTeams();
  startReusableBarTimer();

  return commandSuccess(
    "Game started"
    + (conflicts > 0
      ? " / cleared " + conflicts + " team conflict(s)"
      : "")
  );
}

function gameStop() {
  var bar = getReusableBarInfo();

  if (!bar.mode) {
    return commandFailure("No bar configured");
  }

  pauseReusableBarTimer();
  return commandSuccess("Game stopped");
}

function gameReset() {
  resetReusableBarForGame();
  normalizeAllTeams();

  return commandSuccess(
    "Game reset / bar config and teams kept"
  );
}

function fullReset() {
  // Invalidate color tags on players who are currently offline. On their next
  // spawn, the epoch mismatch clears their old persisted team tags.
  hudAdvanceTeamResetEpoch();

  try {
    removeReusableTeamAreas();
  } catch (eArea) {}

  clearAllTeams();

  try {
    hardResetReusableBar();
  } catch (eBar) {}

  clearReusableBarCommandScores();

  return commandSuccess(
    "RT full reset complete"
  );
}

function debugText(sender) {
  var bar = getReusableBarInfo();
  var runtime = getReusableBarRuntimeStats();
  var base = getReusableTeamAreaState();
  var teamRuntime = getHudTeamRuntimeStats();

  var senderState = sender
    ? hudRatioTeamTagState(sender)
    : undefined;
  var senderTeam = senderState
    ? (
        senderState.conflict
          ? "conflict[" + senderState.colors.join(",") + "]"
          : (senderState.team || "none")
      )
    : "-";

  var timerState = bar.timerState || {};
  var barValue = Number(bar.barValue) || 0;

  return [
    "§eRT DEBUG",
    "bar="
      + (bar.mode || "none")
      + " value=" + barValue + "/" + (Number(bar.maxValue) || 0)
      + " running=" + (bar.running ? 1 : 0)
      + " style=" + (bar.barStyle || "boss"),
    "timer="
      + (Number(timerState.elapsedSeconds) || 0)
      + "/"
      + (Number(timerState.remainingSeconds) || 0)
      + "/"
      + (Number(timerState.totalSeconds) || 0)
      + " dir=" + (bar.timerDirection || "down"),
    "team=" + senderTeam
      + " online{" + teamCountsText() + "}",
    "ratio="
      + (bar.ratioTeams || "-")
      + " started=" + (bar.ratioHasStarted ? 1 : 0)
      + " hold=" + (bar.ratioRestoreHold ? 1 : 0)
      + " snap=[" + ((bar.ratioLastDisplayValues || []).join(",")) + "]"
      + " active=[" + ((bar.ratioLastPresence || []).join(",")) + "]",
    "counter=last:" + (Number(bar.counterLastCurrent) || 0)
      + " started=" + (bar.counterBaselineReady ? 1 : 0)
      + " participants=["
      + ((bar.roundParticipants || []).join(","))
      + "]",
    "base="
      + (base.exists ? "yes" : "no")
      + " loaded=" + (base.loaded ? 1 : 0)
      + " schema=" + (base.persistenceSchema || 0),
    "runtime=barLoop:"
      + (runtime.loopActive ? "on" : "off")
      + "@" + (runtime.intervalTicks || 0)
      + "t teamGuard:"
      + (teamRuntime.conflictGuardActive ? "on" : "off")
      + "@" + (teamRuntime.conflictGuardIntervalTicks || 0)
      + "t",
    "persist=barSchema:"
      + (runtime.persistenceSchema || 0)
      + " loaded=" + (runtime.persistenceLoaded ? 1 : 0)
  ].join("\n");
}

export function registerGameManagementCommands(startupEvent, options) {
  if (gameCommandsRegistered) return false;

  var registry = startupEvent && startupEvent.customCommandRegistry;
  if (!registry || typeof registry.registerCommand !== "function") {
    return false;
  }

  var opts = options || {};
  var permission =
    opts.permissionLevel
    || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS;

  registry.registerCommand({
    name: "rt:game",
    description: "Game lifecycle: start/stop/reset",
    permissionLevel: permission,
    cheatsRequired: true,
    mandatoryParameters: [
      {
        type: CUSTOM_COMMAND_PARAM_STRING,
        name: "action"
      }
    ]
  }, function (origin, ...args) {
    var action = String(args[0] || "").toLowerCase();

    if (action === "start" || action === "play") {
      // A /rt:bar set immediately before this command may still be queued.
      // Defer validation to gameStart() so same-tick chains remain ordered.
      system.run(function () {
        gameStart();
      });
      return commandSuccess("Game start requested");
    }

    if (
      action === "stop"
      || action === "pause"
    ) {
      system.run(function () {
        gameStop();
      });
      return commandSuccess("Game stop requested");
    }

    if (
      action === "reset"
      || action === "restart"
    ) {
      system.run(function () {
        gameReset();
      });
      return commandSuccess(
        "Game reset / bar config and teams kept"
      );
    }

    return commandFailure(
      "Use /rt:game start|stop|reset"
    );
  });

  registry.registerCommand({
    name: "rt:reset",
    description: "Fully reset Bar Addon world state",
    permissionLevel: permission,
    cheatsRequired: true
  }, function () {
    system.run(function () {
      fullReset();
    });
    return commandSuccess("RT full reset complete");
  });

  registry.registerCommand({
    name: "rt:debug",
    description: "Show Bar Addon runtime/debug state",
    permissionLevel: permission,
    cheatsRequired: true
  }, function (origin) {
    return commandSuccess(
      debugText(senderFromOrigin(origin))
    );
  });

  gameCommandsRegistered = true;
  return true;
}

export function hardResetReusableGame() {
  return fullReset();
}

export function getReusableGameDebugState(player) {
  return debugText(player);
}
