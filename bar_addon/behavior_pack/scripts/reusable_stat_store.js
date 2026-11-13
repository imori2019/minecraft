import { system, world } from "@minecraft/server";

const STAT_PREFIX = "rtstat:";

// ---------------------------------------------------------------------------
// Write-back cache.
// Stats change many times a second (movement, time, hits). Reading and
// writing a player dynamic property for every change is slow, so values are
// kept in memory and written in one go every few seconds, and when a player
// leaves. At most the last few seconds can be lost if the game crashes.
// ---------------------------------------------------------------------------
var FLUSH_TICKS = 100;

var statCache = {};          // player id -> { player, values: {prop: number|undefined}, dirty: {prop: true} }
var flushStarted = false;

function cacheEntry(player) {
  var id = "";
  try {
    id = String(player.id);
  } catch (e) {}
  if (!id) return undefined;

  var entry = statCache[id];
  if (!entry) {
    entry = { player: player, values: {}, dirty: {} };
    statCache[id] = entry;
  } else {
    entry.player = player;
  }
  return entry;
}

function readStoredNumber(player, prop) {
  try {
    var value = player.getDynamicProperty(prop);
    if (typeof value === "number" && isFinite(value)) return value;
  } catch (e) {}
  return undefined;
}

function cachedValue(player, prop) {
  var entry = cacheEntry(player);
  if (!entry) return readStoredNumber(player, prop);

  if (!Object.prototype.hasOwnProperty.call(entry.values, prop)) {
    entry.values[prop] = readStoredNumber(player, prop);
  }
  return entry.values[prop];
}

function flushEntry(id) {
  var entry = statCache[id];
  if (!entry) return;

  for (var prop in entry.dirty) {
    if (!Object.prototype.hasOwnProperty.call(entry.dirty, prop)) continue;
    try {
      entry.player.setDynamicProperty(prop, entry.values[prop]);
    } catch (e) {}
  }
  entry.dirty = {};
}

// Writes every changed stat now. flushReusableStats(player) writes only one player.
export function flushReusableStats(player) {
  if (player) {
    var id = "";
    try {
      id = String(player.id);
    } catch (e) {}
    if (id) flushEntry(id);
    return;
  }

  for (var key in statCache) {
    if (Object.prototype.hasOwnProperty.call(statCache, key)) flushEntry(key);
  }
}

function startFlushing() {
  if (flushStarted) return;
  flushStarted = true;

  try {
    system.runInterval(function () {
      flushReusableStats();

      // Forget players that are gone (their values were just written).
      for (var id in statCache) {
        if (!Object.prototype.hasOwnProperty.call(statCache, id)) continue;
        var valid = false;
        try {
          valid = statCache[id].player.isValid !== false;
        } catch (e) {}
        if (!valid) delete statCache[id];
      }
    }, FLUSH_TICKS);
  } catch (e) {}

  try {
    world.beforeEvents.playerLeave.subscribe(function (event) {
      try {
        var id = String(event.player.id);
        flushEntry(id);
        delete statCache[id];
      } catch (e2) {}
    });
  } catch (e3) {}

  try {
    system.beforeEvents.shutdown.subscribe(function () {
      flushReusableStats();
    });
  } catch (e4) {}
}

export function normalizeReusableStatKey(value) {
  var key = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();

  if (key.slice(0, 5) === "stat:") key = key.slice(5);

  return key
    .replace(/:/g, ".")
    .replace(/\s+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function propertyId(key) {
  return STAT_PREFIX + normalizeReusableStatKey(key);
}

export function getReusableStoredStat(player, key, fallback) {
  var fallbackValue = fallback === undefined ? 0 : Number(fallback) || 0;
  if (!player) return fallbackValue;

  var value = cachedValue(player, propertyId(key));
  return value === undefined ? fallbackValue : value;
}

export function hasReusableStoredStat(player, key) {
  if (!player) return false;
  return cachedValue(player, propertyId(key)) !== undefined;
}

export function setReusableStoredStat(player, key, value) {
  if (!player) return 0;

  var number = Number(value);
  if (!isFinite(number)) return getReusableStoredStat(player, key, 0);

  var prop = propertyId(key);
  var entry = cacheEntry(player);

  if (!entry) {
    try {
      player.setDynamicProperty(prop, number);
      return number;
    } catch (e) {}
    return getReusableStoredStat(player, key, 0);
  }

  if (entry.values[prop] !== number) {
    entry.values[prop] = number;
    entry.dirty[prop] = true;
    startFlushing();
  }
  return number;
}

export function addReusableStoredStat(player, key, amount) {
  var delta = amount === undefined ? 1 : Number(amount);
  if (!isFinite(delta)) return getReusableStoredStat(player, key, 0);

  return setReusableStoredStat(
    player,
    key,
    getReusableStoredStat(player, key, 0) + delta
  );
}

export function maxReusableStoredStat(player, key, value) {
  var number = Number(value);
  if (!player || !isFinite(number)) return 0;

  if (!hasReusableStoredStat(player, key)) {
    return setReusableStoredStat(player, key, number);
  }

  var current = getReusableStoredStat(player, key, number);
  if (number > current) return setReusableStoredStat(player, key, number);
  return current;
}

export function minReusableStoredStat(player, key, value) {
  var number = Number(value);
  if (!player || !isFinite(number)) return 0;

  if (!hasReusableStoredStat(player, key)) {
    return setReusableStoredStat(player, key, number);
  }

  var current = getReusableStoredStat(player, key, number);
  if (number < current) return setReusableStoredStat(player, key, number);
  return current;
}

export function listReusableStoredStats(player) {
  if (!player) return [];

  // Make sure the latest values are on the player before listing them.
  flushReusableStats(player);

  var ids = [];
  try {
    ids = player.getDynamicPropertyIds();
  } catch (e) {
    return [];
  }

  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i] || "");
    if (id.slice(0, STAT_PREFIX.length) !== STAT_PREFIX) continue;

    try {
      var value = player.getDynamicProperty(id);
      if (typeof value !== "number" || !isFinite(value)) continue;
      rows.push({
        key: id.slice(STAT_PREFIX.length),
        value: value
      });
    } catch (e2) {}
  }

  rows.sort(function (a, b) {
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  });
  return rows;
}
