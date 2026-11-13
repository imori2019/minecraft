// Command-block bridge for the 1..8 team ratio bar.
//
// Fake players:
//   red blue yellow green cyan purple orange pink
//
// Objectives:
//   rt_ratio        -> current integer percentage (all active teams sum to 100)
//   rt_ratio_event  -> one-shot crossed percentage, otherwise -1
//   rt_ratio_value  -> raw aggregated source value
//   rt_ratio_active -> 1 when at least one eligible player has that team tag

import {
  system,
  world
} from "@minecraft/server";
import {
  getCachedObjective,
  writeScoreCached
} from "../reusable_score_writer.js";

export var RATIO_BRIDGE_TEAMS = [
  "red",
  "blue",
  "yellow",
  "green",
  "cyan",
  "purple",
  "orange",
  "pink"
];

export var RATIO_BRIDGE_OBJECTIVES = {
  ratio: "rt_ratio",
  event: "rt_ratio_event",
  value: "rt_ratio_value",
  active: "rt_ratio_active"
};

var previousPercent = [
  undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined
];

var eventQueues = {};
var eventBusy = {};
var generation = 0;

function objective(id, displayName) {
  return getCachedObjective(id, displayName);
}

// Unchanged values are not written again (see reusable_score_writer.js).
function setFakeScore(objectiveId, displayName, name, value) {
  var obj = objective(objectiveId, displayName);
  if (!obj) return false;

  return writeScoreCached(obj, String(name), String(name), value);
}

function crossedIntegers(previous, current) {
  if (
    previous === undefined
    || current === undefined
    || previous === current
  ) {
    return [];
  }

  var values = [];

  if (current > previous) {
    for (var up = previous + 1; up <= current; up++) {
      values.push(up);
    }
  } else {
    for (var down = previous - 1; down >= current; down--) {
      values.push(down);
    }
  }

  return values;
}

function runTeamEventQueue(team) {
  if (eventBusy[team]) return;

  var queue = eventQueues[team];
  if (!queue || queue.length <= 0) {
    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.event,
      "RT Ratio Event",
      team,
      -1
    );
    return;
  }

  eventBusy[team] = true;
  var myGeneration = generation;

  function next() {
    if (myGeneration !== generation) {
      eventBusy[team] = false;
      return;
    }

    var currentQueue = eventQueues[team] || [];
    if (currentQueue.length <= 0) {
      setFakeScore(
        RATIO_BRIDGE_OBJECTIVES.event,
        "RT Ratio Event",
        team,
        -1
      );
      eventBusy[team] = false;
      return;
    }

    var value = currentQueue.shift();
    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.event,
      "RT Ratio Event",
      team,
      value
    );

    // Hold each one-shot value for one game tick, then advance/reset.
    system.run(function () {
      next();
    });
  }

  next();
}

function queueTeamEvents(team, values) {
  var list = Array.isArray(values) ? values : [values];

  if (!eventQueues[team]) eventQueues[team] = [];

  for (var i = 0; i < list.length; i++) {
    var number = Math.floor(Number(list[i]));
    if (!isFinite(number)) continue;
    if (number < 0 || number > 100) continue;
    eventQueues[team].push(number);
  }

  runTeamEventQueue(team);
}

export function ratioPercentages(weights) {
  var source = (weights || []).slice(0, RATIO_BRIDGE_TEAMS.length);
  while (source.length < RATIO_BRIDGE_TEAMS.length) source.push(0);

  var normalized = [];
  var total = 0;

  for (var i = 0; i < source.length; i++) {
    var value = Math.max(0, Number(source[i]) || 0);
    normalized.push(value);
    total += value;
  }

  if (total <= 0) {
    return [0, 0, 0, 0, 0, 0, 0, 0];
  }

  var raw = [];
  var result = [];
  var used = 0;

  for (var r = 0; r < normalized.length; r++) {
    raw[r] = (normalized[r] / total) * 100;
    result[r] = Math.floor(raw[r]);
    used += result[r];
  }

  var remaining = 100 - used;
  var order = [];

  for (var o = 0; o < normalized.length; o++) {
    order.push({
      index: o,
      frac: raw[o] - Math.floor(raw[o]),
      value: normalized[o]
    });
  }

  order.sort(function (a, b) {
    if (b.frac !== a.frac) return b.frac - a.frac;
    if (b.value !== a.value) return b.value - a.value;
    return a.index - b.index;
  });

  for (var add = 0; add < order.length && remaining > 0; add++) {
    result[order[add].index]++;
    remaining--;
  }

  return result;
}

export function resetRatioCommandEvents() {
  generation++;
  eventQueues = {};
  eventBusy = {};

  for (var i = 0; i < RATIO_BRIDGE_TEAMS.length; i++) {
    previousPercent[i] = undefined;
    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.event,
      "RT Ratio Event",
      RATIO_BRIDGE_TEAMS[i],
      -1
    );
  }
}

export function clearRatioCommandBridge() {
  resetRatioCommandEvents();

  for (var i = 0; i < RATIO_BRIDGE_TEAMS.length; i++) {
    var team = RATIO_BRIDGE_TEAMS[i];

    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.ratio,
      "RT Ratio",
      team,
      0
    );
    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.value,
      "RT Ratio Value",
      team,
      0
    );
    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.active,
      "RT Ratio Active",
      team,
      0
    );
  }
}

export function syncRatioCommandBridge(
  values,
  presence,
  displayWeights,
  running,
  teamNames
) {
  var selectedTeams = Array.isArray(teamNames)
    ? teamNames.slice(0, RATIO_BRIDGE_TEAMS.length)
    : RATIO_BRIDGE_TEAMS.slice(0, (values || []).length);

  var rawValues = (values || []).slice(0, selectedTeams.length);
  var active = (presence || []).slice(0, selectedTeams.length);
  var weights = (displayWeights || []).slice(0, selectedTeams.length);

  while (rawValues.length < selectedTeams.length) rawValues.push(0);
  while (active.length < selectedTeams.length) active.push(0);
  while (weights.length < selectedTeams.length) weights.push(0);

  var selectedPercentages = ratioPercentages(weights);
  var percentagesByTeam = [
    0, 0, 0, 0, 0, 0, 0, 0
  ];
  var valuesByTeam = [
    0, 0, 0, 0, 0, 0, 0, 0
  ];
  var activeByTeam = [
    0, 0, 0, 0, 0, 0, 0, 0
  ];

  for (var mapIndex = 0; mapIndex < selectedTeams.length; mapIndex++) {
    var mappedTeam = String(selectedTeams[mapIndex] || "").toLowerCase();
    var canonicalIndex = RATIO_BRIDGE_TEAMS.indexOf(mappedTeam);
    if (canonicalIndex < 0) continue;

    var mappedActive = active[mapIndex] ? 1 : 0;
    activeByTeam[canonicalIndex] = mappedActive;

    // rt_ratio mirrors the visible/frozen bar percentage.
    // rt_ratio_active is the separate online-presence signal, so a team going
    // offline must not silently change rt_ratio from e.g. 50 to 0 while the
    // HUD is intentionally still showing 50%.
    percentagesByTeam[canonicalIndex] = Math.max(
      0,
      Math.floor(Number(selectedPercentages[mapIndex]) || 0)
    );

    // rt_ratio_value mirrors the source value represented by the current
    // visual snapshot. Online presence is exposed independently by active.
    valuesByTeam[canonicalIndex] = Math.max(
      0,
      Math.floor(Number(rawValues[mapIndex]) || 0)
    );
  }

  for (var i = 0; i < RATIO_BRIDGE_TEAMS.length; i++) {
    var team = RATIO_BRIDGE_TEAMS[i];
    var isActive = activeByTeam[i];
    var currentPercent = percentagesByTeam[i];
    var currentValue = valuesByTeam[i];

    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.ratio,
      "RT Ratio",
      team,
      currentPercent
    );
    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.value,
      "RT Ratio Value",
      team,
      currentValue
    );
    setFakeScore(
      RATIO_BRIDGE_OBJECTIVES.active,
      "RT Ratio Active",
      team,
      isActive
    );

    if (!running || !isActive) {
      // Cancel any crossed-percentage values that were queued while this team
      // was active. Otherwise an old 20->80 queue can keep firing after the
      // player/team has already gone inactive.
      eventQueues[team] = [];
      previousPercent[i] = undefined;
      setFakeScore(
        RATIO_BRIDGE_OBJECTIVES.event,
        "RT Ratio Event",
        team,
        -1
      );
      continue;
    }

    if (previousPercent[i] === undefined) {
      previousPercent[i] = currentPercent;
      queueTeamEvents(team, currentPercent);
      continue;
    }

    var crossed = crossedIntegers(
      previousPercent[i],
      currentPercent
    );
    previousPercent[i] = currentPercent;

    if (crossed.length > 0) {
      queueTeamEvents(team, crossed);
    }
  }

  return {
    percentages: percentagesByTeam.slice(),
    values: valuesByTeam.slice(),
    active: activeByTeam.slice()
  };
}
