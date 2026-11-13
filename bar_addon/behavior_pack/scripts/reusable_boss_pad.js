// Keeps the bar HUD below boss bars.
//
// The resource pack already reserves 20px per vanilla / custom boss bar by
// itself (a copy of the boss bar collection in the UI). This script adds a
// second, independent source for the same space, in case the UI cannot see a
// bar. The UI uses the larger of the two, so they never add up.
//
//   * ender dragon       counts for everybody in its dimension
//   * wither             counts within NEAR_BLOCKS
//   * entity tag rt_boss counts within NEAR_BLOCKS  (custom bosses)
//   * entity family boss counts within NEAR_BLOCKS  (custom bosses)
//   * player tag rt_pad1 / rt_pad2 / rt_pad3: keep that many rows free, always
//     (for bars that are not real boss bars, e.g. a title-based custom bar)

import { system, world } from "@minecraft/server";
import {
  hasActiveReusableHud,
  setReusableHudBossPad
} from "./reusable_hud_display.js";

var CHECK_TICKS = 20;
var NEAR_BLOCKS = 64;
var MAX_ROWS = 3;

var started = false;

function safeEntities(dimension, options) {
  try {
    return dimension.getEntities(options) || [];
  } catch (e) {}
  return [];
}

// Boss entities of one dimension: [{ id, x, y, z, everywhere }]
function bossesOf(dimension) {
  var found = {};

  function add(options, everywhere) {
    var list = safeEntities(dimension, options);
    for (var i = 0; i < list.length; i++) {
      var entity = list[i];
      var id = "";
      var location;
      try {
        id = String(entity.id);
        location = entity.location;
      } catch (e) {}
      if (!id || !location) continue;

      if (found[id]) {
        found[id].everywhere = found[id].everywhere || everywhere;
        continue;
      }
      found[id] = {
        id: id,
        x: location.x,
        y: location.y,
        z: location.z,
        everywhere: everywhere
      };
    }
  }

  add({ type: "minecraft:ender_dragon" }, true);
  add({ type: "minecraft:wither" }, false);
  add({ tags: ["rt_boss"] }, false);
  add({ families: ["boss"] }, false);

  var out = [];
  for (var key in found) {
    if (Object.prototype.hasOwnProperty.call(found, key)) out.push(found[key]);
  }
  return out;
}

function manualRows(player) {
  var tags = [];
  try {
    tags = player.getTags();
  } catch (e) {}

  for (var rows = MAX_ROWS; rows >= 1; rows--) {
    if (tags.indexOf("rt_pad" + rows) >= 0) return rows;
  }
  return 0;
}

function autoRows(player, bosses) {
  var location;
  try {
    location = player.location;
  } catch (e) {}

  var count = 0;
  for (var i = 0; i < bosses.length; i++) {
    var boss = bosses[i];
    if (boss.everywhere) {
      count++;
      continue;
    }
    if (!location) continue;

    var dx = boss.x - location.x;
    var dy = boss.y - location.y;
    var dz = boss.z - location.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= NEAR_BLOCKS) count++;
  }
  return Math.min(MAX_ROWS, count);
}

export function updateReusableBossPadNow() {
  var players = [];
  try {
    players = world.getPlayers();
  } catch (e) {}

  var bossesByDimension = {};

  for (var i = 0; i < players.length; i++) {
    var player = players[i];
    var rows = manualRows(player);

    var dimension;
    var dimensionId = "";
    try {
      dimension = player.dimension;
      dimensionId = String(dimension.id);
    } catch (e2) {}

    if (dimension && dimensionId) {
      if (!bossesByDimension[dimensionId]) {
        bossesByDimension[dimensionId] = bossesOf(dimension);
      }
      rows = Math.max(rows, autoRows(player, bossesByDimension[dimensionId]));
    }

    setReusableHudBossPad(player, rows);
  }
}

export function initializeReusableBossPad() {
  if (started) return false;
  started = true;

  system.runInterval(function () {
    // Nothing on screen: nothing to move.
    if (!hasActiveReusableHud()) return;

    try {
      updateReusableBossPadNow();
    } catch (e) {}
  }, CHECK_TICKS);

  return true;
}
