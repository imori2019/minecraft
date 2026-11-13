import {
  world,
  system,
  ButtonState,
  InputButton
} from "@minecraft/server";

import {
  normalizeReusableStatKey,
  getReusableStoredStat,
  setReusableStoredStat,
  addReusableStoredStat,
  maxReusableStoredStat,
  minReusableStoredStat
} from "./reusable_stat_store.js";

import {
  initializeReusableOpenContainerTracking,
  clearReusableOpenContainer
} from "./reusable_open_container.js";

var initialized = false;
var previousPositionByPlayer = {};

function isPlayer(entity) {
  try {
    return !!entity && entity.typeId === "minecraft:player";
  } catch (e) {}
  return false;
}

function key(value) {
  return normalizeReusableStatKey(value || "unknown");
}

function damagingPlayer(source) {
  try {
    if (isPlayer(source && source.damagingEntity)) {
      return source.damagingEntity;
    }
  } catch (e) {}

  try {
    var projectile = source && source.damagingProjectile;
    var projectileComponent = projectile
      && projectile.getComponent("minecraft:projectile");
    var owner = projectileComponent && projectileComponent.owner;
    if (isPlayer(owner)) return owner;
  } catch (e2) {}

  return undefined;
}

function causeKey(source) {
  try {
    return key(source && source.cause);
  } catch (e) {}
  return "unknown";
}

function safeSubscribe(signal, callback) {
  if (!signal || typeof signal.subscribe !== "function") return false;
  try {
    signal.subscribe(callback);
    return true;
  } catch (e) {}
  return false;
}

function addPickedUpStacks(player, stacks) {
  var list = Array.isArray(stacks) ? stacks : [];
  var total = 0;

  for (var i = 0; i < list.length; i++) {
    var stack = list[i];
    if (!stack) continue;

    var amount = Math.max(0, Number(stack.amount) || 0);
    total += amount;

    try {
      addReusableStoredStat(
        player,
        "items_picked_up." + key(stack.typeId),
        amount
      );
    } catch (e) {}
  }

  addReusableStoredStat(player, "items_picked_up", total);
  addReusableStoredStat(player, "items_picked_up_stacks", list.length);
}

function droppedStack(entity) {
  try {
    var component = entity && entity.getComponent("minecraft:item");
    return component && component.itemStack;
  } catch (e) {}
  return undefined;
}

function addDroppedItems(player, entities) {
  var list = Array.isArray(entities) ? entities : [];
  var total = 0;
  var stackCount = 0;

  for (var i = 0; i < list.length; i++) {
    var stack = droppedStack(list[i]);
    if (!stack) continue;

    var amount = Math.max(0, Number(stack.amount) || 0);
    total += amount;
    stackCount++;

    addReusableStoredStat(
      player,
      "items_dropped." + key(stack.typeId),
      amount
    );
  }

  addReusableStoredStat(player, "items_dropped", total);
  addReusableStoredStat(player, "items_dropped_stacks", stackCount);
}

function brokenTool(event) {
  var before;
  var after;

  try {
    before = event.itemStackBeforeBreak;
    after = event.itemStackAfterBreak;
  } catch (e) {}

  if (!before || after) return undefined;

  try {
    if (before.getComponent("minecraft:durability")) return before;
  } catch (e2) {}

  return undefined;
}

function initializeEvents() {
  safeSubscribe(world.afterEvents.entityDie, function (event) {
    var dead = event && event.deadEntity;
    var source = event && event.damageSource;
    var killer = damagingPlayer(source);
    var cause = causeKey(source);

    if (killer && dead && killer.id !== dead.id) {
      if (isPlayer(dead)) {
        addReusableStoredStat(killer, "player_kills", 1);
      } else {
        addReusableStoredStat(killer, "mob_kills", 1);
        addReusableStoredStat(killer, "kills." + key(dead.typeId), 1);
      }
      addReusableStoredStat(killer, "kills_by_cause." + cause, 1);
    }

    if (isPlayer(dead)) {
      addReusableStoredStat(dead, "deaths", 1);
      addReusableStoredStat(dead, "deaths_by_cause." + cause, 1);

      try {
        var attacker = source && source.damagingEntity;
        if (attacker) {
          addReusableStoredStat(
            dead,
            "killed_by." + key(attacker.typeId),
            1
          );
        }
      } catch (e) {}

      setReusableStoredStat(dead, "life_time_ticks", 0);
      clearReusableOpenContainer(dead);
    }
  });

  safeSubscribe(world.afterEvents.entityHurt, function (event) {
    var amount = Math.max(0, Number(event && event.damage) || 0);
    var hurt = event && event.hurtEntity;
    var source = event && event.damageSource;
    var attacker = damagingPlayer(source);
    var cause = causeKey(source);

    if (attacker && hurt && attacker.id !== hurt.id) {
      addReusableStoredStat(attacker, "damage_dealt", amount);
      addReusableStoredStat(
        attacker,
        "damage_dealt." + key(hurt.typeId),
        amount
      );
      addReusableStoredStat(
        attacker,
        "damage_dealt_by_cause." + cause,
        amount
      );
      addReusableStoredStat(attacker, "hits_dealt", 1);
      maxReusableStoredStat(attacker, "max_single_hit", amount);
    }

    if (isPlayer(hurt)) {
      addReusableStoredStat(hurt, "damage_taken", amount);
      addReusableStoredStat(
        hurt,
        "damage_taken_by_cause." + cause,
        amount
      );
      addReusableStoredStat(hurt, "hits_taken", 1);
      maxReusableStoredStat(hurt, "max_damage_taken", amount);
    }
  });

  safeSubscribe(world.afterEvents.playerBreakBlock, function (event) {
    var player = event.player;
    var blockId = "unknown";
    var toolId = "";

    try { blockId = event.brokenBlockPermutation.type.id; } catch (e) {}
    try {
      toolId = event.itemStackBeforeBreak
        && event.itemStackBeforeBreak.typeId;
    } catch (e2) {}

    addReusableStoredStat(player, "blocks_broken", 1);
    addReusableStoredStat(player, "blocks_broken." + key(blockId), 1);

    if (toolId) {
      addReusableStoredStat(
        player,
        "blocks_broken_with." + key(toolId),
        1
      );
    }

    var tool = brokenTool(event);
    if (tool) {
      addReusableStoredStat(player, "tools_broken", 1);
      addReusableStoredStat(
        player,
        "tools_broken." + key(tool.typeId),
        1
      );
    }
  });

  safeSubscribe(world.afterEvents.playerPlaceBlock, function (event) {
    var blockId = "unknown";
    try { blockId = event.block.typeId; } catch (e) {}

    addReusableStoredStat(event.player, "blocks_placed", 1);
    addReusableStoredStat(
      event.player,
      "blocks_placed." + key(blockId),
      1
    );
  });

  safeSubscribe(world.afterEvents.itemUse, function (event) {
    var player = event && event.source;
    if (!isPlayer(player)) return;

    var itemId = "unknown";
    try { itemId = event.itemStack.typeId; } catch (e) {}

    addReusableStoredStat(player, "items_used", 1);
    addReusableStoredStat(
      player,
      "items_used." + key(itemId),
      1
    );
  });

  safeSubscribe(world.afterEvents.entityItemPickup, function (event) {
    var player = event && event.entity;
    if (!isPlayer(player)) return;
    addPickedUpStacks(player, event.items);
  });

  safeSubscribe(world.afterEvents.entityItemDrop, function (event) {
    var player = event && event.entity;
    if (!isPlayer(player)) return;
    addDroppedItems(player, event.items);
  });

  safeSubscribe(world.afterEvents.entityHeal, function (event) {
    var player = event && event.healedEntity;
    if (!isPlayer(player)) return;

    var amount = Math.max(0, Number(event.healing) || 0);
    var healCause = "unknown";
    try {
      healCause = key(event.healSource && event.healSource.cause);
    } catch (e) {}

    addReusableStoredStat(player, "healing_total", amount);
    addReusableStoredStat(player, "healing_events", 1);
    addReusableStoredStat(
      player,
      "healing_by_cause." + healCause,
      amount
    );

    if (healCause === "totemofundying") {
      addReusableStoredStat(player, "totem_pops", 1);
    }
  });

  safeSubscribe(world.afterEvents.playerDimensionChange, function (event) {
    var player = event && event.player;
    if (!player) return;

    addReusableStoredStat(player, "dimension_changes", 1);

    try {
      addReusableStoredStat(
        player,
        "dimension_changes.to." + key(event.toDimension.id),
        1
      );
      addReusableStoredStat(
        player,
        "dimension_changes.from." + key(event.fromDimension.id),
        1
      );
    } catch (e) {}

    try {
      var location = event.toLocation;
      previousPositionByPlayer[player.id] = {
        x: location.x,
        y: location.y,
        z: location.z,
        dimension: event.toDimension.id
      };
    } catch (e2) {}
  });

  safeSubscribe(world.afterEvents.playerEmote, function (event) {
    var player = event && event.player;
    if (!player) return;

    addReusableStoredStat(player, "emotes", 1);

    try {
      if (event.personaPieceId) {
        addReusableStoredStat(
          player,
          "emotes." + key(event.personaPieceId),
          1
        );
      }
    } catch (e) {}
  });

  safeSubscribe(world.afterEvents.playerButtonInput, function (event) {
    try {
      if (
        event.button === InputButton.Jump
        && event.newButtonState === ButtonState.Pressed
      ) {
        addReusableStoredStat(event.player, "jumps", 1);
      }

      if (
        event.button === InputButton.Sneak
        && event.newButtonState === ButtonState.Pressed
      ) {
        addReusableStoredStat(event.player, "sneak_presses", 1);
      }
    } catch (e) {}
  });

  safeSubscribe(world.afterEvents.playerSpawn, function (event) {
    var player = event && event.player;
    if (!player) return;

    if (event.initialSpawn) {
      addReusableStoredStat(player, "joins", 1);
      setReusableStoredStat(player, "session_time_ticks", 0);
    } else {
      addReusableStoredStat(player, "respawns", 1);
    }

    try {
      var p = player.location;
      previousPositionByPlayer[player.id] = {
        x: p.x,
        y: p.y,
        z: p.z,
        dimension: player.dimension.id
      };
    } catch (e) {}
  });

  safeSubscribe(world.afterEvents.blockContainerOpened, function (event) {
    var player;
    try {
      player = event.openSource && event.openSource.entity;
    } catch (e) {}
    if (!isPlayer(player)) return;

    addReusableStoredStat(player, "containers_opened", 1);

    try {
      addReusableStoredStat(
        player,
        "containers_opened." + key(event.block.typeId),
        1
      );
    } catch (e2) {}
  });

  safeSubscribe(world.afterEvents.entityContainerOpened, function (event) {
    var player;
    try {
      player = event.openSource && event.openSource.entity;
    } catch (e) {}
    if (!isPlayer(player)) return;

    addReusableStoredStat(player, "entity_containers_opened", 1);

    try {
      addReusableStoredStat(
        player,
        "entity_containers_opened." + key(event.entity.typeId),
        1
      );
    } catch (e2) {}
  });
}

function sampleTimeAndRecords(player, ticks) {
  addReusableStoredStat(player, "play_time_ticks", ticks);
  addReusableStoredStat(player, "life_time_ticks", ticks);
  addReusableStoredStat(player, "session_time_ticks", ticks);

  maxReusableStoredStat(
    player,
    "longest_life_ticks",
    getReusableStoredStat(player, "life_time_ticks", 0)
  );

  maxReusableStoredStat(
    player,
    "longest_session_ticks",
    getReusableStoredStat(player, "session_time_ticks", 0)
  );

  try {
    var xp = player.getTotalXp();
    maxReusableStoredStat(player, "highest_xp_total", xp);
    maxReusableStoredStat(player, "highest_xp_level", player.level);
  } catch (e) {}

  try {
    var p = player.location;
    maxReusableStoredStat(player, "highest_y", p.y);
    minReusableStoredStat(player, "lowest_y", p.y);
  } catch (e2) {}
}

function sampleMovement(player) {
  var now;
  var dimensionId;

  try {
    now = player.location;
    dimensionId = player.dimension.id;
  } catch (e) {
    return;
  }

  var previous = previousPositionByPlayer[player.id];
  previousPositionByPlayer[player.id] = {
    x: now.x,
    y: now.y,
    z: now.z,
    dimension: dimensionId
  };

  if (!previous || previous.dimension !== dimensionId) return;

  var dx = now.x - previous.x;
  var dy = now.y - previous.y;
  var dz = now.z - previous.z;
  var distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Prevent obvious teleport-like jumps from inflating distance stats.
  if (!isFinite(distance) || distance > 64) return;

  var horizontal = Math.sqrt(dx * dx + dz * dz);

  addReusableStoredStat(player, "distance", distance);
  addReusableStoredStat(player, "distance.horizontal", horizontal);
  addReusableStoredStat(
    player,
    "distance.dimension." + key(dimensionId),
    distance
  );

  if (dy > 0) addReusableStoredStat(player, "distance.ascent", dy);
  if (dy < 0) addReusableStoredStat(player, "distance.descent", -dy);

  try {
    if (player.isGliding) {
      addReusableStoredStat(player, "distance.gliding", distance);
    }
    if (player.isSprinting) {
      addReusableStoredStat(player, "distance.sprinting", distance);
    }
    if (player.isSwimming) {
      addReusableStoredStat(player, "distance.swimming", distance);
    }
    if (player.isInWater) {
      addReusableStoredStat(player, "distance.in_water", distance);
    }
  } catch (e2) {}

  try {
    var velocity = player.getVelocity();
    var speed = Math.sqrt(
      velocity.x * velocity.x
      + velocity.y * velocity.y
      + velocity.z * velocity.z
    ) * 20;
    maxReusableStoredStat(player, "max_speed_bps", speed);
  } catch (e3) {}
}

export function initializeReusableStats() {
  if (initialized) return false;
  initialized = true;

  initializeReusableOpenContainerTracking();
  initializeEvents();

  system.runInterval(function () {
    var players = [];
    try { players = world.getPlayers(); } catch (e) {}

    for (var i = 0; i < players.length; i++) {
      try { sampleTimeAndRecords(players[i], 20); } catch (e2) {}
    }
  }, 20);

  system.runInterval(function () {
    var players = [];
    try { players = world.getPlayers(); } catch (e) {}

    for (var i = 0; i < players.length; i++) {
      try { sampleMovement(players[i]); } catch (e2) {}
    }
  }, 10);

  return true;
}
