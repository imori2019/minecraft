// Lighter scoreboard output.
//
// The bars write their state to scoreboards every update so command blocks can
// read it. Most of those values do not change between updates, so:
//   * objective handles are remembered instead of looked up on every write
//   * a value objective is only written when its value changed
//   * every few seconds everything is written again, so a value someone
//     changed by hand is put back
// Objectives whose id contains "event" are always written: command blocks may
// wait for the same event value again after resetting it.

import { system, world } from "@minecraft/server";

var REFRESH_TICKS = 100;

var objectiveCache = {};
var lastWritten = {};
var lastRefreshTick = -1;

function currentTick() {
  try {
    return system.currentTick;
  } catch (e) {}
  return 0;
}

function refreshIfDue() {
  var tick = currentTick();
  if (lastRefreshTick < 0 || tick - lastRefreshTick >= REFRESH_TICKS || tick < lastRefreshTick) {
    lastWritten = {};
    lastRefreshTick = tick;
  }
}

function isUsable(objective) {
  if (!objective) return false;
  try {
    if (objective.isValid === false) return false;
  } catch (e) {}
  return true;
}

export function getCachedObjective(id, displayName) {
  var key = String(id);
  var cached = objectiveCache[key];
  if (isUsable(cached)) return cached;

  var found;
  try {
    found = world.scoreboard.getObjective(key);
  } catch (e) {}

  if (!found) {
    try {
      found = world.scoreboard.addObjective(key, displayName || key);
    } catch (e2) {}
  }

  if (found) objectiveCache[key] = found;
  else delete objectiveCache[key];

  return found;
}

export function forgetCachedObjective(id) {
  delete objectiveCache[String(id)];
}

function objectiveId(objective) {
  try {
    return String(objective.id);
  } catch (e) {}
  return "";
}

// participant: a ScoreboardIdentity, an Entity or a fake-player name.
// participantKey: a stable text for the participant (player id or name).
// Returns true when the value is (already) on the scoreboard.
export function writeScoreCached(objective, participant, participantKey, value) {
  if (!objective || participant === undefined || participant === null) return false;

  refreshIfDue();

  var number = Math.floor(Number(value) || 0);
  var id = objectiveId(objective);
  var isEvent = id.toLowerCase().indexOf("event") >= 0;
  var cacheKey = id + "|" + String(participantKey);

  if (!isEvent && lastWritten[cacheKey] === number) return true;

  try {
    objective.setScore(participant, number);
    lastWritten[cacheKey] = number;
    return true;
  } catch (e) {
    // The objective may have been removed: look it up again next time.
    delete lastWritten[cacheKey];
    forgetCachedObjective(id);
  }
  return false;
}

// Call when objectives were removed or reset in bulk.
export function clearScoreWriteCache() {
  lastWritten = {};
  objectiveCache = {};
}
