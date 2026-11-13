import { world } from "@minecraft/server";

var openContainerTargetByPlayer = {};
var initialized = false;

function keyFor(player) {
  if (!player) return "";
  return String(player.id || player.name || "");
}

function isPlayer(entity) {
  try {
    return !!entity && entity.typeId === "minecraft:player";
  } catch (e) {}
  return false;
}

function sourcePlayer(event) {
  try {
    var entity = event && event.openSource && event.openSource.entity;
    if (isPlayer(entity)) return entity;
  } catch (e) {}
  return undefined;
}

function remember(player, target) {
  var key = keyFor(player);
  if (!key || !target) return;
  openContainerTargetByPlayer[key] = target;
}

function forget(player) {
  var key = keyFor(player);
  if (key) delete openContainerTargetByPlayer[key];
}

function safeSubscribe(signal, callback) {
  if (!signal || typeof signal.subscribe !== "function") return false;
  try {
    signal.subscribe(callback);
    return true;
  } catch (e) {}
  return false;
}

export function initializeReusableOpenContainerTracking() {
  if (initialized) return false;
  initialized = true;

  safeSubscribe(world.afterEvents.blockContainerOpened, function (event) {
    var player = sourcePlayer(event);
    if (player && event && event.block) remember(player, event.block);
  });

  safeSubscribe(world.afterEvents.blockContainerClosed, function (event) {
    var player = sourcePlayer(event);
    if (player) forget(player);
  });

  safeSubscribe(world.afterEvents.entityContainerOpened, function (event) {
    var player = sourcePlayer(event);
    if (player && event && event.entity) remember(player, event.entity);
  });

  safeSubscribe(world.afterEvents.entityContainerClosed, function (event) {
    var player = sourcePlayer(event);
    if (player) forget(player);
  });

  safeSubscribe(world.afterEvents.playerLeave, function (event) {
    try {
      delete openContainerTargetByPlayer[String(event.playerId || "")];
      delete openContainerTargetByPlayer[String(event.playerName || "")];
    } catch (e) {}
  });

  return true;
}

export function getReusableOpenContainer(player) {
  var target = openContainerTargetByPlayer[keyFor(player)];
  if (!target) return undefined;

  try {
    var inventory = target.getComponent("minecraft:inventory");
    var container = inventory && inventory.container;
    if (container && container.isValid) return container;
  } catch (e) {}

  return undefined;
}

export function clearReusableOpenContainer(player) {
  forget(player);
}
