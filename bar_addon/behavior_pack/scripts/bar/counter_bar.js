// Counter bar family.
//
// /rt:countup and /rt:countdown are value-driven counters only.
// Their bar width always comes from the configured score/stat source.
//
// Optional display above the bar:
//   count -> title + logical count
//   d60   -> title + independent clock, 60 -> 0
//   a60   -> title + independent clock, 0 -> 60
//   none  -> title only
//
// d/a clocks are display-only. They never drive the counter bar and never use
// the timer bar's red/yellow/blue progress-color logic.

import { system } from "@minecraft/server";
import {
  showReusableCounterHud
} from "../reusable_hud_display.js";
import {
  counterDirection,
  objectiveTotal
} from "./bar_common.js";

function counterElapsedSeconds(config) {
  var cfg = config || {};
  var elapsedTicks = Math.max(
    0,
    Math.floor(Number(cfg.pausedTicks) || 0)
  );

  if (cfg.running) {
    var now = 0;
    try {
      now = system.currentTick;
    } catch (e) {}

    elapsedTicks += Math.max(
      0,
      Number(now) - Math.floor(Number(cfg.startedTick) || 0)
    );
  }

  return Math.max(0, Math.floor(elapsedTicks / 20));
}

function counterDisplaySpec(value) {
  var text = String(value || "").trim().toLowerCase();

  if (text === "count") {
    return {
      mode: "count",
      direction: "",
      seconds: 0
    };
  }

  if (text === "none") {
    return {
      mode: "none",
      direction: "",
      seconds: 0
    };
  }

  var match = /^([da])(\d+)$/.exec(text);
  if (!match) {
    return {
      mode: "none",
      direction: "",
      seconds: 0
    };
  }

  var seconds = Math.max(
    1,
    Math.min(5999, Math.floor(Number(match[2]) || 1))
  );

  return {
    mode: "timer",
    direction: match[1] === "d" ? "down" : "up",
    seconds: seconds
  };
}

export function updateCounterBar(players, config, options) {
  var cfg = config || {};
  var opts = options || {};
  var list = players || [];
  var aggregatePlayers = Array.isArray(opts.aggregatePlayers)
    ? opts.aggregatePlayers
    : list;
  var maxValue = Math.max(1, Number(cfg.maxValue) || 1);
  var rawCurrent = objectiveTotal(
    aggregatePlayers,
    cfg.source,
    opts.onlyTeamMembers
  );

  // Before /rt:play the configured source is ignored so the visual always
  // starts deterministically:
  //   countup   -> 0%
  //   countdown -> 100%
  //
  // /rt:play resets the actual source to 0. Once running, the bar therefore
  // reflects the source directly: 0, 1, 2, 3...
  var logicalCurrent;
  if (cfg.running) {
    logicalCurrent = Math.max(0, Number(rawCurrent) || 0);
  } else if (cfg.counterBaselineReady) {
    // A counter that has already run is frozen while stopped. Do not fall
    // back to its pre-play 0 state merely because a player joins/leaves or
    // the world reloads and triggers a HUD resync.
    logicalCurrent = Math.max(
      0,
      Number(cfg.counterLastCurrent) || 0
    );
  } else {
    logicalCurrent = 0;
  }

  var current = Math.max(
    0,
    Math.min(maxValue, logicalCurrent)
  );

  if (cfg.running) {
    cfg.counterLastCurrent = current;
  }
  var direction = counterDirection(cfg.mode);
  var remaining = Math.max(0, maxValue - current);
  var displayValue = direction === "down"
    ? remaining
    : current;

  var displaySpec = counterDisplaySpec(cfg.counterDisplay);
  var elapsedSeconds = counterElapsedSeconds(cfg);
  var clockSeconds = elapsedSeconds;

  if (displaySpec.mode === "timer") {
    if (displaySpec.direction === "down") {
      clockSeconds = Math.max(
        0,
        displaySpec.seconds - elapsedSeconds
      );
    } else {
      clockSeconds = Math.min(
        displaySpec.seconds,
        elapsedSeconds
      );
    }
  }

  for (var i = 0; i < list.length; i++) {
    var hudOptions = {};
    for (var key in opts) hudOptions[key] = opts[key];
    hudOptions.title = String(cfg.counterTitle || "");
    hudOptions.displayMode = displaySpec.mode;
    hudOptions.elapsedSeconds = clockSeconds;
    hudOptions.color = String(cfg.counterColor || "blue");

    showReusableCounterHud(
      list[i],
      direction,
      cfg.source,
      displayValue,
      current,
      maxValue,
      hudOptions
    );
  }

  return {
    kind: "counter",
    direction: direction,
    rawCurrent: Number(rawCurrent) || 0,
    baseline: 0,
    baselineReady: !!cfg.running,
    current: current,
    remaining: remaining,
    displayValue: displayValue,
    max: maxValue,
    title: String(cfg.counterTitle || ""),
    displayMode: displaySpec.mode,
    clockDirection: displaySpec.direction,
    clockLimitSeconds: displaySpec.seconds,
    elapsedSeconds: elapsedSeconds,
    clockSeconds: clockSeconds,
    color: String(cfg.counterColor || "blue")
  };
}
