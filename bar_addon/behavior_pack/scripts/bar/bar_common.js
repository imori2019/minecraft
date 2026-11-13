// Shared helpers for the three HUD bar families.
//
// Top-level kinds are intentionally limited to:
//   timer   - clock only
//   counter - count up/down bars (score/stat or legacy timed progress)
//   ratio   - team/value ratio bar
//
// Legacy mode names are accepted so older commands and saved worlds keep working.

import {
  HUD_RATIO_TEAM_ORDER,
  hudGetPlayerCounter,
  hudRatioTeamForPlayer,
  hudResetCounterForPlayers
} from "../reusable_team_ratio_bar.js";
import {
  isReusableStatSource,
  getReusableStatSourceValue,
  reusableStatKeyFromSource,
  parseReusableStatSource,
  reusableStatStoredKey
} from "../reusable_stat_source.js";
import {
  setReusableStoredStat
} from "../reusable_stat_store.js";

export var BAR_KIND_TIMER = "timer";
export var BAR_KIND_COUNTER = "counter";
export var BAR_KIND_RATIO = "ratio";

export function barKind(mode) {
  var text = String(mode || "").toLowerCase();

  if (text === "timer" || text === "time") return BAR_KIND_TIMER;
  if (text === "ratio" || text === "account" || text === "score") {
    return BAR_KIND_RATIO;
  }

  if (
    text === "countup"
    || text === "up"
    || text === "countdown"
    || text === "down"
    || text === "time_countup"
    || text === "countupbar"
    || text === "time_countdown"
    || text === "countdownbar"
  ) {
    return BAR_KIND_COUNTER;
  }

  return "";
}

export function counterDirection(mode) {
  var text = String(mode || "").toLowerCase();
  return (
    text === "countdown"
    || text === "down"
    || text === "time_countdown"
    || text === "countdownbar"
  ) ? "down" : "up";
}

export function isTimedCounterMode(mode) {
  var text = String(mode || "").toLowerCase();
  return text === "time_countup" || text === "time_countdown";
}

export function clampCounterMax(value) {
  return Math.max(1, Math.floor(Number(value) || 1));
}

export function clampRatioTeamCount(value) {
  return Math.max(1, Math.min(8, Math.floor(Number(value) || 4)));
}

export function parseRatioTeamSelection(value) {
  if (Array.isArray(value)) {
    var arrayText = value.join("_");
    return parseRatioTeamSelection(arrayText);
  }

  var text = String(value || "").trim().toLowerCase();
  if (!text) return [];

  // Compatibility with the old numeric syntax:
  // 1 = red, 2 = red_blue, ... 8 = all eight colors.
  if (/^[1-8]$/.test(text)) {
    return HUD_RATIO_TEAM_ORDER.slice(0, Number(text));
  }

  if (text === "all") {
    return HUD_RATIO_TEAM_ORDER.slice();
  }

  var requested = text.split("_");
  var seen = {};

  for (var i = 0; i < requested.length; i++) {
    var team = requested[i];
    if (HUD_RATIO_TEAM_ORDER.indexOf(team) < 0) return [];
    if (seen[team]) return [];
    seen[team] = true;
  }

  // Always use the canonical HUD layer order. This lets arbitrary selections
  // such as purple_red render safely as red + purple.
  var normalized = [];
  for (var order = 0; order < HUD_RATIO_TEAM_ORDER.length; order++) {
    var name = HUD_RATIO_TEAM_ORDER[order];
    if (seen[name]) normalized.push(name);
  }

  return normalized;
}

export function ratioTeamSelectionIsValid(value) {
  return parseRatioTeamSelection(value).length > 0;
}

export function ratioTeamSelectionToken(value, fallbackCount) {
  var teams = parseRatioTeamSelection(value);

  if (teams.length <= 0 && fallbackCount !== undefined) {
    teams = HUD_RATIO_TEAM_ORDER.slice(
      0,
      clampRatioTeamCount(fallbackCount)
    );
  }

  return teams.join("_");
}

// The タグ part of stat:<統計>.<対象>.<タグ>. Only players that match count.
function playerMatchesStatTag(player, tag) {
  var text = String(tag || "").trim();
  if (!text) return true;
  if (!player) return false;

  var low = text.toLowerCase();

  if (low === "all") return true;
  if (low === "team") return !!hudRatioTeamForPlayer(player);
  if (HUD_RATIO_TEAM_ORDER.indexOf(low) >= 0) {
    return hudRatioTeamForPlayer(player) === low;
  }

  try {
    return !!player.hasTag(text);
  } catch (e) {}

  return false;
}

export function reusableBarSourceValue(player, source) {
  if (isReusableStatSource(source)) {
    var statTag = parseReusableStatSource(source).tag;
    if (!playerMatchesStatTag(player, statTag)) return 0;

    var statValue = getReusableStatSourceValue(player, source);
    return Number(statValue) || 0;
  }

  return hudGetPlayerCounter(player, source);
}

export function objectiveTotal(players, objectiveName, onlyTeamMembers) {
  var total = 0;
  var list = players || [];

  for (var i = 0; i < list.length; i++) {
    if (onlyTeamMembers && !hudRatioTeamForPlayer(list[i])) continue;
    total += reusableBarSourceValue(list[i], objectiveName);
  }

  return total;
}

export function resetCounterSource(players, source) {
  var list = players || [];
  var sourceName = String(source || "");

  if (isReusableStatSource(sourceName)) {
    var parsed = parseReusableStatSource(sourceName);
    for (var i = 0; i < list.length; i++) {
      // Players that are not counted keep their recorded value.
      if (!playerMatchesStatTag(list[i], parsed.tag)) continue;
      for (var k = 0; k < parsed.keys.length; k++) {
        setReusableStoredStat(list[i], reusableStatStoredKey(parsed.keys[k]), 0);
      }
    }
    return true;
  }

  hudResetCounterForPlayers(list, sourceName);
  return true;
}

export function ratioTeamValues(players, objectiveName, selection) {
  var teams = parseRatioTeamSelection(selection);
  var valuesByTeam = {};

  for (var init = 0; init < HUD_RATIO_TEAM_ORDER.length; init++) {
    valuesByTeam[HUD_RATIO_TEAM_ORDER[init]] = 0;
  }

  var list = players || [];

  for (var i = 0; i < list.length; i++) {
    var team = hudRatioTeamForPlayer(list[i]);
    if (!team || teams.indexOf(team) < 0) continue;
    valuesByTeam[team] += reusableBarSourceValue(
      list[i],
      objectiveName
    );
  }

  var values = [];
  for (var t = 0; t < teams.length; t++) {
    values.push(valuesByTeam[teams[t]] || 0);
  }

  return values;
}

export function ratioSelectedPlayers(players, selection) {
  var teams = parseRatioTeamSelection(selection);
  var list = players || [];
  var selected = [];

  for (var i = 0; i < list.length; i++) {
    var team = hudRatioTeamForPlayer(list[i]);
    if (!team || teams.indexOf(team) < 0) continue;
    selected.push(list[i]);
  }

  return selected;
}

export function ratioTeamPresence(players, selection) {
  var teams = parseRatioTeamSelection(selection);
  var presentByTeam = {};

  for (var init = 0; init < teams.length; init++) {
    presentByTeam[teams[init]] = 0;
  }

  var list = players || [];

  for (var i = 0; i < list.length; i++) {
    var team = hudRatioTeamForPlayer(list[i]);
    if (!team || presentByTeam[team] === undefined) continue;
    presentByTeam[team] = 1;
  }

  var presence = [];
  for (var t = 0; t < teams.length; t++) {
    presence.push(presentByTeam[teams[t]] ? 1 : 0);
  }

  return presence;
}
