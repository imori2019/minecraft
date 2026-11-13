// Timer family.
//
// This module owns every timer-driven HUD path and re-exports the timer engine.
// Source-driven /rt:countup and /rt:countdown never enter this module's
// progress-bar compatibility path.

import {
  setReusableHudOverlayText,
  setReusableHudTimerLabel,
  setReusableHudTimerToken,
  showReusableTimeBar,
  showReusableTimeTimer
} from "../reusable_hud_display.js";
import { barTimer } from "../reusable_timer.js";

export { barTimer };

// Options for the bar token: the caller's options plus the bar style.
function withStyle(options, config) {
  var out = {};
  var source = options || {};
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  out.style = (config && config.barStyle) || "";
  return out;
}

export function updateTimerHud(players, config, options) {
  var cfg = config || {};
  var opts = options || {};
  var list = players || [];
  var timerState = barTimer.getState();

  var totalTicks = Math.max(1, timerState.totalTicks);
  var elapsedTicks = Math.max(0, timerState.elapsedTicks);
  var remainingTicks = Math.max(0, timerState.remainingTicks);

  for (var i = 0; i < list.length; i++) {
    // Standalone /rt:timer owns both the timer digits and the progress bar.
    // The bar is full at the configured start time and shrinks to zero.
    showReusableTimeBar(
      list[i],
      "countdown",
      {
        elapsedTicks: elapsedTicks,
        remainingTicks: remainingTicks,
        totalTicks: totalTicks
      },
      withStyle(opts, cfg)
    );

    var digitsHiddenTitle = "";

    if (cfg.timerVisible === false) {
      setReusableHudTimerToken(list[i], "", false);
      setReusableHudTimerLabel(list[i], "", false);
    } else if (cfg.timerDigitsVisible === false) {
      // Digits off: no timer panel (label lives inside it), so show the
      // label as a bar title through the same path counters use.
      setReusableHudTimerToken(list[i], "", false);
      setReusableHudTimerLabel(list[i], "", false);
      // cfg.timerLabel already carries its own bold formatting.
      digitsHiddenTitle = String(cfg.timerLabel || "");
    } else {
      showReusableTimeTimer(
        list[i],
        "countdown",
        {
          elapsedTicks: elapsedTicks,
          remainingTicks: remainingTicks,
          totalTicks: totalTicks
        },
        opts
      );
      setReusableHudTimerLabel(
        list[i],
        cfg.timerLabel,
        !!opts.force
      );
    }

    setReusableHudOverlayText(list[i], digitsHiddenTitle, false);
  }

  return timerState;
}

// Compatibility path for the old timer-driven countupbar/countdownbar commands.
// It lives in timer.js on purpose so normal counters remain timer-free.
export function updateLegacyTimedProgressHud(
  players,
  config,
  barTiming,
  timerTiming,
  options
) {
  var cfg = config || {};
  var opts = options || {};
  var list = players || [];
  var barDirection = String(cfg.mode || "") === "time_countup"
    ? "countup"
    : "countdown";
  var timerDirection = String(cfg.timerDirection || "down") === "up"
    ? "countup"
    : "countdown";

  for (var i = 0; i < list.length; i++) {
    showReusableTimeBar(
      list[i],
      barDirection,
      barTiming,
      withStyle(opts, cfg)
    );

    var digitsHiddenTitle = "";

    if (cfg.timerVisible === false) {
      setReusableHudTimerToken(list[i], "", false);
      setReusableHudTimerLabel(list[i], "", false);
    } else if (cfg.timerDigitsVisible === false) {
      // Digits off: no timer panel (label lives inside it), so show the
      // label as a bar title through the same path counters use.
      setReusableHudTimerToken(list[i], "", false);
      setReusableHudTimerLabel(list[i], "", false);
      // cfg.timerLabel already carries its own bold formatting.
      digitsHiddenTitle = String(cfg.timerLabel || "");
    } else {
      showReusableTimeTimer(
        list[i],
        timerDirection,
        timerTiming,
        opts
      );
      setReusableHudTimerLabel(
        list[i],
        cfg.timerLabel,
        !!opts.force
      );
    }

    setReusableHudOverlayText(list[i], digitsHiddenTitle, false);
  }

  return {
    kind: "timer",
    compatibilityProgress: true
  };
}
