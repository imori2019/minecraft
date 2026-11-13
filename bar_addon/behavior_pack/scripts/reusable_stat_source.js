import { system, world } from "@minecraft/server";
import {
  normalizeReusableStatKey,
  getReusableStoredStat
} from "./reusable_stat_store.js";
import { getReusableCurrentStat } from "./reusable_stat_current.js";
import { getReusableStatCombo } from "./reusable_stat_combo.js";
import { evaluateStatExpression } from "./reusable_stat_expr.js";

var ALIASES = {
  kills: "mob_kills",
  mobkills: "mob_kills",
  playerkills: "player_kills",
  hp: "health",
  xp: "xp.total",
  level: "xp.level",
  speed: "speed.blocks_per_second",
  weight: "inventory.weight",
  "inventory.total": "inventory.total_items",
  "inventory.count": "inventory.total_items",
  "held.durability": "held.durability_remaining",
  "held.max_durability": "held.durability_max",
  "container.total": "container.total_items",
  "target_container.total": "target_container.total_items",
  totem: "totem_pops"
};

var currentValueCacheTick = -1;
var currentValueCache = {};

function tickNow() {
  try { return Number(system.currentTick) || 0; }
  catch (e) { return 0; }
}

function rounded(value) {
  var number = Number(value);
  if (!isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function playerKey(player) {
  if (!player) return "";
  return String(player.id || player.name || "");
}

export function isReusableStatSource(source) {
  return String(source || "").trim().toLowerCase().slice(0, 5) === "stat:";
}

// ---------------------------------------------------------------------------
// One argument:  stat:<統計>.<対象>.<タグ>      (対象 and タグ are optional)
//
//   stat:mob_kills                 mob kills of everybody
//   stat:mob_kills.red             mob kills of the players tagged red
//   stat:kills.zombie              zombie kills of everybody
//   stat:kills.zombie.red          zombie kills of the players tagged red
//   stat:blocks_broken.stone.red   stone broken by the players tagged red
//
// 対象 is the mob / block / item (minecraft. is added automatically).
// タグ is "all" (everybody), a team color (red ... pink), "team", or any
// tag given with /tag. Leaving it out also means everybody.
// ---------------------------------------------------------------------------
var ID_FAMILIES = [
  "kills", "killed_by", "damage_dealt", "blocks_broken", "blocks_broken_with",
  "blocks_placed", "tools_broken", "items_used", "items_picked_up",
  "items_dropped", "containers_opened", "entity_containers_opened",
  "items_eaten", "shots", "projectile_hits", "blocks_interacted",
  "entities_interacted", "effects_gained"
];

// Keys that carry their own dotted tail; the whole text is the key.
var WHOLE_KEY_PREFIXES = [
  "kills_by_cause.", "deaths_by_cause.", "damage_dealt_by_cause.",
  "damage_taken_by_cause.", "healing_by_cause.", "dimension_changes.",
  "distance.dimension.", "emotes.", "inventory.", "hotbar.", "held.",
  "equipment.", "armor.", "container.", "target_container.", "item.",
  "state.", "nearby.", "effect."
];

var KNOWN_STAT_KEYS = [
  "player_kills", "mob_kills", "deaths", "items_dropped", "items_dropped_stacks",
  "items_picked_up", "items_picked_up_stacks", "damage_dealt", "hits_dealt",
  "max_single_hit", "damage_taken", "hits_taken", "max_damage_taken",
  "blocks_broken", "tools_broken", "blocks_placed", "items_used",
  "healing_total", "healing_events", "totem_pops", "dimension_changes",
  "emotes", "jumps", "sneak_presses", "joins", "respawns",
  "containers_opened", "entity_containers_opened",
  "play_time_ticks", "play_time_seconds", "play_time_minutes", "play_time_hours",
  "life_time_ticks", "life_time_seconds", "longest_life_ticks", "longest_life_seconds",
  "session_time_ticks", "session_time_seconds",
  "longest_session_ticks", "longest_session_seconds",
  "highest_xp_level", "highest_xp_total", "highest_y", "lowest_y", "max_speed_bps",
  "distance", "distance.horizontal", "distance.ascent", "distance.descent",
  "distance.gliding", "distance.sprinting", "distance.swimming", "distance.in_water",
  "health", "health_max", "health_percent", "selected_slot",
  "xp.total", "xp.level", "xp.at_current_level", "xp.needed_next_level",
  "position.x", "position.y", "position.z",
  "speed.blocks_per_second", "speed.horizontal_bps",
  "velocity.x", "velocity.y", "velocity.z",
  "light.level", "light.sky", "block.redstone_power",
  // v1.5.8
  "items_eaten", "shots", "projectile_hits", "projectile_block_hits",
  "target_hits", "target_power_total", "target_best_power", "target_bullseyes",
  "blocks_interacted", "entities_interacted", "effects_gained",
  "buttons_pressed", "levers_flipped", "pressure_plates_pressed",
  "kill_streak", "best_kill_streak",
  "time_sneaking_ticks", "time_sneaking_seconds",
  "time_sprinting_ticks", "time_sprinting_seconds",
  "time_swimming_ticks", "time_swimming_seconds",
  "time_gliding_ticks", "time_gliding_seconds",
  "time_in_water_ticks", "time_in_water_seconds",
  "time_flying_ticks", "time_flying_seconds",
  "time_sleeping_ticks", "time_sleeping_seconds",
  "time_in_air_ticks", "time_in_air_seconds",
  "hunger", "saturation", "exhaustion"
];

var TEAM_WORDS = [
  "red", "blue", "yellow", "green", "cyan", "purple", "orange", "pink", "team",
  "all"
];

// ---------------------------------------------------------------------------
// Stats that take their own arguments (v1.5.8). The arguments come first, and
// anything after them is the タグ, as with the other stats.
//
//   scoreboard.<objective>                 a scoreboard value
//   has_tag.<tag>                          1 when the player has the tag
//   in_area.<x1>.<y1>.<z1>.<x2>.<y2>.<z2>  1 inside the box (corners included)
//   distance_to.<x>.<y>.<z>                blocks to that point
//   holding.<item>                         1 while holding the item
//   wearing.<item>                         1 while wearing it (armor / offhand)
//
// Coordinates are whole numbers. m10 is the same as -10 (handy in /rt:stat
// formulas, where - means minus).
// Objective and tag names keep their capital letters.
// ---------------------------------------------------------------------------
var ARGUMENT_STATS = {
  scoreboard: { count: 1, kind: "name" },
  has_tag: { count: 1, kind: "name" },
  in_area: { count: 6, kind: "number" },
  distance_to: { count: 3, kind: "number" },
  holding: { count: 1, kind: "id" },
  wearing: { count: 1, kind: "id" }
};

function coordinateText(value) {
  var text = String(value).trim().toLowerCase();
  if (/^m\d+$/.test(text)) text = "-" + text.slice(1);
  if (!/^-?\d+$/.test(text)) return undefined;
  return String(Math.floor(Number(text)));
}

function parseArgumentStat(segs) {
  var head = String(segs[0]).trim().toLowerCase();
  var spec = ARGUMENT_STATS[head];
  if (!spec) return undefined;
  if (segs.length < 1 + spec.count) return { key: "", tag: "", error: "missing" };

  var args = [];
  for (var i = 1; i <= spec.count; i++) {
    var raw = segs[i];
    if (spec.kind === "number") {
      var number = coordinateText(raw);
      if (number === undefined) return { key: "", tag: "", error: "number" };
      args.push(number);
    } else if (spec.kind === "id") {
      var id = normalizeReusableStatKey(raw);
      if (id.indexOf(".") < 0) id = "minecraft." + id;
      args.push(id);
    } else {
      args.push(String(raw).trim());
    }
  }

  return { key: head + "." + args.join("."), tag: segs.slice(1 + spec.count).join(".") };
}

function isArgumentStatKey(key) {
  var head = String(key || "").split(".")[0];
  return !!ARGUMENT_STATS[head];
}

function scoreValue(player, objectiveName) {
  try {
    var objective = world.scoreboard.getObjective(objectiveName);
    if (!objective) return 0;
    var value = objective.getScore(player.scoreboardIdentity || player);
    return typeof value === "number" && isFinite(value) ? value : 0;
  } catch (e) {}
  return 0;
}

function argumentStatValue(player, key) {
  var parts = String(key).split(".");
  var head = parts[0];
  var rest = parts.slice(1);

  if (head === "scoreboard") return scoreValue(player, rest.join("."));

  if (head === "has_tag") {
    try { return player.hasTag(rest.join(".")) ? 1 : 0; } catch (e) {}
    return 0;
  }

  if (head === "in_area" || head === "distance_to") {
    var p;
    try { p = player.location; } catch (e2) {}
    if (!p) return 0;
    var n = rest.map(Number);

    if (head === "distance_to") {
      var dx = p.x - (n[0] + 0.5);
      var dy = p.y - n[1];
      var dz = p.z - (n[2] + 0.5);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    var bx = Math.floor(p.x);
    var by = Math.floor(p.y);
    var bz = Math.floor(p.z);
    return (
      bx >= Math.min(n[0], n[3]) && bx <= Math.max(n[0], n[3])
      && by >= Math.min(n[1], n[4]) && by <= Math.max(n[1], n[4])
      && bz >= Math.min(n[2], n[5]) && bz <= Math.max(n[2], n[5])
    ) ? 1 : 0;
  }

  if (head === "holding" || head === "wearing") {
    var wanted = rest.join(".");
    return getReusableCurrentStat(player, "item_check." + head + "." + wanted) ? 1 : 0;
  }

  return 0;
}

function resolveAlias(key) {
  return ALIASES[key] || key;
}

// Returns { key: "kills.minecraft.zombie", tag: "red" }.
function parseSingleStat(source) {
  var text = String(source === undefined || source === null ? "" : source).trim();
  if (text.toLowerCase().slice(0, 5) === "stat:") text = text.slice(5);

  var segs = [];
  var rawSegs = text.split(".");
  for (var i = 0; i < rawSegs.length; i++) {
    var seg = rawSegs[i].trim();
    if (seg) segs.push(seg);
  }

  if (segs.length <= 0) return { key: "", tag: "" };

  var argStat = parseArgumentStat(segs);
  if (argStat) return argStat;

  var head = normalizeReusableStatKey(segs[0]);

  // 1) 統計.対象(.タグ)  where 対象 is a mob / block / item
  if (ID_FAMILIES.indexOf(head) >= 0) {
    var rest = segs.slice(1);

    if (rest.length === 0) return { key: resolveAlias(head), tag: "" };

    // kills.red -> all mob kills of the red team
    if (rest.length === 1 && TEAM_WORDS.indexOf(rest[0].toLowerCase()) >= 0) {
      return { key: resolveAlias(head), tag: rest[0] };
    }

    var id;
    var tagParts;
    if (rest[0].toLowerCase() === "minecraft" && rest.length >= 2) {
      id = "minecraft." + rest[1];
      tagParts = rest.slice(2);
    } else {
      id = rest[0];
      tagParts = rest.slice(1);
    }

    id = normalizeReusableStatKey(id);
    if (id.indexOf(".") < 0) id = "minecraft." + id;

    return { key: head + "." + id, tag: tagParts.join(".") };
  }

  // 2) keys with their own dotted tail: the whole text is the key
  var whole = normalizeReusableStatKey(text);
  for (var w = 0; w < WHOLE_KEY_PREFIXES.length; w++) {
    if (whole.slice(0, WHOLE_KEY_PREFIXES[w].length) === WHOLE_KEY_PREFIXES[w]) {
      return { key: resolveAlias(whole), tag: "" };
    }
  }

  // 3) a known key (longest match); whatever follows is the タグ
  for (var k = segs.length; k >= 1; k--) {
    var candidate = resolveAlias(normalizeReusableStatKey(segs.slice(0, k).join(".")));
    if (KNOWN_STAT_KEYS.indexOf(candidate) >= 0) {
      return { key: candidate, tag: segs.slice(k).join(".") };
    }
  }

  // 4) anything else: same as before, the whole text is the key
  return { key: resolveAlias(whole), tag: "" };
}

function statTextSegments(source) {
  var text = String(source === undefined || source === null ? "" : source).trim();
  if (text.toLowerCase().slice(0, 5) === "stat:") text = text.slice(5);

  var segs = [];
  var raw = text.split(".");
  for (var i = 0; i < raw.length; i++) {
    var seg = raw[i].trim();
    if (seg) segs.push(seg);
  }
  return segs;
}

// Returns { key, keys, tag, items }. For a named stat created with /rt:stat,
// keys lists every stat it uses and items is its formula.
export function parseReusableStatSource(source) {
  var segs = statTextSegments(source);

  if (segs.length > 0) {
    var combo = getReusableStatCombo(segs[0]);
    if (combo) {
      return {
        key: combo.keys[0],
        keys: combo.keys,
        items: combo.items,
        tag: segs.slice(1).join(".")
      };
    }
  }

  var one = parseSingleStat(source);
  return { key: one.key, keys: [one.key], items: undefined, tag: one.tag };
}

export function reusableStatKeyFromSource(source) {
  return parseReusableStatSource(source).key;
}

// ---------------------------------------------------------------------------
// /rt:stat helpers
// ---------------------------------------------------------------------------
function statKeyIsKnown(key) {
  if (KNOWN_STAT_KEYS.indexOf(key) >= 0) return true;
  if (isArgumentStatKey(key)) return true;

  for (var i = 0; i < ID_FAMILIES.length; i++) {
    if (key.slice(0, ID_FAMILIES[i].length + 1) === ID_FAMILIES[i] + ".") return true;
  }
  for (var w = 0; w < WHOLE_KEY_PREFIXES.length; w++) {
    if (key.slice(0, WHOLE_KEY_PREFIXES[w].length) === WHOLE_KEY_PREFIXES[w]) return true;
  }
  return false;
}

// Names that already mean something as the first part of stat:...
function builtInStatHeads() {
  var heads = ["list", "delete"].concat(TEAM_WORDS, ID_FAMILIES, Object.keys(ARGUMENT_STATS));

  for (var i = 0; i < KNOWN_STAT_KEYS.length; i++) {
    heads.push(KNOWN_STAT_KEYS[i].split(".")[0]);
  }
  for (var w = 0; w < WHOLE_KEY_PREFIXES.length; w++) {
    heads.push(WHOLE_KEY_PREFIXES[w].replace(/\.$/, ""));
  }
  for (var alias in ALIASES) {
    if (Object.prototype.hasOwnProperty.call(ALIASES, alias)) {
      heads.push(alias.split(".")[0]);
    }
  }
  return heads;
}

// Returns "" when the name can be used, otherwise a short reason.
export function reusableStatComboNameError(name) {
  var text = String(name === undefined || name === null ? "" : name).trim();

  if (!text) return "Name is empty";
  if (text.length > 24) return "Name is too long (24 characters at most)";
  if (/[\s.:+,=@\/\\"']/.test(text)) {
    return "Name cannot contain spaces or . : + , = @ / \\ quotes";
  }
  if (builtInStatHeads().indexOf(text.toLowerCase()) >= 0) {
    return "'" + text + "' cannot be used (reserved word or built-in stat name). Choose another name";
  }
  return "";
}

// Checks one member of a named stat. Returns { ok, key, error }.
export function reusableStatComboMember(spec) {
  var segs = statTextSegments(spec);
  if (segs.length <= 0) return { ok: false, key: "", error: "Stat is empty" };

  if (getReusableStatCombo(segs[0])) {
    return {
      ok: false,
      key: "",
      error: "'" + segs[0] + "' is a named stat. Put built-in stats here"
    };
  }

  var one = parseSingleStat(spec);
  if (one.tag) {
    return {
      ok: false,
      key: "",
      error: "No tag here ('" + String(spec) + "'). Add the tag when you use it: stat:name.tag"
    };
  }
  if (!one.key || !statKeyIsKnown(one.key)) {
    return { ok: false, key: "", error: "Unknown stat '" + String(spec) + "'" };
  }

  return { ok: true, key: one.key, error: "" };
}

// Time stats in seconds / minutes / hours are worked out from the stored
// tick count, so resetting them means resetting that tick count.
//   key -> [stored tick stat, ticks per unit]
var DERIVED_FROM_TICKS = {
  play_time_seconds: ["play_time_ticks", 20],
  play_time_minutes: ["play_time_ticks", 1200],
  play_time_hours: ["play_time_ticks", 72000],
  life_time_seconds: ["life_time_ticks", 20],
  longest_life_seconds: ["longest_life_ticks", 20],
  session_time_seconds: ["session_time_ticks", 20],
  longest_session_seconds: ["longest_session_ticks", 20],
  time_sneaking_seconds: ["time_sneaking_ticks", 20],
  time_sprinting_seconds: ["time_sprinting_ticks", 20],
  time_swimming_seconds: ["time_swimming_ticks", 20],
  time_gliding_seconds: ["time_gliding_ticks", 20],
  time_in_water_seconds: ["time_in_water_ticks", 20],
  time_flying_seconds: ["time_flying_ticks", 20],
  time_sleeping_seconds: ["time_sleeping_ticks", 20],
  time_in_air_seconds: ["time_in_air_ticks", 20]
};

// The stored stat that holds the value of `key` (the key itself for most).
export function reusableStatStoredKey(key) {
  var derived = DERIVED_FROM_TICKS[key];
  return derived ? derived[0] : key;
}

// Stats that must start again together with `key` on /rt:play.
// A best streak can only restart if the running streak restarts too.
var RESET_TOGETHER = {
  best_kill_streak: ["kill_streak"]
};

// Every stored stat to set to 0 when `key` is reset.
export function reusableStatResetKeys(key) {
  if (isArgumentStatKey(key)) return [];
  return [reusableStatStoredKey(key)].concat(RESET_TOGETHER[key] || []);
}

function derivedStoredValue(player, key) {
  var derived = DERIVED_FROM_TICKS[key];
  if (!derived) return undefined;
  return getReusableStoredStat(player, derived[0], 0) / derived[1];
}

function cachedCurrentValue(player, key) {
  var tick = tickNow();
  if (tick !== currentValueCacheTick) {
    currentValueCacheTick = tick;
    currentValueCache = {};
  }

  var cacheKey = playerKey(player) + "|" + key;
  if (Object.prototype.hasOwnProperty.call(currentValueCache, cacheKey)) {
    return currentValueCache[cacheKey];
  }

  var value = getReusableCurrentStat(player, key);
  currentValueCache[cacheKey] = value;
  return value;
}

// `key` must already be resolved (e.g. "kills.mypack.giant"). Parsing it a
// second time would read the namespace of an add-on mob as the mob and the
// rest as a tag ("kills.minecraft.mypack" + tag "giant").
function resolvedStatValue(player, key) {
  if (isArgumentStatKey(key)) return rounded(argumentStatValue(player, key));

  var current = cachedCurrentValue(player, key);
  if (current !== undefined) return rounded(current);

  var derived = derivedStoredValue(player, key);
  if (derived !== undefined) return rounded(derived);

  return rounded(getReusableStoredStat(player, key, 0));
}

export function getReusableStatValue(player, rawKey) {
  return resolvedStatValue(player, reusableStatKeyFromSource(rawKey));
}

export function getReusableStatSourceValue(player, source) {
  if (!isReusableStatSource(source)) return undefined;

  var parsed = parseReusableStatSource(source);

  if (parsed.items) {
    return rounded(evaluateStatExpression(parsed.items, function (key) {
      return resolvedStatValue(player, key);
    }));
  }

  return rounded(Number(resolvedStatValue(player, parsed.key)) || 0);
}

export function reusableSourceLabel(source) {
  if (!isReusableStatSource(source)) return String(source || "");
  return reusableStatKeyFromSource(source);
}
