import { EquipmentSlot } from "@minecraft/server";
import { normalizeReusableStatKey } from "./reusable_stat_store.js";
import { getReusableOpenContainer } from "./reusable_open_container.js";

function safeNumber(fn, fallback) {
  var fb = fallback === undefined ? 0 : Number(fallback) || 0;
  try {
    var value = Number(fn());
    return isFinite(value) ? value : fb;
  } catch (e) {}
  return fb;
}

function playerInventory(player) {
  try {
    var component = player.getComponent("minecraft:inventory");
    var container = component && component.container;
    if (container && container.isValid) return container;
  } catch (e) {}
  return undefined;
}

function heldItem(player) {
  var container = playerInventory(player);
  if (!container) return undefined;
  try {
    return container.getItem(player.selectedSlotIndex);
  } catch (e) {}
  return undefined;
}

function durability(item) {
  var out = { damage: 0, max: 0, remaining: 0, percent: 0 };
  if (!item) return out;

  try {
    var component = item.getComponent("minecraft:durability");
    if (!component) return out;

    out.damage = Math.max(0, Number(component.damage) || 0);
    out.max = Math.max(0, Number(component.maxDurability) || 0);
    out.remaining = Math.max(0, out.max - out.damage);
    out.percent = out.max > 0 ? (out.remaining / out.max) * 100 : 0;
  } catch (e) {}

  return out;
}

function containerSummary(container) {
  var out = {
    present: 0,
    total_items: 0,
    used_slots: 0,
    empty_slots: 0,
    size: 0,
    unique_types: 0,
    full_stacks: 0,
    largest_stack: 0,
    fill_percent: 0,
    weight: 0,
    counts: {}
  };

  if (!container) return out;

  try {
    if (!container.isValid) return out;
  } catch (e) {
    return out;
  }

  out.present = 1;
  out.size = safeNumber(function () { return container.size; }, 0);
  out.empty_slots = safeNumber(function () { return container.emptySlotsCount; }, 0);
  out.weight = safeNumber(function () { return container.weight; }, 0);

  for (var i = 0; i < out.size; i++) {
    var item;
    try { item = container.getItem(i); } catch (e2) {}
    if (!item) continue;

    var amount = Math.max(0, Number(item.amount) || 0);
    out.total_items += amount;
    out.used_slots++;
    out.largest_stack = Math.max(out.largest_stack, amount);

    try {
      if (amount >= Number(item.maxAmount || 0)) out.full_stacks++;
    } catch (e3) {}

    var itemId = normalizeReusableStatKey(item.typeId || "unknown");
    out.counts[itemId] = (out.counts[itemId] || 0) + amount;
  }

  out.unique_types = Object.keys(out.counts).length;
  out.fill_percent = out.size > 0 ? (out.used_slots / out.size) * 100 : 0;
  return out;
}

function containerValue(summary, key) {
  if (!summary) return undefined;

  var direct = {
    present: summary.present,
    total_items: summary.total_items,
    used_slots: summary.used_slots,
    empty_slots: summary.empty_slots,
    size: summary.size,
    unique_types: summary.unique_types,
    full_stacks: summary.full_stacks,
    largest_stack: summary.largest_stack,
    fill_percent: summary.fill_percent,
    weight: summary.weight
  };

  if (direct[key] !== undefined) return direct[key];

  if (key.slice(0, 5) === "item." && key.slice(-6) === ".count") {
    var itemId = key.slice(5, -6);
    // item.diamond.count means minecraft:diamond, like everywhere else.
    if (itemId.indexOf(".") < 0) itemId = "minecraft." + itemId;
    return summary.counts[itemId] || 0;
  }

  return undefined;
}

function heldContainer(item) {
  if (!item) return undefined;
  try {
    var component = item.getComponent("minecraft:inventory");
    var container = component && component.container;
    if (container && container.isValid) return container;
  } catch (e) {}
  return undefined;
}

function targetContainer(player) {
  try {
    var hit = player.getBlockFromViewDirection({ maxDistance: 6 });
    var block = hit && hit.block;
    if (!block) return undefined;

    var component = block.getComponent("minecraft:inventory");
    var container = component && component.container;
    if (container && container.isValid) return container;
  } catch (e) {}
  return undefined;
}

function equipmentItem(player, slotName) {
  var equippable;
  try {
    equippable = player.getComponent("minecraft:equippable");
  } catch (e) {}
  if (!equippable) return undefined;

  var slots = {
    head: EquipmentSlot.Head,
    chest: EquipmentSlot.Chest,
    legs: EquipmentSlot.Legs,
    feet: EquipmentSlot.Feet,
    offhand: EquipmentSlot.Offhand
  };

  if (slots[slotName] === undefined) return undefined;

  try {
    return equippable.getEquipment(slots[slotName]);
  } catch (e2) {}
  return undefined;
}

function equipmentValue(player, key) {
  var parts = key.split(".");
  if (parts.length < 2) return undefined;

  var item = equipmentItem(player, parts[0]);
  var field = parts.slice(1).join(".");
  var d = durability(item);

  if (field === "count") return item ? Number(item.amount) || 0 : 0;
  if (field === "weight") {
    return item ? safeNumber(function () { return item.weight; }, 0) : 0;
  }
  if (field === "durability_damage") return d.damage;
  if (field === "durability_max") return d.max;
  if (field === "durability_remaining") return d.remaining;
  if (field === "durability_percent") return d.percent;
  return undefined;
}

// "speed.level" / "minecraft.speed.seconds"
function effectValue(player, rest) {
  var parts = rest.split(".");
  if (parts.length < 2) return undefined;

  var field = parts[parts.length - 1];
  if (field !== "level" && field !== "seconds") return undefined;

  var name = parts.slice(0, -1).join(".");
  if (name.slice(0, 10) === "minecraft.") name = name.slice(10);

  var effect;
  try {
    effect = player.getEffect(name);
  } catch (e) {}
  if (!effect) return 0;

  if (field === "level") {
    return safeNumber(function () { return effect.amplifier; }, 0) + 1;
  }
  return safeNumber(function () { return effect.duration; }, 0) / 20;
}

function armorValue(player, field) {
  var equippable;
  try {
    equippable = player.getComponent("minecraft:equippable");
  } catch (e) {}
  if (!equippable) return 0;

  if (field === "points") {
    return safeNumber(function () { return equippable.totalArmor; }, 0);
  }
  if (field === "toughness") {
    return safeNumber(function () { return equippable.totalToughness; }, 0);
  }

  var names = ["head", "chest", "legs", "feet"];
  var remaining = 0;
  var maximum = 0;
  var equipped = 0;

  for (var i = 0; i < names.length; i++) {
    var item = equipmentItem(player, names[i]);
    if (!item) continue;

    equipped++;
    var d = durability(item);
    remaining += d.remaining;
    maximum += d.max;
  }

  if (field === "equipped_slots") return equipped;
  if (field === "durability_remaining") return remaining;
  if (field === "durability_max") return maximum;
  if (field === "durability_percent") {
    return maximum > 0 ? (remaining / maximum) * 100 : 0;
  }

  return undefined;
}

function nearbyValue(player, key) {
  var parts = key.split(".");
  if (parts.length < 2) return undefined;

  var radius = Number(parts[parts.length - 1]);
  if (!isFinite(radius)) return undefined;
  radius = Math.max(1, Math.min(128, radius));

  var entities = [];
  try {
    entities = player.dimension.getEntities({
      location: player.location,
      maxDistance: radius
    });
  } catch (e) {
    return 0;
  }

  if (parts[0] === "entities") {
    var count = 0;
    for (var i = 0; i < entities.length; i++) {
      try {
        if (entities[i].id !== player.id) count++;
      } catch (e2) {}
    }
    return count;
  }

  if (parts[0] === "players") {
    var playerCount = 0;
    for (var p = 0; p < entities.length; p++) {
      try {
        if (
          entities[p].id !== player.id
          && entities[p].typeId === "minecraft:player"
        ) {
          playerCount++;
        }
      } catch (e3) {}
    }
    return playerCount;
  }

  if (parts[0] === "entity" && parts.length >= 4) {
    var requestedType = parts.slice(1, -1).join(".");
    var typeCount = 0;

    for (var t = 0; t < entities.length; t++) {
      try {
        if (normalizeReusableStatKey(entities[t].typeId) === requestedType) {
          typeCount++;
        }
      } catch (e4) {}
    }
    return typeCount;
  }

  return undefined;
}

function feetBlock(player) {
  try {
    var p = player.location;
    return player.dimension.getBlock({
      x: Math.floor(p.x),
      y: Math.floor(p.y),
      z: Math.floor(p.z)
    });
  } catch (e) {}
  return undefined;
}

export function getReusableCurrentStat(player, rawKey) {
  if (!player) return undefined;

  var key = normalizeReusableStatKey(rawKey);

  if (key.slice(0, 10) === "inventory.") {
    return containerValue(
      containerSummary(playerInventory(player)),
      key.slice(10)
    );
  }

  if (key.slice(0, 7) === "hotbar.") {
    var inventory = playerInventory(player);
    if (!inventory) return 0;

    var summary = {
      present: 1,
      total_items: 0,
      used_slots: 0,
      empty_slots: 9,
      size: 9,
      unique_types: 0,
      full_stacks: 0,
      largest_stack: 0,
      fill_percent: 0,
      weight: 0,
      counts: {}
    };

    for (var h = 0; h < 9; h++) {
      var stack;
      try { stack = inventory.getItem(h); } catch (e) {}
      if (!stack) continue;

      var amount = Math.max(0, Number(stack.amount) || 0);
      summary.total_items += amount;
      summary.used_slots++;
      summary.empty_slots--;
      summary.largest_stack = Math.max(summary.largest_stack, amount);
      summary.weight += safeNumber(function () { return stack.weight; }, 0);

      try {
        if (amount >= Number(stack.maxAmount || 0)) summary.full_stacks++;
      } catch (e2) {}

      var stackId = normalizeReusableStatKey(stack.typeId);
      summary.counts[stackId] = (summary.counts[stackId] || 0) + amount;
    }

    summary.unique_types = Object.keys(summary.counts).length;
    summary.fill_percent = (summary.used_slots / 9) * 100;

    return containerValue(summary, key.slice(7));
  }

  if (key.slice(0, 5) === "held.") {
    var held = heldItem(player);
    var heldKey = key.slice(5);

    if (heldKey.slice(0, 10) === "container.") {
      return containerValue(
        containerSummary(heldContainer(held)),
        heldKey.slice(10)
      );
    }

    var d = durability(held);
    if (heldKey === "count") return held ? Number(held.amount) || 0 : 0;
    if (heldKey === "max_stack") return held ? Number(held.maxAmount) || 0 : 0;
    if (heldKey === "weight") {
      return held ? safeNumber(function () { return held.weight; }, 0) : 0;
    }
    if (heldKey === "durability_damage") return d.damage;
    if (heldKey === "durability_max") return d.max;
    if (heldKey === "durability_remaining") return d.remaining;
    if (heldKey === "durability_percent") return d.percent;
  }

  if (key.slice(0, 10) === "container.") {
    return containerValue(
      containerSummary(getReusableOpenContainer(player)),
      key.slice(10)
    );
  }

  if (key.slice(0, 17) === "target_container.") {
    return containerValue(
      containerSummary(targetContainer(player)),
      key.slice(17)
    );
  }

  if (key.slice(0, 10) === "equipment.") {
    return equipmentValue(player, key.slice(10));
  }

  if (key.slice(0, 6) === "armor.") {
    return armorValue(player, key.slice(6));
  }

  // v1.5.8: item_check.holding.<item> / item_check.wearing.<item> (1 or 0)
  if (key.slice(0, 11) === "item_check.") {
    var checkParts = key.slice(11).split(".");
    var where = checkParts[0];
    var wantedId = checkParts.slice(1).join(".");
    var slotsToCheck = where === "holding"
      ? ["mainhand"]
      : ["head", "chest", "legs", "feet", "offhand"];

    for (var c = 0; c < slotsToCheck.length; c++) {
      var checked = slotsToCheck[c] === "mainhand"
        ? heldItem(player)
        : equipmentItem(player, slotsToCheck[c]);
      try {
        if (checked && normalizeReusableStatKey(checked.typeId) === wantedId) return 1;
      } catch (eCheck) {}
    }
    return 0;
  }

  // v1.5.8: hunger bar (0-20), saturation, exhaustion
  if (key === "hunger" || key === "saturation" || key === "exhaustion") {
    var attribute;
    try {
      attribute = player.getComponent("minecraft:player." + key);
    } catch (eAttr) {}
    return attribute
      ? safeNumber(function () { return attribute.currentValue; }, 0)
      : 0;
  }

  // v1.5.8: effect.<name>.level (0 = none, 1 = level I ...), effect.<name>.seconds
  if (key.slice(0, 7) === "effect.") {
    return effectValue(player, key.slice(7));
  }

  if (key === "selected_slot") {
    return safeNumber(function () { return player.selectedSlotIndex; }, 0);
  }

  if (key === "health" || key === "health_max" || key === "health_percent") {
    var health;
    try {
      health = player.getComponent("minecraft:health");
    } catch (e3) {}

    var current = health
      ? safeNumber(function () { return health.currentValue; }, 0)
      : 0;
    var maximum = health
      ? safeNumber(function () { return health.effectiveMax; }, 0)
      : 0;

    if (key === "health") return current;
    if (key === "health_max") return maximum;
    return maximum > 0 ? (current / maximum) * 100 : 0;
  }

  if (key === "xp.total") {
    return safeNumber(function () { return player.getTotalXp(); }, 0);
  }
  if (key === "xp.level") {
    return safeNumber(function () { return player.level; }, 0);
  }
  if (key === "xp.at_current_level") {
    return safeNumber(function () { return player.xpEarnedAtCurrentLevel; }, 0);
  }
  if (key === "xp.needed_next_level") {
    return safeNumber(function () { return player.totalXpNeededForNextLevel; }, 0);
  }

  if (key === "position.x") return safeNumber(function () { return player.location.x; }, 0);
  if (key === "position.y") return safeNumber(function () { return player.location.y; }, 0);
  if (key === "position.z") return safeNumber(function () { return player.location.z; }, 0);

  if (
    key === "speed.blocks_per_second"
    || key === "speed.horizontal_bps"
    || key === "velocity.x"
    || key === "velocity.y"
    || key === "velocity.z"
  ) {
    var velocity;
    try { velocity = player.getVelocity(); }
    catch (e4) { velocity = { x: 0, y: 0, z: 0 }; }

    if (key === "velocity.x") return Number(velocity.x) || 0;
    if (key === "velocity.y") return Number(velocity.y) || 0;
    if (key === "velocity.z") return Number(velocity.z) || 0;

    if (key === "speed.horizontal_bps") {
      return Math.sqrt(
        velocity.x * velocity.x + velocity.z * velocity.z
      ) * 20;
    }

    return Math.sqrt(
      velocity.x * velocity.x
      + velocity.y * velocity.y
      + velocity.z * velocity.z
    ) * 20;
  }

  if (key.slice(0, 6) === "state.") {
    var stateName = key.slice(6);
    var map = {
      sneaking: "isSneaking",
      sprinting: "isSprinting",
      swimming: "isSwimming",
      gliding: "isGliding",
      flying: "isFlying",
      on_ground: "isOnGround",
      in_water: "isInWater",
      falling: "isFalling",
      climbing: "isClimbing",
      sleeping: "isSleeping",
      jumping: "isJumping"
    };

    // v1.5.8: states that are components, not properties
    if (stateName === "on_fire" || stateName === "riding") {
      try {
        return player.getComponent(
          stateName === "on_fire" ? "minecraft:onfire" : "minecraft:riding"
        ) ? 1 : 0;
      } catch (eComp) {}
      return 0;
    }

    var propertyName = map[stateName];
    if (!propertyName) return undefined;

    try { return player[propertyName] ? 1 : 0; }
    catch (e5) { return 0; }
  }

  if (key.slice(0, 7) === "nearby.") {
    return nearbyValue(player, key.slice(7));
  }

  if (
    key === "light.level"
    || key === "light.sky"
    || key === "block.redstone_power"
  ) {
    var block = feetBlock(player);
    if (!block) return 0;

    if (key === "light.level") {
      try {
        return typeof block.getLightLevel === "function"
          ? safeNumber(function () { return block.getLightLevel(); }, 0)
          : 0;
      } catch (e6) {}
      return 0;
    }

    if (key === "light.sky") {
      try {
        return typeof block.getSkyLightLevel === "function"
          ? safeNumber(function () { return block.getSkyLightLevel(); }, 0)
          : 0;
      } catch (e7) {}
      return 0;
    }

    try {
      var power = block.getRedstonePower();
      return power === undefined ? 0 : Number(power) || 0;
    } catch (e8) {}
    return 0;
  }

  return undefined;
}
