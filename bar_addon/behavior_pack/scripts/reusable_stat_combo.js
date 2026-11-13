// Named stats: a formula over stats, created with /rt:stat.
//   /rt:stat A kills.zombie - killed_by.zombie
//   /rt:countup stat:A 20 ...
// Only the formulas are stored here (world dynamic property). The values are
// always calculated live from the player stats (see reusable_stat_expr.js).

import {
  canAccessWorldDynamicProperties,
  clearChunkedJson,
  readChunkedJson,
  writeChunkedJson
} from "./reusable_persistence.js";
import {
  cleanStatExpressionItems,
  describeStatExpression,
  itemsFromLegacyKeys,
  statExpressionKeys
} from "./reusable_stat_expr.js";

var COMBO_PERSISTENCE_PREFIX = "rt_stat_combo_v1";

var loaded = false;
var combos = {};

function has(name) {
  return Object.prototype.hasOwnProperty.call(combos, name);
}

function cleanItems(raw) {
  if (!Array.isArray(raw) || raw.length <= 0) return [];

  // Older format: a plain list of stat keys that were added up.
  if (typeof raw[0] === "string") {
    return itemsFromLegacyKeys(raw.filter(function (key) { return !!key; }));
  }

  return cleanStatExpressionItems(raw, 0);
}

function load() {
  if (loaded) return;
  if (!canAccessWorldDynamicProperties(COMBO_PERSISTENCE_PREFIX)) return;

  var saved;
  try {
    saved = readChunkedJson(COMBO_PERSISTENCE_PREFIX);
  } catch (e) {}

  combos = {};
  if (saved && typeof saved === "object") {
    for (var name in saved) {
      if (!Object.prototype.hasOwnProperty.call(saved, name)) continue;

      var items = cleanItems(saved[name]);
      if (items.length > 0) combos[name] = items;
    }
  }

  loaded = true;
}

function save() {
  try {
    if (Object.keys(combos).length <= 0) {
      clearChunkedJson(COMBO_PERSISTENCE_PREFIX);
      return true;
    }
    return writeChunkedJson(COMBO_PERSISTENCE_PREFIX, combos);
  } catch (e) {}
  return false;
}

function copyItems(items) {
  return JSON.parse(JSON.stringify(items));
}

// { name, items, keys }  keys = every stat the formula uses
export function getReusableStatCombo(name) {
  load();

  var id = String(name === undefined || name === null ? "" : name);
  if (!id || !has(id)) return undefined;

  var items = copyItems(combos[id]);
  return { name: id, items: items, keys: statExpressionKeys(items) };
}

export function listReusableStatCombos() {
  load();

  return Object.keys(combos).sort().map(function (name) {
    return { name: name, text: describeStatExpression(combos[name]) };
  });
}

export function setReusableStatCombo(name, items) {
  load();
  combos[String(name)] = copyItems(items);
  return save();
}

export function deleteReusableStatCombo(name) {
  load();

  var id = String(name === undefined || name === null ? "" : name);
  if (!has(id)) return false;

  delete combos[id];
  save();
  return true;
}
