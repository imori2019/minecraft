import { BlockPermutation, system, world } from "@minecraft/server";
import {
  clearChunkedJson,
  readChunkedJson,
  writeChunkedJson
} from "./reusable_persistence.js";
import {
  hudClearRatioTeamTags,
  hudSetRatioTeamTag
} from "./reusable_team_ratio_bar.js";

export var HUD_TEAM_AREA_TOOL_ITEM = "bar_addon:team_area_tool";

var TEAM_AREA_COLORS = [
  "red",
  "blue",
  "yellow",
  "green",
  "cyan",
  "purple",
  "orange",
  "pink"
];

var TEAM_AREA_LABELS = {
  red: "赤チーム",
  blue: "青チーム",
  yellow: "黄チーム",
  green: "緑チーム",
  cyan: "シアンチーム",
  purple: "紫チーム",
  orange: "オレンジチーム",
  pink: "ピンクチーム"
};

var TEAM_AREA_COLORED_LABELS = {
  red: "§c赤チーム",
  blue: "§9青チーム",
  yellow: "§e黄チーム",
  green: "§a緑チーム",
  cyan: "§bシアンチーム",
  purple: "§5紫チーム",
  orange: "§6オレンジチーム",
  pink: "§dピンクチーム"
};

var TEAM_AREA_BLOCK_IDS = {
  red: "block_hakobiya:red_base_block",
  blue: "block_hakobiya:blue_base_block",
  yellow: "block_hakobiya:yellow_base_block",
  green: "block_hakobiya:green_base_block",
  cyan: "block_hakobiya:cyan_base_block",
  purple: "block_hakobiya:purple_base_block",
  orange: "block_hakobiya:orange_base_block",
  pink: "block_hakobiya:pink_base_block"
};

var TEAM_AREA_PARTICLE_NS = {
  red: "bar_addon:base_side_ns_red",
  blue: "bar_addon:base_side_ns_blue",
  yellow: "bar_addon:base_side_ns_yellow",
  green: "bar_addon:base_side_ns_lime",
  cyan: "bar_addon:base_side_ns_cyan",
  purple: "bar_addon:base_side_ns_purple",
  orange: "bar_addon:base_side_ns_orange",
  pink: "bar_addon:base_side_ns_pink"
};

var TEAM_AREA_PARTICLE_EW = {
  red: "bar_addon:base_side_ew_red",
  blue: "bar_addon:base_side_ew_blue",
  yellow: "bar_addon:base_side_ew_yellow",
  green: "bar_addon:base_side_ew_lime",
  cyan: "bar_addon:base_side_ew_cyan",
  purple: "bar_addon:base_side_ew_purple",
  orange: "bar_addon:base_side_ew_orange",
  pink: "bar_addon:base_side_ew_pink"
};

var TEAM_AREA_STATE_KEY = "rt_hud:team_area_state_v1";
var TEAM_AREA_STATE_PREFIX = "rt_hud:team_area_state_v2";
var TEAM_AREA_TICKING_NAME = "rt_team_area";
var TEAM_AREA_FOOT_RADIUS = 2;
var TEAM_AREA_RING_RADIUS = 3;
var TEAM_AREA_PATTERN_8 = [
  { dx: 0, dz: -7 },
  { dx: 7, dz: -7 },
  { dx: 7, dz: 0 },
  { dx: 7, dz: 7 },
  { dx: 0, dz: 7 },
  { dx: -7, dz: 7 },
  { dx: -7, dz: 0 },
  { dx: -7, dz: -7 }
];

var TEAM_AREA_MIN_TEAMS = 2;
var TEAM_AREA_MAX_TEAMS = 8;

function normalizedTeamAreaCount(value) {
  var count = Math.floor(Number(value) || TEAM_AREA_MAX_TEAMS);

  return Math.max(
    TEAM_AREA_MIN_TEAMS,
    Math.min(TEAM_AREA_MAX_TEAMS, count)
  );
}

function teamAreaPatternForCount(count) {
  var total = normalizedTeamAreaCount(count);

  if (total === 4) {
    return [
      TEAM_AREA_PATTERN_8[0],
      TEAM_AREA_PATTERN_8[2],
      TEAM_AREA_PATTERN_8[4],
      TEAM_AREA_PATTERN_8[6]
    ];
  }

  var pattern = [];
  for (var i = 0; i < total; i++) {
    pattern.push(
      TEAM_AREA_PATTERN_8[
        Math.floor((i * 8) / total)
      ]
    );
  }

  return pattern;
}

// Blocks that are safe to clear from directly above a generated team base.
// The base floor itself is still fully restored from snapshot when removed.


var teamAreaStateLoaded = false;
var teamAreaDimensionId = "";
var teamAreaCenter = undefined;
var teamAreaAreas = [];
var teamAreaRestore = [];
var teamAreaPlayerColor = {};
var teamAreaTickHandle = undefined;
var teamAreaParticleHandle = undefined;
var teamAreaToolRegistered = false;
var teamAreaToolLastUseTickByPlayer = {};

function playerKey(player) {
  if (!player) return "";
  try {
    if (player.id) return String(player.id);
  } catch (e) {}
  return String(player.name || "");
}

function setTeamSelectionActionBar(player, message) {
  if (!player) return false;

  try {
    if (
      player.onScreenDisplay
      && typeof player.onScreenDisplay.setActionBar === "function"
    ) {
      player.onScreenDisplay.setActionBar(String(message || ""));
      return true;
    }
  } catch (e) {}

  return false;
}

function clearTeamSelectionActionBar(player) {
  setTeamSelectionActionBar(player, "");
}

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

function allPlayers() {
  try {
    return world.getPlayers();
  } catch (e) {}
  return [];
}

function floorLoc(location) {
  return {
    x: Math.floor(Number(location && location.x) || 0),
    y: Math.floor(Number(location && location.y) || 0),
    z: Math.floor(Number(location && location.z) || 0)
  };
}

function getDimension(dimensionId) {
  try {
    return world.getDimension(dimensionId || "overworld");
  } catch (e) {}
  return undefined;
}

function getBlock(dimension, location) {
  try {
    return dimension.getBlock(floorLoc(location));
  } catch (e) {}
  return undefined;
}

function setBlockType(dimension, location, typeId) {
  var block = getBlock(dimension, location);
  if (!block) return false;

  try {
    block.setType(typeId);
    return true;
  } catch (e) {}

  try {
    dimension.runCommand(
      "setblock "
      + Math.floor(location.x) + " "
      + Math.floor(location.y) + " "
      + Math.floor(location.z) + " "
      + typeId
    );
    return true;
  } catch (e2) {}

  return false;
}



function clearTeamAreaDroppedItems(dimension, area) {
  if (!dimension || !area) return;

  // Kill only item entities inside the full generated 7x7 x 6 clearing volume.
  // This catches drops caused by neighbor/support updates while terrain is
  // being replaced.
  try {
    dimension.runCommand(
      "kill @e[type=item,"
      + "x=" + (area.x - TEAM_AREA_RING_RADIUS) + ","
      + "y=" + (area.y + 1) + ","
      + "z=" + (area.z - TEAM_AREA_RING_RADIUS) + ","
      + "dx=" + (TEAM_AREA_RING_RADIUS * 2) + ","
      + "dy=5,"
      + "dz=" + (TEAM_AREA_RING_RADIUS * 2)
      + "]"
    );
  } catch (e) {}
}

function clearTeamAreaAboveFloor(dimension, area) {
  // Clear the full 7x7 ring area y+6 -> y+1, one plane at a time.
  //
  // Top-down is important: if a support block is removed first, flowers,
  // grass, torches, etc. above it can break naturally and create drops
  // before we get a chance to replace them with air.
  for (var dy = 6; dy >= 1; dy--) {
    for (
      var dx = -TEAM_AREA_RING_RADIUS;
      dx <= TEAM_AREA_RING_RADIUS;
      dx++
    ) {
      for (
        var dz = -TEAM_AREA_RING_RADIUS;
        dz <= TEAM_AREA_RING_RADIUS;
        dz++
      ) {
        var loc = {
          x: area.x + dx,
          y: area.y + dy,
          z: area.z + dz
        };

        var block = getBlock(dimension, loc);
        if (!block) continue;

        var typeId = "";
        try {
          typeId = String(block.typeId || "");
        } catch (e) {}

        if (!typeId || typeId === "minecraft:air") continue;

        // Direct replacement instead of player-style destruction.
        setBlockType(
          dimension,
          loc,
          "minecraft:air"
        );
      }
    }
  }

  // Neighbor updates can still create an item entity in edge cases.
  // Sweep immediately and once more on the next tick.
  clearTeamAreaDroppedItems(dimension, area);

  system.run(function () {
    clearTeamAreaDroppedItems(dimension, area);
  });

  system.runTimeout(function () {
    clearTeamAreaDroppedItems(dimension, area);
  }, 2);

  system.runTimeout(function () {
    clearTeamAreaDroppedItems(dimension, area);
  }, 4);
}

function teamAreaStateObject() {
  return {
    version: 3,
    dimensionId: teamAreaDimensionId,
    center: teamAreaCenter,
    areas: teamAreaAreas,
    restore: teamAreaRestore
  };
}

function saveState() {
  // The y..y+6 restore snapshot can be large, so persist it in chunks.
  // A single dynamic-property JSON blob is intentionally avoided.
  var saved = writeChunkedJson(
    TEAM_AREA_STATE_PREFIX,
    teamAreaStateObject()
  );

  // Remove the old single-property state only after the chunked save
  // actually completed.
  if (saved) {
    try {
      world.setDynamicProperty(TEAM_AREA_STATE_KEY, undefined);
    } catch (e) {}
  }

  return saved;
}

function clearSavedState() {
  clearChunkedJson(TEAM_AREA_STATE_PREFIX);

  // Also clear legacy v1 storage.
  try {
    world.setDynamicProperty(TEAM_AREA_STATE_KEY, undefined);
  } catch (e) {
    try {
      world.setDynamicProperty(TEAM_AREA_STATE_KEY, "");
    } catch (e2) {}
  }
}

function migrateTeamAreaState(parsed) {
  if (!parsed || typeof parsed !== "object") return undefined;

  return {
    version: 3,
    migratedFrom: Math.max(
      0,
      Math.floor(Number(parsed.version) || 1)
    ),
    dimensionId: String(parsed.dimensionId || "overworld"),
    center: parsed.center || undefined,
    areas: Array.isArray(parsed.areas) ? parsed.areas : [],
    restore: Array.isArray(parsed.restore) ? parsed.restore : []
  };
}

function applyLoadedTeamAreaState(parsed) {
  var migrated = migrateTeamAreaState(parsed);
  if (!migrated) return false;

  teamAreaDimensionId = String(migrated.dimensionId || "");
  teamAreaCenter = migrated.center || undefined;
  teamAreaAreas = migrated.areas;
  teamAreaRestore = migrated.restore;

  return teamAreaAreas.length > 0;
}

export function loadReusableTeamAreaState(force) {
  if (teamAreaStateLoaded && !force) {
    return teamAreaAreas.length > 0;
  }

  var parsed = undefined;
  var loadedLegacy = false;

  try {
    parsed = readChunkedJson(TEAM_AREA_STATE_PREFIX);
  } catch (eChunk) {
    // Do not mark as loaded if the world is not ready yet.
    return false;
  }

  // Migrate worlds that were saved by the old v1 implementation.
  if (!parsed) {
    try {
      var raw = world.getDynamicProperty(TEAM_AREA_STATE_KEY);
      if (typeof raw === "string" && raw.length > 0) {
        parsed = JSON.parse(raw);
        loadedLegacy = true;
      }
    } catch (eLegacy) {
      // Early-execution / world-not-ready:
      // leave teamAreaStateLoaded=false so a later tick can retry.
      return false;
    }
  }

  // This point is reached from normal world execution. Even if no saved
  // data exists, the load attempt itself completed successfully.
  teamAreaStateLoaded = true;

  try {
    if (!applyLoadedTeamAreaState(parsed)) {
      teamAreaDimensionId = "";
      teamAreaCenter = undefined;
      teamAreaAreas = [];
      teamAreaRestore = [];
      return false;
    }

    // Re-establish the ticking area after world/script reload.
    system.run(function () {
      var dimension = getDimension(
        teamAreaDimensionId || "overworld"
      );

      if (dimension && teamAreaAreas.length > 0) {
        registerTickingArea(dimension, teamAreaAreas);
      }

      if (
        loadedLegacy
        || Math.max(0, Math.floor(Number(parsed && parsed.version) || 0)) < 3
      ) {
        saveState();
      }
    });

    return true;
  } catch (e) {
    teamAreaDimensionId = "";
    teamAreaCenter = undefined;
    teamAreaAreas = [];
    teamAreaRestore = [];
    return false;
  }
}


function serializeBlock(block, location) {
  var loc = floorLoc(location);
  var typeId = "minecraft:air";
  var states = undefined;

  try {
    if (block) typeId = String(block.typeId || "minecraft:air");
  } catch (e) {}

  try {
    if (block && block.permutation && typeof block.permutation.getAllStates === "function") {
      states = block.permutation.getAllStates();
    }
  } catch (e2) {}

  return {
    x: loc.x,
    y: loc.y,
    z: loc.z,
    typeId: typeId,
    states: states
  };
}

function restorePermutation(record) {
  try {
    return BlockPermutation.resolve(record.typeId, record.states);
  } catch (e) {}
  try {
    return BlockPermutation.resolve(record.typeId);
  } catch (e2) {}
  return undefined;
}

function snapshotAreas(dimension, areas) {
  var records = [];
  var seen = {};

  for (var i = 0; i < areas.length; i++) {
    var area = areas[i];

    for (var dx = -TEAM_AREA_RING_RADIUS; dx <= TEAM_AREA_RING_RADIUS; dx++) {
      for (var dz = -TEAM_AREA_RING_RADIUS; dz <= TEAM_AREA_RING_RADIUS; dz++) {
        for (var dy = 0; dy <= 6; dy++) {
          var loc = {
            x: area.x + dx,
            y: area.y + dy,
            z: area.z + dz
          };
          var key = loc.x + "," + loc.y + "," + loc.z;
          if (seen[key]) continue;
          seen[key] = true;

          records.push(serializeBlock(getBlock(dimension, loc), loc));
        }
      }
    }
  }

  return records;
}

function layoutAreas(player, options) {
  var opts = options || {};
  var base = floorLoc(player.location);
  var center = {
    x: base.x,
    y: base.y - 1,
    z: base.z
  };
  var count = normalizedTeamAreaCount(opts.teamCount);
  var pattern = teamAreaPatternForCount(count);
  var areas = [];

  for (var i = 0; i < pattern.length; i++) {
    areas.push({
      color: TEAM_AREA_COLORS[i],
      x: center.x + pattern[i].dx,
      y: center.y,
      z: center.z + pattern[i].dz
    });
  }

  return {
    center: center,
    areas: areas,
    teamCount: count
  };
}

function buildArea(dimension, area) {
  var floorType = TEAM_AREA_BLOCK_IDS[area.color];
  if (!floorType) return;

  // Clear all blocks above the generated base so the team area is unobstructed.
  // Snapshot was already taken before buildArea(), so removal remains reversible.
  clearTeamAreaAboveFloor(dimension, area);

  for (var dx = -TEAM_AREA_FOOT_RADIUS; dx <= TEAM_AREA_FOOT_RADIUS; dx++) {
    for (var dz = -TEAM_AREA_FOOT_RADIUS; dz <= TEAM_AREA_FOOT_RADIUS; dz++) {
      setBlockType(dimension, {
        x: area.x + dx,
        y: area.y,
        z: area.z + dz
      }, floorType);
    }
  }

  for (var rx = -TEAM_AREA_RING_RADIUS; rx <= TEAM_AREA_RING_RADIUS; rx++) {
    for (var rz = -TEAM_AREA_RING_RADIUS; rz <= TEAM_AREA_RING_RADIUS; rz++) {
      if (Math.max(Math.abs(rx), Math.abs(rz)) !== TEAM_AREA_RING_RADIUS) continue;

      setBlockType(dimension, {
        x: area.x + rx,
        y: area.y,
        z: area.z + rz
      }, "minecraft:shroomlight");

      var corner = Math.abs(rx) === TEAM_AREA_RING_RADIUS
        && Math.abs(rz) === TEAM_AREA_RING_RADIUS;
      setBlockType(dimension, {
        x: area.x + rx,
        y: area.y + 1,
        z: area.z + rz
      }, corner ? floorType : "minecraft:smooth_stone_slab");
    }
  }
}

function registerTickingArea(dimension, areas) {
  if (!dimension || !areas.length) return;

  var minX = Infinity;
  var maxX = -Infinity;
  var minZ = Infinity;
  var maxZ = -Infinity;
  var y = areas[0].y;

  for (var i = 0; i < areas.length; i++) {
    minX = Math.min(minX, areas[i].x - TEAM_AREA_RING_RADIUS);
    maxX = Math.max(maxX, areas[i].x + TEAM_AREA_RING_RADIUS);
    minZ = Math.min(minZ, areas[i].z - TEAM_AREA_RING_RADIUS);
    maxZ = Math.max(maxZ, areas[i].z + TEAM_AREA_RING_RADIUS);
  }

  try {
    dimension.runCommand("tickingarea remove " + TEAM_AREA_TICKING_NAME);
  } catch (e) {}

  try {
    dimension.runCommand(
      "tickingarea add "
      + minX + " " + y + " " + minZ + " "
      + maxX + " " + y + " " + maxZ + " "
      + TEAM_AREA_TICKING_NAME
    );
  } catch (e2) {}
}

function removeTickingArea(dimensionId) {
  var dimension = getDimension(dimensionId || teamAreaDimensionId || "overworld");
  if (!dimension) return;

  try {
    dimension.runCommand("tickingarea remove " + TEAM_AREA_TICKING_NAME);
  } catch (e) {}
}

function areaColorAtLocation(location) {
  if (!location || teamAreaAreas.length <= 0) return "";

  var loc = floorLoc(location);
  for (var i = 0; i < teamAreaAreas.length; i++) {
    var area = teamAreaAreas[i];
    if (loc.y !== area.y + 1) continue;
    if (Math.abs(loc.x - area.x) > TEAM_AREA_FOOT_RADIUS) continue;
    if (Math.abs(loc.z - area.z) > TEAM_AREA_FOOT_RADIUS) continue;
    return area.color;
  }

  return "";
}

function playerAreaColor(player) {
  if (!player) return "";

  try {
    if (
      teamAreaDimensionId
      && player.dimension
      && String(player.dimension.id) !== String(teamAreaDimensionId)
    ) {
      return "";
    }
    return areaColorAtLocation(player.location);
  } catch (e) {}

  return "";
}

function tickPlayerTeamAreaColors() {
  loadReusableTeamAreaState();

  var players = allPlayers();
  for (var i = 0; i < players.length; i++) {
    var player = players[i];
    var key = playerKey(player);
    var color = playerAreaColor(player);
    var previous = teamAreaPlayerColor[key] || "";

    if (color === previous) continue;

    if (color) {
      teamAreaPlayerColor[key] = color;
      hudSetRatioTeamTag(player, color);
      // Team-selection feedback belongs directly above the hotbar.
      // Use Minecraft's native ActionBar instead of the addon's top HUD.
      setTeamSelectionActionBar(
        player,
        "§fあなたの色は "
        + (TEAM_AREA_COLORED_LABELS[color] || TEAM_AREA_LABELS[color])
      );

      try {
        if (typeof player.playSound === "function") {
          player.playSound("random.orb", { volume: 1, pitch: 1 });
        }
      } catch (eSound) {}
    } else {
      delete teamAreaPlayerColor[key];
      clearTeamSelectionActionBar(player);
    }
  }
}

function areaEdgeMidpoints(area) {
  var radius = TEAM_AREA_FOOT_RADIUS;
  return [
    { x: area.x + 0.5, z: area.z - radius, axis: "ns" },
    { x: area.x + 0.5, z: area.z + radius + 1, axis: "ns" },
    { x: area.x - radius, z: area.z + 0.5, axis: "ew" },
    { x: area.x + radius + 1, z: area.z + 0.5, axis: "ew" }
  ];
}

export function spawnReusableTeamAreaParticles() {
  loadReusableTeamAreaState();
  if (teamAreaAreas.length <= 0) return;

  var dimension = getDimension(teamAreaDimensionId || "overworld");
  if (!dimension) return;

  for (var i = 0; i < teamAreaAreas.length; i++) {
    var area = teamAreaAreas[i];
    var edges = areaEdgeMidpoints(area);
    for (var j = 0; j < edges.length; j++) {
      var edge = edges[j];
      var particleId = edge.axis === "ns"
        ? TEAM_AREA_PARTICLE_NS[area.color]
        : TEAM_AREA_PARTICLE_EW[area.color];
      if (!particleId) continue;

      try {
        dimension.spawnParticle(particleId, {
          x: edge.x,
          y: area.y + 1,
          z: edge.z
        });
      } catch (e) {}
    }
  }
}

export function startReusableTeamAreaWatchers(options) {
  var opts = options || {};
  var selectionInterval = Math.max(1, Math.floor(Number(opts.selectionIntervalTicks) || 1));
  var particleInterval = Math.max(1, Math.floor(Number(opts.particleIntervalTicks) || 60));

  stopReusableTeamAreaWatchers();

  teamAreaTickHandle = system.runInterval(tickPlayerTeamAreaColors, selectionInterval);
  teamAreaParticleHandle = system.runInterval(spawnReusableTeamAreaParticles, particleInterval);
  tickPlayerTeamAreaColors();
  spawnReusableTeamAreaParticles();
}

export function stopReusableTeamAreaWatchers() {
  if (teamAreaTickHandle !== undefined) {
    try {
      system.clearRun(teamAreaTickHandle);
    } catch (e) {}
    teamAreaTickHandle = undefined;
  }

  if (teamAreaParticleHandle !== undefined) {
    try {
      system.clearRun(teamAreaParticleHandle);
    } catch (e2) {}
    teamAreaParticleHandle = undefined;
  }
}

export function setupReusableTeamAreas(player, options) {
  loadReusableTeamAreaState();
  if (!player || !player.dimension) return false;

  // Never overwrite an existing persisted area. The normal toggle path
  // will remove it first; direct setup calls are guarded as well.
  if (teamAreaAreas.length > 0) {
    tell(
      player,
      "§e保存済みのチーム分けエリアがあります。先に削除してください。"
    );
    return false;
  }

  var dimension = player.dimension;
  var layout = layoutAreas(player, options);

  teamAreaDimensionId = String(dimension.id || "overworld");
  teamAreaCenter = layout.center;
  teamAreaAreas = layout.areas;
  teamAreaRestore = snapshotAreas(dimension, teamAreaAreas);

  // Persist the full restore snapshot BEFORE changing terrain.
  // If persistence fails, abort without touching the world.
  if (!saveState()) {
    teamAreaDimensionId = "";
    teamAreaCenter = undefined;
    teamAreaAreas = [];
    teamAreaRestore = [];
    teamAreaPlayerColor = {};

    tell(
      player,
      "§cチーム分けエリアの復元データを保存できなかったため、生成を中止しました。"
    );
    return false;
  }

  registerTickingArea(dimension, teamAreaAreas);

  for (var i = 0; i < teamAreaAreas.length; i++) {
    buildArea(dimension, teamAreaAreas[i]);
  }

  startReusableTeamAreaWatchers(options);
  tell(player, "§a" + layout.teamCount + "色のチーム分けエリアを作りました。");
  return true;
}

export function hasReusableTeamAreas() {
  loadReusableTeamAreaState();
  return teamAreaAreas.length > 0;
}

export function getReusableTeamAreaState() {
  loadReusableTeamAreaState();

  return {
    exists: teamAreaAreas.length > 0,
    loaded: !!teamAreaStateLoaded,
    dimensionId: String(teamAreaDimensionId || ""),
    center: teamAreaCenter
      ? {
          x: Number(teamAreaCenter.x) || 0,
          y: Number(teamAreaCenter.y) || 0,
          z: Number(teamAreaCenter.z) || 0
        }
      : undefined,
    areaCount: teamAreaAreas.length,
    colors: teamAreaAreas.map(function (area) {
      return String(area.color || "");
    }),
    restoreBlockCount: teamAreaRestore.length,
    persistenceSchema: 3
  };
}

export function removeReusableTeamAreas(options) {
  loadReusableTeamAreaState();

  var opts = options || {};
  var dimensionId = teamAreaDimensionId;
  var dimension = getDimension(dimensionId || "overworld");
  var restore = teamAreaRestore.slice();

  if (
    teamAreaAreas.length > 0
    && !dimension
  ) {
    // Keep in-memory and persisted restore data so removal can be retried.
    return false;
  }

  if (!opts.keepWatchers) stopReusableTeamAreaWatchers();

  if (dimension && teamAreaAreas.length > 0) {
    for (var areaIndex = 0; areaIndex < teamAreaAreas.length; areaIndex++) {
      var area = teamAreaAreas[areaIndex];
      for (var dx = -TEAM_AREA_RING_RADIUS; dx <= TEAM_AREA_RING_RADIUS; dx++) {
        for (var dz = -TEAM_AREA_RING_RADIUS; dz <= TEAM_AREA_RING_RADIUS; dz++) {
          for (var dy = 0; dy <= 6; dy++) {
            setBlockType(dimension, {
              x: area.x + dx,
              y: area.y + dy,
              z: area.z + dz
            }, "minecraft:air");
          }
        }
      }
    }

    for (var i = 0; i < restore.length; i++) {
      var record = restore[i];
      var block = getBlock(dimension, record);
      var permutation = restorePermutation(record);
      try {
        if (block && permutation) block.setPermutation(permutation);
      } catch (e) {
        setBlockType(dimension, record, record.typeId || "minecraft:air");
      }
    }
  }

  removeTickingArea(dimensionId);
  teamAreaDimensionId = "";
  teamAreaCenter = undefined;
  teamAreaAreas = [];
  teamAreaRestore = [];
  teamAreaPlayerColor = {};
  clearSavedState();

  var players = allPlayers();
  for (var p = 0; p < players.length; p++) {
    hudClearRatioTeamTags(players[p]);
    clearTeamSelectionActionBar(players[p]);
  }

  return true;
}

export function toggleReusableTeamAreas(player, options) {
  if (hasReusableTeamAreas()) {
    var removed = removeReusableTeamAreas();

    if (removed) {
      tell(player, "§eチーム分けエリアを消しました。");
    } else {
      tell(
        player,
        "§cチーム分けエリアを復元できませんでした。保存データは残しています。"
      );
    }

    return false;
  }

  return setupReusableTeamAreas(player, options);
}

function getTeamAreaToolEventPlayer(event) {
  try {
    if (event && event.source) return event.source;
  } catch (e) {}
  try {
    if (event && event.player) return event.player;
  } catch (e2) {}
  return undefined;
}

function getTeamAreaToolEventItem(event) {
  try {
    if (event && event.itemStack) return event.itemStack;
  } catch (e) {}
  try {
    if (event && event.item) return event.item;
  } catch (e2) {}
  return undefined;
}

function shouldHandleTeamAreaToolUse(player) {
  var key = playerKey(player);
  if (!key) return true;

  var tick = 0;
  try {
    tick = Number(system.currentTick) || 0;
  } catch (e) {}

  var hadPrevious =
    teamAreaToolLastUseTickByPlayer[key] !== undefined;
  var previousTick = Number(
    teamAreaToolLastUseTickByPlayer[key]
  );

  if (
    hadPrevious
    && isFinite(previousTick)
    && tick - previousTick < 12
  ) {
    return false;
  }

  teamAreaToolLastUseTickByPlayer[key] = tick;
  return true;
}

function handleTeamAreaToolUse(event, options) {
  var itemStack = getTeamAreaToolEventItem(event);
  var player = getTeamAreaToolEventPlayer(event);

  if (!itemStack || String(itemStack.typeId || "") !== HUD_TEAM_AREA_TOOL_ITEM) {
    return;
  }

  if (!shouldHandleTeamAreaToolUse(player)) return;

  system.run(function () {
    if (!teamAreaStateLoaded) {
      loadReusableTeamAreaState(true);
    }

    // The team-area tool item always represents the full team setup.
    // Keep it fixed at the addon's maximum of 8 teams regardless of
    // registration/default options.
    var toolOptions = {};
    var sourceOptions = options || {};

    for (var key in sourceOptions) {
      toolOptions[key] = sourceOptions[key];
    }

    toolOptions.teamCount = 8;

    toggleReusableTeamAreas(
      player,
      toolOptions
    );
  });
}

export function registerReusableTeamAreaTool(options) {
  if (teamAreaToolRegistered) return false;
  if (!world.afterEvents) return false;

  teamAreaToolRegistered = true;

  function deferredTeamAreaLoad() {
    system.run(function () {
      loadReusableTeamAreaState();

      if (teamAreaAreas.length > 0) {
        startReusableTeamAreaWatchers(options);
      }
    });
  }

  // Script modules can execute before world state APIs are ready.
  // worldLoad is the preferred point to restore persisted world state.
  try {
    if (world.afterEvents.worldLoad) {
      world.afterEvents.worldLoad.subscribe(function () {
        deferredTeamAreaLoad();
      });
    }
  } catch (eWorldLoad) {}

  // Fallback for versions/worlds where registration happens after worldLoad.
  system.run(function () {
    loadReusableTeamAreaState();

    if (teamAreaAreas.length > 0) {
      startReusableTeamAreaWatchers(options);
    }
  });

  // A player spawn is another safe retry point. This is especially useful
  // after /reload or unusual pack initialization ordering.
  try {
    if (world.afterEvents.playerSpawn) {
      world.afterEvents.playerSpawn.subscribe(function () {
        if (teamAreaStateLoaded) return;
        deferredTeamAreaLoad();
      });
    }
  } catch (eSpawn) {}

  if (world.afterEvents.itemUse) {
    world.afterEvents.itemUse.subscribe(function (event) {
      handleTeamAreaToolUse(event, options);
    });
  }

  if (world.afterEvents.itemStartUseOn) {
    world.afterEvents.itemStartUseOn.subscribe(function (event) {
      handleTeamAreaToolUse(event, options);
    });
  }

  // The custom tool has bow-style use modifiers, so air-use can begin via
  // itemStartUse. The 12-tick per-player debounce prevents the corresponding
  // completion/use event from toggling the area a second time.
  if (world.afterEvents.itemStartUse) {
    world.afterEvents.itemStartUse.subscribe(function (event) {
      handleTeamAreaToolUse(event, options);
    });
  }

  // Clean per-player runtime caches after disconnect.
  try {
    if (world.afterEvents.playerLeave) {
      world.afterEvents.playerLeave.subscribe(function (event) {
        var id = "";
        var name = "";

        try { id = String(event.playerId || ""); } catch (eId) {}
        try { name = String(event.playerName || ""); } catch (eName) {}

        if (id) {
          delete teamAreaToolLastUseTickByPlayer[id];
          delete teamAreaPlayerColor[id];
        }
        if (name) {
          delete teamAreaToolLastUseTickByPlayer[name];
          delete teamAreaPlayerColor[name];
        }
      });
    }
  } catch (eLeave) {}

  return true;
}
