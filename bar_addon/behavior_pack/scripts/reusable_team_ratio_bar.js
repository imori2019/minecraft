import { world, system } from "@minecraft/server";
import {
  setReusableHudOverlayText,
  showReusableRatioBar
} from "./reusable_hud_display.js";

export var HUD_RATIO_TEAM_RED = "red";
export var HUD_RATIO_TEAM_BLUE = "blue";
export var HUD_RATIO_TEAM_YELLOW = "yellow";
export var HUD_RATIO_TEAM_GREEN = "green";

export var HUD_RATIO_TEAM_ORDER = [
  "red",
  "blue",
  "yellow",
  "green",
  "cyan",
  "purple",
  "orange",
  "pink"
];

export var HUD_RATIO_TEAM_TAGS = {
  red: "team_red",
  blue: "team_blue",
  yellow: "team_yellow",
  green: "team_green",
  cyan: "team_cyan",
  purple: "team_purple",
  orange: "team_orange",
  pink: "team_pink"
};

var watcherHandle = undefined;
var lastSnapshot = "";
var counterEventHandles = [];

var HUD_TEAM_RESET_EPOCH_KEY = "rt_hud:team_reset_epoch_v1";

export function hudGetTeamResetEpoch() {
  try {
    return Math.max(
      0,
      Math.floor(
        Number(
          world.getDynamicProperty(HUD_TEAM_RESET_EPOCH_KEY)
        ) || 0
      )
    );
  } catch (e) {}

  return 0;
}

function hudGetPlayerTeamResetEpoch(player) {
  try {
    return Math.max(
      0,
      Math.floor(
        Number(
          player.getDynamicProperty(HUD_TEAM_RESET_EPOCH_KEY)
        ) || 0
      )
    );
  } catch (e) {}

  return 0;
}

export function hudMarkPlayerTeamResetEpoch(player) {
  if (!player) return false;

  try {
    player.setDynamicProperty(
      HUD_TEAM_RESET_EPOCH_KEY,
      hudGetTeamResetEpoch()
    );
    return true;
  } catch (e) {}

  return false;
}

export function hudAdvanceTeamResetEpoch() {
  var next = hudGetTeamResetEpoch() + 1;

  try {
    world.setDynamicProperty(
      HUD_TEAM_RESET_EPOCH_KEY,
      next
    );
    return next;
  } catch (e) {}

  return hudGetTeamResetEpoch();
}

export function hudEnsurePlayerTeamResetEpoch(player) {
  if (!player) return false;

  var worldEpoch = hudGetTeamResetEpoch();
  var playerEpoch = hudGetPlayerTeamResetEpoch(player);

  if (playerEpoch === worldEpoch) return false;

  // The player was offline during a full reset. Their old color tags are
  // stale even though Minecraft persisted them on the player entity.
  hudClearRatioTeamTags(player);
  hudMarkPlayerTeamResetEpoch(player);
  return true;
}

function playerHasTag(player, tag) {
  if (!player || !tag) return false;
  try {
    if (typeof player.hasTag === "function") return player.hasTag(tag);
  } catch (e) {}
  try {
    return player.getTags().indexOf(tag) !== -1;
  } catch (e2) {}
  return false;
}

// The source objective is read for every player on every update. Within one
// tick the handle is remembered (a removed objective is noticed next tick).
var objectiveMemoTick = -1;
var objectiveMemo = {};

function getOrCreateObjective(objectiveName, displayName) {
  var name = String(objectiveName || "");
  if (!name) return undefined;

  var tick = -1;
  try {
    tick = system.currentTick;
  } catch (eTick) {}

  if (tick !== objectiveMemoTick) {
    objectiveMemo = {};
    objectiveMemoTick = tick;
  }

  if (objectiveMemo[name]) return objectiveMemo[name];

  var found = lookUpOrCreateObjective(name, displayName);
  if (found) objectiveMemo[name] = found;
  return found;
}

function lookUpOrCreateObjective(name, displayName) {
  var objective = undefined;
  try {
    objective = world.scoreboard.getObjective(name);
  } catch (e) {}

  if (objective) return objective;

  try {
    return world.scoreboard.addObjective(name, displayName || name);
  } catch (e2) {}

  try {
    return world.scoreboard.getObjective(name);
  } catch (e3) {}

  return undefined;
}

function playerScoreIdentity(player) {
  try {
    return player && player.scoreboardIdentity ? player.scoreboardIdentity : undefined;
  } catch (e) {}
  return undefined;
}

export function hudGetPlayerCounter(player, objectiveName) {
  var objective = getOrCreateObjective(objectiveName);
  var identity = playerScoreIdentity(player);
  if (!objective || !identity) return 0;

  try {
    return Math.max(0, Number(objective.getScore(identity)) || 0);
  } catch (e) {}

  return 0;
}

export function hudSetPlayerCounter(player, objectiveName, value, displayName) {
  var objective = getOrCreateObjective(objectiveName, displayName);
  var identity = playerScoreIdentity(player);
  if (!objective || !identity) return 0;

  var next = Math.max(0, Math.floor(Number(value) || 0));
  try {
    objective.setScore(identity, next);
  } catch (e) {}

  return next;
}

export function hudAddPlayerCounter(player, objectiveName, amount, displayName) {
  var current = hudGetPlayerCounter(player, objectiveName);
  return hudSetPlayerCounter(
    player,
    objectiveName,
    current + (Number(amount) || 0),
    displayName
  );
}

export function hudResetPlayerCounter(player, objectiveName) {
  return hudSetPlayerCounter(player, objectiveName, 0);
}

export function hudResetCounterForPlayers(players, objectiveName) {
  var list = players || [];
  for (var i = 0; i < list.length; i++) {
    hudResetPlayerCounter(list[i], objectiveName);
  }
}

// The team of a player is looked up many times per update (bars, ratio,
// team area). Within one tick the answer is remembered per player; any tag
// change made through this file forgets it at once.
var teamStateMemoTick = -1;
var teamStateMemo = {};

function forgetTeamStates() {
  teamStateMemo = {};
}

function memoPlayerId(player) {
  try {
    return String(player.id);
  } catch (e) {}
  return "";
}

export function hudRatioTeamTagState(player, teamTags) {
  if (!teamTags && player) {
    var tick = -1;
    try {
      tick = system.currentTick;
    } catch (eTick) {}

    if (tick !== teamStateMemoTick) {
      teamStateMemo = {};
      teamStateMemoTick = tick;
    }

    var id = memoPlayerId(player);
    if (id && teamStateMemo[id]) return teamStateMemo[id];

    var fresh = readRatioTeamTagState(player, undefined);
    if (id) teamStateMemo[id] = fresh;
    return fresh;
  }

  return readRatioTeamTagState(player, teamTags);
}

function readRatioTeamTagState(player, teamTags) {
  var tags = teamTags || HUD_RATIO_TEAM_TAGS;
  var colors = [];

  if (!player) {
    return {
      team: "",
      colors: colors,
      count: 0,
      conflict: false
    };
  }

  for (var i = 0; i < HUD_RATIO_TEAM_ORDER.length; i++) {
    var team = HUD_RATIO_TEAM_ORDER[i];
    var tag = tags[team];
    if (!tag) continue;

    if (playerHasTag(player, tag)) {
      colors.push(team);
    }
  }

  return {
    team: colors.length === 1 ? colors[0] : "",
    colors: colors,
    count: colors.length,
    conflict: colors.length > 1
  };
}

export function hudNormalizeRatioTeamTags(player, teamTags) {
  var state = hudRatioTeamTagState(player, teamTags);

  // Manual tag editing can leave a player in several colors at once.
  // There is no reliable "last manually added tag" ordering information,
  // so a conflict is resolved safely by clearing only the registered
  // color-team tags and making the player unassigned.
  if (state.conflict) {
    hudClearRatioTeamTags(player, teamTags);

    return {
      team: "",
      colors: state.colors,
      count: state.count,
      conflict: true,
      cleared: true
    };
  }

  return {
    team: state.team,
    colors: state.colors,
    count: state.count,
    conflict: false,
    cleared: false
  };
}

export function hudRatioTeamForPlayer(player, teamTags) {
  return hudNormalizeRatioTeamTags(player, teamTags).team;
}

export function hudSetRatioTeamTag(player, team, teamTags) {
  if (!player) return false;

  var tags = teamTags || HUD_RATIO_TEAM_TAGS;
  var nextTeam = String(team || "").toLowerCase();
  var changed = false;

  for (var i = 0; i < HUD_RATIO_TEAM_ORDER.length; i++) {
    var name = HUD_RATIO_TEAM_ORDER[i];
    var tag = tags[name];
    if (!tag) continue;

    try {
      if (name === nextTeam) {
        if (!playerHasTag(player, tag)) {
          player.addTag(tag);
          changed = true;
        }
      } else if (playerHasTag(player, tag)) {
        player.removeTag(tag);
        changed = true;
      }
    } catch (e) {}
  }

  forgetTeamStates();
  hudMarkPlayerTeamResetEpoch(player);
  return changed;
}

export function hudClearRatioTeamTags(player, teamTags) {
  if (!player) return false;

  var tags = teamTags || HUD_RATIO_TEAM_TAGS;
  var changed = false;

  for (var i = 0; i < HUD_RATIO_TEAM_ORDER.length; i++) {
    var tag = tags[HUD_RATIO_TEAM_ORDER[i]];
    if (!tag) continue;

    try {
      if (playerHasTag(player, tag)) {
        player.removeTag(tag);
        changed = true;
      }
    } catch (e) {}
  }

  forgetTeamStates();
  hudMarkPlayerTeamResetEpoch(player);
  return changed;
}

var teamTagConflictGuardHandle = undefined;
var teamTagConflictGuardIntervalTicks = 0;

export function startHudTeamTagConflictGuard(options) {
  if (teamTagConflictGuardHandle !== undefined) {
    return teamTagConflictGuardHandle;
  }

  var opts = options || {};
  var intervalTicks = Math.max(
    1,
    Math.floor(Number(opts.intervalTicks) || 20)
  );

  teamTagConflictGuardIntervalTicks = intervalTicks;

  teamTagConflictGuardHandle = system.runInterval(function () {
    var players = [];

    try {
      players = world.getPlayers();
    } catch (e) {
      players = [];
    }

    for (var i = 0; i < players.length; i++) {
      hudEnsurePlayerTeamResetEpoch(players[i]);
      hudNormalizeRatioTeamTags(
        players[i],
        opts.teamTags
      );
    }
  }, intervalTicks);

  return teamTagConflictGuardHandle;
}

export function stopHudTeamTagConflictGuard() {
  if (teamTagConflictGuardHandle === undefined) return;

  try {
    system.clearRun(teamTagConflictGuardHandle);
  } catch (e) {}

  teamTagConflictGuardHandle = undefined;
  teamTagConflictGuardIntervalTicks = 0;
}

export function getHudTeamRuntimeStats() {
  return {
    conflictGuardActive: teamTagConflictGuardHandle !== undefined,
    conflictGuardIntervalTicks: teamTagConflictGuardIntervalTicks,
    teamColorCount: HUD_RATIO_TEAM_ORDER.length
  };
}

// Enabled by default. Only the eight registered team-color tags are touched.
system.run(function () {
  startHudTeamTagConflictGuard();
});

try {
  if (world.afterEvents && world.afterEvents.playerSpawn) {
    world.afterEvents.playerSpawn.subscribe(function (event) {
      if (!event || !event.player) return;

      var player = event.player;
      system.run(function () {
        hudEnsurePlayerTeamResetEpoch(player);
        hudNormalizeRatioTeamTags(player);
      });
    });
  }
} catch (eSpawn) {}

export function hudRatioTeamMembers(players, teamTags) {
  var result = {
    red: [],
    blue: [],
    yellow: [],
    green: [],
    cyan: [],
    purple: [],
    orange: [],
    pink: []
  };
  var list = players || [];

  for (var i = 0; i < list.length; i++) {
    var player = list[i];
    var team = hudRatioTeamForPlayer(player, teamTags);
    if (team && result[team]) result[team].push(player);
  }

  return result;
}

export function hudRatioTeamValues(players, getPlayerValue, teamTags) {
  var values = {
    red: 0,
    blue: 0,
    yellow: 0,
    green: 0,
    cyan: 0,
    purple: 0,
    orange: 0,
    pink: 0
  };
  var list = players || [];
  var valueFn = typeof getPlayerValue === "function"
    ? getPlayerValue
    : function () { return 0; };

  for (var i = 0; i < list.length; i++) {
    var player = list[i];
    var team = hudRatioTeamForPlayer(player, teamTags);
    if (!team || values[team] === undefined) continue;

    var value = 0;
    try {
      value = valueFn(player, team);
    } catch (e) {
      value = 0;
    }
    values[team] += Math.max(0, Number(value) || 0);
  }

  return [
    values.red,
    values.blue,
    values.yellow,
    values.green,
    values.cyan,
    values.purple,
    values.orange,
    values.pink
  ];
}

export function hudRatioTeamTotals(players, getPlayerValue, teamTags) {
  var values = hudRatioTeamValues(players, getPlayerValue, teamTags);
  var totals = {};
  for (var i = 0; i < HUD_RATIO_TEAM_ORDER.length; i++) {
    totals[HUD_RATIO_TEAM_ORDER[i]] = values[i] || 0;
  }
  return totals;
}

export function hudScoreboardTeamValues(players, objectiveName, teamTags) {
  return hudRatioTeamValues(players, function (member) {
    return hudGetPlayerCounter(member, objectiveName);
  }, teamTags);
}

export function hudScoreboardTeamTotals(players, objectiveName, teamTags) {
  var values = hudScoreboardTeamValues(players, objectiveName, teamTags);
  var totals = {};
  for (var i = 0; i < HUD_RATIO_TEAM_ORDER.length; i++) {
    totals[HUD_RATIO_TEAM_ORDER[i]] = values[i] || 0;
  }
  return totals;
}

export function hudFormatTeamTotalsText(values, labels) {
  var list = values || [];
  var names = labels || ["R", "B", "Y", "G", "C", "P", "O", "Pk"];
  var parts = [];

  for (var i = 0; i < list.length && i < HUD_RATIO_TEAM_ORDER.length; i++) {
    parts.push(
      String(names[i] || HUD_RATIO_TEAM_ORDER[i])
      + " "
      + String(list[i] || 0)
    );
  }

  return parts.join(" / ");
}

export function hudShowTeamRatioBar(players, getPlayerValue, options) {
  var opts = options || {};
  var list = players || [];
  var values = hudRatioTeamValues(list, getPlayerValue, opts.teamTags);
  var overlayText = undefined;

  if (typeof opts.buildOverlayText === "function") {
    try {
      overlayText = opts.buildOverlayText(values, list);
    } catch (e) {
      overlayText = "";
    }
  } else if (opts.overlayText !== undefined) {
    overlayText = opts.overlayText;
  } else if (opts.showTeamTotalsText) {
    overlayText = hudFormatTeamTotalsText(values, opts.teamLabels);
  }

  for (var i = 0; i < list.length; i++) {
    if (opts.onlyTeamMembers && !hudRatioTeamForPlayer(list[i], opts.teamTags)) {
      continue;
    }
    showReusableRatioBar(list[i], values, opts);
    if (overlayText !== undefined) {
      setReusableHudOverlayText(list[i], overlayText, opts.force);
    }
  }

  return values;
}

export function hudTeamRatioSnapshot(players, getPlayerValue, teamTags) {
  var list = players || [];
  var parts = [];
  var valueFn = typeof getPlayerValue === "function"
    ? getPlayerValue
    : function () { return 0; };

  for (var i = 0; i < list.length; i++) {
    var player = list[i];
    var team = hudRatioTeamForPlayer(player, teamTags);
    var value = 0;
    try {
      value = valueFn(player, team);
    } catch (e) {
      value = 0;
    }
    parts.push(String(player.id || player.name || i) + ":" + team + ":" + value);
  }

  parts.sort();
  return parts.join("|");
}

export function startTeamRatioBarWatcher(getPlayerValue, options) {
  var opts = options || {};
  var intervalTicks = Math.max(1, Math.floor(Number(opts.intervalTicks) || 10));

  stopTeamRatioBarWatcher();
  lastSnapshot = "";

  watcherHandle = system.runInterval(function () {
    var players = [];
    try {
      players = world.getPlayers();
    } catch (e) {
      return;
    }

    var snapshot = hudTeamRatioSnapshot(players, getPlayerValue, opts.teamTags);
    if (!opts.forceEveryTick && snapshot === lastSnapshot) return;

    lastSnapshot = snapshot;
    hudShowTeamRatioBar(players, getPlayerValue, opts);
  }, intervalTicks);

  return watcherHandle;
}

export function startScoreboardTeamRatioBarWatcher(objectiveName, options) {
  var name = String(objectiveName || "");
  return startTeamRatioBarWatcher(function (member) {
    return hudGetPlayerCounter(member, name);
  }, options);
}

function entityTypeMatches(entity, typeIds) {
  if (!typeIds || typeIds.length <= 0) return true;
  if (!entity) return false;

  var typeId = "";
  try {
    typeId = String(entity.typeId || "");
  } catch (e) {}

  for (var i = 0; i < typeIds.length; i++) {
    if (typeId === String(typeIds[i])) return true;
  }

  return false;
}

function damagingPlayerFromEvent(event) {
  var source = undefined;
  try {
    source = event.damageSource;
  } catch (e) {}

  var entity = undefined;
  try {
    entity = source && source.damagingEntity ? source.damagingEntity : undefined;
  } catch (e2) {}

  if (!entity) return undefined;
  try {
    if (entity.typeId === "minecraft:player") return entity;
  } catch (e3) {}

  return undefined;
}

export function startMobKillCounter(objectiveName, options) {
  var opts = options || {};
  var typeIds = Array.isArray(opts.typeIds) ? opts.typeIds : [];
  var amount = opts.amount === undefined ? 1 : Number(opts.amount) || 1;
  var name = String(objectiveName || "");
  if (!name || !world.afterEvents || !world.afterEvents.entityDie) return undefined;

  getOrCreateObjective(name, opts.displayName);

  var callback = function (event) {
    var deadEntity = undefined;
    try {
      deadEntity = event.deadEntity;
    } catch (e) {}

    if (!entityTypeMatches(deadEntity, typeIds)) return;

    var player = damagingPlayerFromEvent(event);
    if (!player) return;

    if (opts.onlyTeamMembers && !hudRatioTeamForPlayer(player, opts.teamTags)) {
      return;
    }

    hudAddPlayerCounter(player, name, amount, opts.displayName);
  };

  world.afterEvents.entityDie.subscribe(callback);

  counterEventHandles.push({
    event: world.afterEvents.entityDie,
    callback: callback
  });

  return callback;
}

export function stopCounterEventWatchers() {
  for (var i = 0; i < counterEventHandles.length; i++) {
    var entry = counterEventHandles[i];
    try {
      if (entry && entry.event && entry.callback) {
        entry.event.unsubscribe(entry.callback);
      }
    } catch (e) {}
  }
  counterEventHandles = [];
}

export function stopTeamRatioBarWatcher() {
  if (watcherHandle === undefined) return;

  try {
    system.clearRun(watcherHandle);
  } catch (e) {}

  watcherHandle = undefined;
  lastSnapshot = "";
}
