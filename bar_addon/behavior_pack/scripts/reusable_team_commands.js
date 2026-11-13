import * as minecraftServer from "@minecraft/server";
import {
  HUD_RATIO_TEAM_ORDER,
  hudClearRatioTeamTags,
  hudNormalizeRatioTeamTags,
  hudRatioTeamForPlayer,
  hudRatioTeamTagState,
  hudSetRatioTeamTag
} from "./reusable_team_ratio_bar.js";
import {
  getReusableTeamAreaState,
  removeReusableTeamAreas,
  setupReusableTeamAreas
} from "./reusable_team_area.js";

var CustomCommandParamType = minecraftServer.CustomCommandParamType || {};
var CustomCommandPermissionLevel =
  minecraftServer.CustomCommandPermissionLevel
  || minecraftServer.CommandPermissionLevel
  || {};
var CustomCommandStatus = minecraftServer.CustomCommandStatus || {};
var world = minecraftServer.world;
var system = minecraftServer.system;

var CUSTOM_COMMAND_PARAM_STRING = CustomCommandParamType.String || "String";
var CUSTOM_COMMAND_PARAM_ENUM = CustomCommandParamType.Enum || "Enum";
var CUSTOM_COMMAND_PARAM_INTEGER = CustomCommandParamType.Integer || "Integer";
var CUSTOM_COMMAND_PARAM_PLAYER_SELECTOR =
  CustomCommandParamType.PlayerSelector
  || CustomCommandParamType.EntitySelector
  || CustomCommandParamType.String
  || "String";
var CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS =
  CustomCommandPermissionLevel.GameDirectors || 1;
var CUSTOM_COMMAND_STATUS_SUCCESS = CustomCommandStatus.Success || 0;
var CUSTOM_COMMAND_STATUS_FAILURE = CustomCommandStatus.Failure || 1;

export var HUD_TEAM_BASE_BLOCK_IDS = {
  red: "block_hakobiya:red_base_block",
  blue: "block_hakobiya:blue_base_block",
  yellow: "block_hakobiya:yellow_base_block",
  green: "block_hakobiya:green_base_block"
};

var baseBlockWatcherHandle = undefined;
var commandEventsRegistered = false;
var customCommandsRegistered = false;

function tell(player, message) {
  try {
    if (player && typeof player.sendMessage === "function") {
      player.sendMessage(message);
      return;
    }
  } catch (e) {}

  try {
    world.sendMessage(message);
  } catch (e2) {}
}

function senderFromEvent(event) {
  try {
    if (event && event.sourceEntity && event.sourceEntity.typeId === "minecraft:player") {
      return event.sourceEntity;
    }
  } catch (e) {}
  return undefined;
}

function senderFromOrigin(origin) {
  try {
    if (origin && origin.sourceEntity && origin.sourceEntity.typeId === "minecraft:player") {
      return origin.sourceEntity;
    }
  } catch (e) {}

  try {
    if (origin && origin.initiator && origin.initiator.typeId === "minecraft:player") {
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

function splitNames(message) {
  var text = String(message || "").trim();
  if (!text) return [];
  return text.split(/\s+/);
}

function namesFromCommandArgs(args) {
  var out = [];
  var list = Array.isArray(args) ? args : [];

  for (var i = 0; i < list.length; i++) {
    var value = list[i];
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      var nested = namesFromCommandArgs(value);
      for (var j = 0; j < nested.length; j++) {
        out.push(nested[j]);
      }
      continue;
    }

    var text = String(value).trim();
    if (!text) continue;
    out.push(text);
  }

  return out;
}

function pushUniquePlayer(out, seen, player) {
  if (!player || player.typeId !== "minecraft:player") return;

  var key = "";
  try {
    key = String(player.id || "");
  } catch (e) {}
  if (!key) key = String(player.name || "");
  if (key && seen[key]) return;
  if (key) seen[key] = true;

  out.push(player);
}

function playersFromSelectorArgs(args) {
  var out = [];
  var seen = {};
  var list = Array.isArray(args) ? args : [];

  for (var i = 0; i < list.length; i++) {
    var value = list[i];
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (var j = 0; j < value.length; j++) {
        pushUniquePlayer(out, seen, value[j]);
      }
      continue;
    }

    pushUniquePlayer(out, seen, value);
  }

  return out;
}

function findPlayerByName(name) {
  var target = String(name || "").toLowerCase();
  if (!target) return undefined;

  var players = allPlayers();
  var partial = undefined;

  for (var i = 0; i < players.length; i++) {
    var playerName = String(players[i].name || "");
    var lower = playerName.toLowerCase();
    if (lower === target) return players[i];
    if (!partial && lower.indexOf(target) === 0) partial = players[i];
  }

  return partial;
}

function resolveCommandTargets(message, sender) {
  var names = splitNames(message);
  if (names.length <= 0) return sender ? [sender] : [];

  var players = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (name === "@s" && sender) {
      players.push(sender);
      continue;
    }
    if (name === "@a") {
      return allPlayers();
    }

    var player = findPlayerByName(name);
    if (player) players.push(player);
  }

  return players;
}

function resolveCommandArgTargets(args, sender) {
  var list = Array.isArray(args) ? args : [];
  var selectorWasProvided = false;

  for (var i = 0; i < list.length; i++) {
    if (list[i] !== undefined && list[i] !== null) {
      selectorWasProvided = true;
      break;
    }
  }

  var selectorPlayers = playersFromSelectorArgs(list);

  // A provided selector that matched zero players must stay empty.
  // Never fall back to the command sender in that case.
  if (selectorWasProvided) return selectorPlayers;

  return sender ? [sender] : [];
}

function commandColorFromId(id) {
  var text = String(id || "").toLowerCase();
  if (text === "rt:red" || text === "team:red") return "red";
  if (text === "rt:blue" || text === "team:blue") return "blue";
  if (text === "rt:yellow" || text === "team:yellow") return "yellow";
  if (text === "rt:green" || text === "team:green") return "green";
  if (text === "rt:cyan" || text === "team:cyan") return "cyan";
  if (text === "rt:purple" || text === "team:purple") return "purple";
  if (text === "rt:orange" || text === "team:orange") return "orange";
  if (text === "rt:pink" || text === "team:pink") return "pink";
  return "";
}

function commandResult(status, message) {
  return {
    status: status,
    message: message
  };
}

function commandSuccess(message) {
  return commandResult(CUSTOM_COMMAND_STATUS_SUCCESS, message || "");
}

function commandFailure(message) {
  return commandResult(CUSTOM_COMMAND_STATUS_FAILURE, message || "");
}

function optionalNameParameters(maxCount) {
  return [
    {
      type: CUSTOM_COMMAND_PARAM_PLAYER_SELECTOR,
      name: "players"
    }
  ];
}

function optionalStringParameters(names) {
  var params = [];
  var list = Array.isArray(names) ? names : [];

  for (var i = 0; i < list.length; i++) {
    params.push({
      type: CUSTOM_COMMAND_PARAM_STRING,
      name: list[i]
    });
  }

  return params;
}

function integerRange(start, end) {
  var out = [];
  var from = Math.floor(Number(start) || 0);
  var to = Math.floor(Number(end) || 0);
  var step = from <= to ? 1 : -1;

  for (var value = from; value !== to + step; value += step) {
    out.push(value);
  }

  return out;
}

function parseBaseYOffsetToken(token) {
  var text = String(token || "").trim();
  if (!text) return undefined;

  var rangeMatch = text.match(/^(-?\d+)\s*(?:~|\.\.|-)\s*(-?\d+)$/);
  if (rangeMatch) {
    var first = Number(rangeMatch[1]);
    var second = Number(rangeMatch[2]);
    var values = integerRange(first, second);

    if (first >= 0 && second >= 0) {
      for (var i = 0; i < values.length; i++) {
        values[i] = -Math.abs(values[i]);
      }
    }

    return values;
  }

  if (/^-?\d+$/.test(text)) {
    var number = Number(text);
    return [number >= 0 ? -Math.abs(number) : number];
  }

  return undefined;
}

function baseWatcherOptions(options, yOffsets) {
  var opts = {};
  var source = options || {};

  for (var key in source) {
    opts[key] = source[key];
  }

  if (Array.isArray(yOffsets) && yOffsets.length > 0) {
    opts.yOffsets = yOffsets;
  }

  return opts;
}

function baseTickingAreaName(options) {
  var text = String((options && options.tickingAreaName) || "rt_base_area");
  return text.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32) || "rt_base_area";
}

function baseTickingAreaRadius(options) {
  var radius = Math.floor(Number(options && options.tickingAreaRadius) || 4);
  return Math.max(1, Math.min(4, radius));
}

function commandDimensionForBase(sender, options) {
  try {
    if (sender && sender.dimension) return sender.dimension;
  } catch (e) {}

  try {
    if (options && options.dimensionId) return world.getDimension(options.dimensionId);
  } catch (e2) {}

  try {
    return world.getDimension("overworld");
  } catch (e3) {}

  return undefined;
}

function baseLocationFromSender(sender, options) {
  if (options && options.tickingAreaLocation) return options.tickingAreaLocation;

  try {
    if (sender && sender.location) return sender.location;
  } catch (e) {}

  return undefined;
}

function runDimensionCommand(dimension, command) {
  try {
    if (dimension && typeof dimension.runCommandAsync === "function") {
      dimension.runCommandAsync(command).catch(function () {});
      return true;
    }
  } catch (e) {}

  try {
    if (dimension && typeof dimension.runCommand === "function") {
      dimension.runCommand(command);
      return true;
    }
  } catch (e2) {}

  return false;
}

export function removeBaseTickingArea(options, dimension) {
  if (options && options.useTickingArea === false) return false;

  var targetDimension = dimension || commandDimensionForBase(undefined, options);
  var name = baseTickingAreaName(options);
  return runDimensionCommand(targetDimension, "tickingarea remove " + name);
}

export function addBaseTickingArea(sender, options) {
  if (options && options.useTickingArea === false) return false;

  var dimension = commandDimensionForBase(sender, options);
  var loc = baseLocationFromSender(sender, options);
  if (!dimension || !loc) return false;

  var x = Math.floor(loc.x);
  var y = Math.floor(loc.y);
  var z = Math.floor(loc.z);
  var radius = baseTickingAreaRadius(options);
  var name = baseTickingAreaName(options);

  removeBaseTickingArea(options, dimension);
  return runDimensionCommand(
    dimension,
    "tickingarea add circle " + x + " " + y + " " + z + " " + radius + " " + name
  );
}

export function hudTeamFromBaseBlockTypeId(typeId, baseBlockIds) {
  var ids = baseBlockIds || HUD_TEAM_BASE_BLOCK_IDS;
  var text = String(typeId || "");

  if (text === ids.red) return "red";
  if (text === ids.blue) return "blue";
  if (text === ids.yellow) return "yellow";
  if (text === ids.green) return "green";
  return "";
}

function blockAtPlayerOffset(player, yOffset) {
  try {
    var loc = player.location;
    return player.dimension.getBlock({
      x: Math.floor(loc.x),
      y: Math.floor(loc.y + yOffset),
      z: Math.floor(loc.z)
    });
  } catch (e) {}
  return undefined;
}

export function hudTeamFromPlayerBaseBlock(player, options) {
  if (!player) return "";

  var opts = options || {};
  var offsets = Array.isArray(opts.yOffsets) ? opts.yOffsets : [-1, 0];

  for (var i = 0; i < offsets.length; i++) {
    var block = blockAtPlayerOffset(player, Number(offsets[i]) || 0);
    var typeId = "";
    try {
      typeId = block ? block.typeId : "";
    } catch (e) {
      typeId = "";
    }

    var team = hudTeamFromBaseBlockTypeId(typeId, opts.baseBlockIds);
    if (team) return team;
  }

  return "";
}

export function hudSetRatioTeamFromBaseBlock(player, options) {
  var team = hudTeamFromPlayerBaseBlock(player, options);
  if (!team) return "";

  hudSetRatioTeamTag(player, team, options && options.teamTags);
  return team;
}

export function hudSetRatioTeamsFromBaseBlocks(players, options) {
  var list = players || [];
  var changed = [];

  for (var i = 0; i < list.length; i++) {
    var before = hudRatioTeamForPlayer(list[i], options && options.teamTags);
    var team = hudSetRatioTeamFromBaseBlock(list[i], options);
    if (team && team !== before) {
      changed.push({
        player: list[i],
        team: team
      });
    }
  }

  return changed;
}

export function startBaseBlockTeamWatcher(options) {
  var opts = options || {};
  var intervalTicks = Math.max(1, Math.floor(Number(opts.intervalTicks) || 10));

  stopBaseBlockTeamWatcher();

  baseBlockWatcherHandle = system.runInterval(function () {
    var changed = hudSetRatioTeamsFromBaseBlocks(allPlayers(), opts);
    if (!opts.announceChanges) return;

    for (var i = 0; i < changed.length; i++) {
      tell(
        changed[i].player,
        "§aTeam: §f" + changed[i].team
      );
    }
  }, intervalTicks);

  return baseBlockWatcherHandle;
}

export function setBaseBlockTeamWatcher(yOffsets, options) {
  return startBaseBlockTeamWatcher(baseWatcherOptions(options, yOffsets));
}

export function stopBaseBlockTeamWatcher() {
  if (baseBlockWatcherHandle === undefined) return;

  try {
    system.clearRun(baseBlockWatcherHandle);
  } catch (e) {}

  baseBlockWatcherHandle = undefined;
}

export function removeBaseBlockTeamWatcher(options, dimension) {
  stopBaseBlockTeamWatcher();
  removeBaseTickingArea(options, dimension);
}

export function registerTeamCommandEvents(options) {
  if (commandEventsRegistered) return;
  if (!system.afterEvents || !system.afterEvents.scriptEventReceive) return;

  var opts = options || {};
  commandEventsRegistered = true;

  system.afterEvents.scriptEventReceive.subscribe(function (event) {
    var color = commandColorFromId(event.id);
    var sender = senderFromEvent(event);

    if (color) {
      var targets = resolveCommandTargets(event.message, sender);
      for (var i = 0; i < targets.length; i++) {
        hudSetRatioTeamTag(targets[i], color, opts.teamTags);
      }
      tell(sender, "§a" + color + " team: §f" + targets.length + " player(s)");
      return;
    }

    if (event.id === "rt:base" || event.id === "team:base") {
      var baseTargets = resolveCommandTargets(event.message, sender);
      var changed = hudSetRatioTeamsFromBaseBlocks(baseTargets, opts);
      tell(sender, "§aBase block teams applied: §f" + changed.length + " changed");
      return;
    }

  });
}

function registerColorCustomCommand(registry, commandName, color, options) {
  var opts = options || {};

  registry.registerCommand({
    name: commandName,
    description: "Set players to the " + color + " team",
    permissionLevel: opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
    cheatsRequired: true,
    optionalParameters: optionalNameParameters(opts.maxCommandTargets || 8)
  }, function (origin, ...args) {
    var sender = senderFromOrigin(origin);
    var targets = resolveCommandArgTargets(args, sender);

    if (targets.length <= 0) {
      return commandFailure("No matching players");
    }

    system.run(function () {
      for (var i = 0; i < targets.length; i++) {
        hudSetRatioTeamTag(targets[i], color, opts.teamTags);
      }
    });

    return commandSuccess(color + " team: " + targets.length + " player(s)");
  });
}

function tryRegisterColorCustomCommand(registry, commandName, color, options) {
  try {
    registerColorCustomCommand(registry, commandName, color, options);
    return true;
  } catch (e) {}
  return false;
}

var UNIFIED_TEAM_ENUM_NAME = "rt:team_action";
var UNIFIED_TEAM_ACTIONS = [
  "red",
  "blue",
  "yellow",
  "green",
  "cyan",
  "purple",
  "orange",
  "pink",
  "clear",
  "check",
  "list",
  "random",
  "base_set",
  "base_remove"
];

function unifiedTeamAction(value) {
  var text = String(value || "").toLowerCase();

  if (text === "r") return "red";
  if (text === "b") return "blue";
  if (text === "y") return "yellow";
  if (text === "g") return "green";
  if (text === "c") return "cyan";
  if (text === "p") return "purple";
  if (text === "o") return "orange";
  if (text === "pk") return "pink";

  if (text === "remove" || text === "none" || text === "off") {
    return "clear";
  }

  if (
    text === "baseset"
    || text === "base-set"
    || text === "area_set"
    || text === "area-set"
  ) {
    return "base_set";
  }

  if (
    text === "baseremove"
    || text === "base-remove"
    || text === "area_remove"
    || text === "area-remove"
  ) {
    return "base_remove";
  }

  return text;
}

function unifiedTeamTargets(selectorArg, sender) {
  // No selector = operate on command sender for color/clear commands.
  if (selectorArg === undefined || selectorArg === null) {
    return sender ? [sender] : [];
  }

  // A real selector can legitimately resolve to an empty Player[].
  return playersFromSelectorArgs([selectorArg]);
}

function playerDisplayName(player) {
  try {
    return String(player.name || player.nameTag || "?");
  } catch (e) {}
  return "?";
}

function colorLabel(color) {
  var text = String(color || "");
  return text || "none";
}

function selectedOrAll(selectorArg) {
  if (selectorArg === undefined || selectorArg === null) {
    return allPlayers();
  }

  return playersFromSelectorArgs([selectorArg]);
}

function teamCheckLines(players, teamTags) {
  var list = players || [];
  var lines = [];

  for (var i = 0; i < list.length; i++) {
    var player = list[i];
    var before = hudRatioTeamTagState(player, teamTags);
    var normalized = hudNormalizeRatioTeamTags(player, teamTags);

    if (before.conflict) {
      lines.push(
        playerDisplayName(player)
        + ": conflict ["
        + before.colors.join(",")
        + "] -> cleared"
      );
    } else {
      lines.push(
        playerDisplayName(player)
        + ": "
        + colorLabel(normalized.team)
      );
    }
  }

  return lines;
}

function teamListText(players, teamTags) {
  var list = players || [];
  var groups = {};
  var none = [];

  for (var c = 0; c < HUD_RATIO_TEAM_ORDER.length; c++) {
    groups[HUD_RATIO_TEAM_ORDER[c]] = [];
  }

  for (var i = 0; i < list.length; i++) {
    var player = list[i];
    var normalized = hudNormalizeRatioTeamTags(player, teamTags);
    var name = playerDisplayName(player);

    if (normalized.team && groups[normalized.team]) {
      groups[normalized.team].push(name);
    } else {
      none.push(name);
    }
  }

  var parts = [];

  for (var j = 0; j < HUD_RATIO_TEAM_ORDER.length; j++) {
    var color = HUD_RATIO_TEAM_ORDER[j];
    var members = groups[color] || [];
    parts.push(
      color + "(" + members.length + "): "
      + (members.length > 0 ? members.join(", ") : "-")
    );
  }

  parts.push(
    "none(" + none.length + "): "
    + (none.length > 0 ? none.join(", ") : "-")
  );

  return parts.join("\n");
}

function shuffledPlayers(players) {
  var out = (players || []).slice();

  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var temp = out[i];
    out[i] = out[j];
    out[j] = temp;
  }

  return out;
}

function randomizeTeams(players, count, teamTags) {
  var list = shuffledPlayers(players);
  var teamCount = Math.floor(Number(count) || 4);

  if (
    teamCount < 2
    || teamCount > HUD_RATIO_TEAM_ORDER.length
  ) {
    return {
      players: 0,
      teams: 0,
      error: "Team count must be between 2 and 8"
    };
  }

  for (var i = 0; i < list.length; i++) {
    hudSetRatioTeamTag(
      list[i],
      HUD_RATIO_TEAM_ORDER[i % teamCount],
      teamTags
    );
  }

  return {
    players: list.length,
    teams: teamCount
  };
}

function sendLines(target, header, lines) {
  var text = String(header || "");
  var body = Array.isArray(lines) ? lines.join("\n") : String(lines || "");

  if (body) {
    text += (text ? "\n" : "") + body;
  }

  tell(target, text);
}

function registerUnifiedTeamEnum(registry) {
  if (!registry || typeof registry.registerEnum !== "function") {
    return false;
  }

  try {
    registry.registerEnum(
      UNIFIED_TEAM_ENUM_NAME,
      UNIFIED_TEAM_ACTIONS
    );
    return true;
  } catch (e) {}

  // It may already be registered after a script reload.
  return true;
}

function registerUnifiedTeamCustomCommand(registry, options) {
  var opts = options || {};
  var enumReady = registerUnifiedTeamEnum(registry);

  var actionParameter = enumReady
    ? {
        type: CUSTOM_COMMAND_PARAM_ENUM,
        name: UNIFIED_TEAM_ENUM_NAME
      }
    : {
        type: CUSTOM_COMMAND_PARAM_STRING,
        name: "action"
      };

  registry.registerCommand({
    name: "rt:team",
    description:
      "Team management: colors/clear/check/list/random",
    permissionLevel:
      opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
    cheatsRequired: true,
    mandatoryParameters: [
      actionParameter
    ],
    optionalParameters: [
      {
        type: CUSTOM_COMMAND_PARAM_PLAYER_SELECTOR,
        name: "players"
      },
      {
        type: CUSTOM_COMMAND_PARAM_INTEGER,
        name: "teamCount"
      }
    ]
  }, function (origin, ...args) {
    var sender = senderFromOrigin(origin);
    var action = unifiedTeamAction(args[0]);
    var selectorArg = args.length > 1 ? args[1] : undefined;
    var teamCountArg = args.length > 2 ? args[2] : undefined;

    if (
      action === "red"
      || action === "blue"
      || action === "yellow"
      || action === "green"
      || action === "cyan"
      || action === "purple"
      || action === "orange"
      || action === "pink"
    ) {
      var targets = unifiedTeamTargets(selectorArg, sender);

      if (targets.length <= 0) {
        return commandFailure("No matching players");
      }

      system.run(function () {
        for (var i = 0; i < targets.length; i++) {
          // hudSetRatioTeamTag removes every other registered color tag.
          hudSetRatioTeamTag(
            targets[i],
            action,
            opts.teamTags
          );
        }
      });

      return commandSuccess(
        action + " team: " + targets.length + " player(s)"
      );
    }

    if (action === "clear") {
      var clearTargets = unifiedTeamTargets(selectorArg, sender);

      if (clearTargets.length <= 0) {
        return commandFailure("No matching players");
      }

      system.run(function () {
        for (var i = 0; i < clearTargets.length; i++) {
          hudClearRatioTeamTags(
            clearTargets[i],
            opts.teamTags
          );
        }
      });

      return commandSuccess(
        "Team cleared: " + clearTargets.length + " player(s)"
      );
    }

    if (action === "check") {
      var checkTargets = unifiedTeamTargets(selectorArg, sender);

      if (checkTargets.length <= 0) {
        return commandFailure("No matching players");
      }

      system.run(function () {
        sendLines(
          sender,
          "§eTeam check",
          teamCheckLines(checkTargets, opts.teamTags)
        );
      });

      return commandSuccess(
        "Checked " + checkTargets.length + " player(s)"
      );
    }

    if (action === "list") {
      system.run(function () {
        tell(
          sender,
          "§eTeam list\n"
          + teamListText(allPlayers(), opts.teamTags)
        );
      });

      return commandSuccess("Team list");
    }

    if (action === "random") {
      // Keep the selector as a native PlayerSelector:
      // /rt:team random @a 4
      var randomTargets = selectedOrAll(selectorArg);

      if (randomTargets.length <= 0) {
        return commandFailure("No matching players");
      }

      var requestedCount = (
        teamCountArg === undefined
        || teamCountArg === null
      )
        ? 4
        : Math.floor(Number(teamCountArg));

      if (
        !isFinite(requestedCount)
        || requestedCount < 2
        || requestedCount > HUD_RATIO_TEAM_ORDER.length
      ) {
        return commandFailure(
          "Team count must be between 2 and 8"
        );
      }

      system.run(function () {
        var result = randomizeTeams(
          randomTargets,
          requestedCount,
          opts.teamTags
        );

        tell(
          sender,
          "§aRandom teams: "
          + result.players
          + " player(s) / "
          + result.teams
          + " team(s)"
        );
      });

      return commandSuccess(
        "Random: "
        + randomTargets.length
        + " player(s) / "
        + requestedCount
        + " team(s)"
      );
    }

    // Kept as compatibility aliases. Preferred area commands are /rt:base.
    if (action === "base_set") {
      if (!sender) {
        return commandFailure(
          "base_set requires a player command source"
        );
      }

      if (getReusableTeamAreaState().exists) {
        return commandFailure(
          "Team area already exists; remove it first"
        );
      }

      system.run(function () {
        var areaOptions = {};
        for (var key in opts) areaOptions[key] = opts[key];
        areaOptions.teamCount = 8;
        setupReusableTeamAreas(sender, areaOptions);
      });

      return commandSuccess("Team areas created: 8 colors");
    }

    if (action === "base_remove") {
      var removeDimension = commandDimensionForBase(sender, opts);

      system.run(function () {
        removeBaseBlockTeamWatcher(
          opts,
          removeDimension
        );
        var removed = removeReusableTeamAreas();

        if (!removed) {
          tell(
            sender,
            "§cチーム分けエリアを復元できませんでした。保存データは残しています。"
          );
        }
      });

      return commandSuccess("Team area removal requested");
    }

    return commandFailure(
      "Use color|clear|check|list|random"
    );
  });
}

function tryRegisterUnifiedTeamCustomCommand(registry, options) {
  try {
    registerUnifiedTeamCustomCommand(registry, options);
    return true;
  } catch (e) {}

  return false;
}

function registerBaseCustomCommand(registry, commandName, options) {
  var opts = options || {};

  registry.registerCommand({
    name: commandName,
    description: "Start or stop base-block team assignment",
    permissionLevel: opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
    cheatsRequired: true,
    optionalParameters: [
      {
        type: CUSTOM_COMMAND_PARAM_STRING,
        name: "action"
      },
      {
        type: CUSTOM_COMMAND_PARAM_INTEGER,
        name: "teamCount"
      }
    ]
  }, function (origin, ...args) {
    var sender = senderFromOrigin(origin);
    var action = String(args[0] || "set").toLowerCase();

    var requestedTeamCount = 8;
    if (args[1] !== undefined && args[1] !== null) {
      requestedTeamCount = Math.floor(Number(args[1]));

      if (
        !isFinite(requestedTeamCount)
        || requestedTeamCount < 2
        || requestedTeamCount > 8
      ) {
        return commandFailure(
          "Team count must be between 2 and 8"
        );
      }
    }

    if (action === "info" || action === "status") {
      var state = getReusableTeamAreaState();
      var centerText = state.center
        ? (
            Math.floor(state.center.x)
            + " "
            + Math.floor(state.center.y)
            + " "
            + Math.floor(state.center.z)
          )
        : "-";

      return commandSuccess(
        state.exists
          ? (
              "Base: active / "
              + state.areaCount
              + " areas / "
              + (state.dimensionId || "overworld")
              + " / center "
              + centerText
            )
          : "Base: none"
      );
    }

    if (action === "remove" || action === "off" || action === "stop") {
      var removeDimension = commandDimensionForBase(sender, opts);

      system.run(function () {
        removeBaseBlockTeamWatcher(opts, removeDimension);
        var removed = removeReusableTeamAreas();

        if (!removed) {
          tell(
            sender,
            "§cチーム分けエリアを復元できませんでした。保存データは残しています。"
          );
        }
      });

      return commandSuccess("Base removal requested");
    }


    if (action !== "set" && action !== "on" && action !== "start") {
      return commandFailure("Use /rt:base set [2-8]|remove|info");
    }

    if (getReusableTeamAreaState().exists) {
      return commandFailure(
        "Team area already exists; use /rt:base remove first"
      );
    }

    system.run(function () {
      var areaOptions = {};
      for (var key in opts) areaOptions[key] = opts[key];
      areaOptions.teamCount = requestedTeamCount;
      setupReusableTeamAreas(sender, areaOptions);
    });

    return commandSuccess(
      "Team areas created: " + requestedTeamCount + " colors"
    );
  });
}

function tryRegisterBaseCustomCommand(registry, commandName, options) {
  try {
    registerBaseCustomCommand(registry, commandName, options);
    return true;
  } catch (e) {}
  return false;
}

export function registerTeamCustomCommands(startupEvent, options) {
  if (customCommandsRegistered) return false;

  var registry = startupEvent && startupEvent.customCommandRegistry;
  if (!registry || typeof registry.registerCommand !== "function") {
    return false;
  }

  var opts = options || {};
  var registeredAny = false;

  // Preferred unified team command.
  registeredAny =
    tryRegisterUnifiedTeamCustomCommand(registry, opts)
    || registeredAny;

  // Legacy color shortcuts remain for compatibility.
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:red", "red", opts) || registeredAny;
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:blue", "blue", opts) || registeredAny;
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:yellow", "yellow", opts) || registeredAny;
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:green", "green", opts) || registeredAny;
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:cyan", "cyan", opts) || registeredAny;
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:purple", "purple", opts) || registeredAny;
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:orange", "orange", opts) || registeredAny;
  registeredAny = tryRegisterColorCustomCommand(registry, "rt:pink", "pink", opts) || registeredAny;

  registeredAny = tryRegisterBaseCustomCommand(registry, "rt:base", opts) || registeredAny;

  customCommandsRegistered = registeredAny;
  return registeredAny;
}

export function registerTeamCommandShortcuts(startupEvent, options) {
  return registerTeamCustomCommands(startupEvent, options);
}
