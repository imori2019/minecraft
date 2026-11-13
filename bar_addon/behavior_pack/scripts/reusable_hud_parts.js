// Reusable HUD token builders for the bar addon.
// These functions only build strings. Send the returned token with title/subtitle
// HUD code that is compatible with the same resource-pack JSON UI bindings.

export var HUD_BAR_INNER_WIDTH = 180;
export var HUD_BAR_QUANTUM = 1;

export var HUD_COUNTDOWN_RED_RATIO = 0.2;
export var HUD_COUNTDOWN_YELLOW_RATIO = 0.5;

export var HUD_XPBAR_COLOR_RED = 1;
export var HUD_XPBAR_COLOR_YELLOW = 6;
export var HUD_XPBAR_COLOR_BLUE = 19;

export var HUD_TIME_MODE_COUNTDOWN = "countdown";
export var HUD_TIME_MODE_COUNTUP = "countup";
export var HUD_TIME_MODE_TIMER = "timer";

export function hudClamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function hudPad3(value, innerWidth, quantum) {
  var width = Math.max(
    0,
    Math.min(
      innerWidth === undefined ? HUD_BAR_INNER_WIDTH : innerWidth,
      Math.round(Number(value) || 0)
    )
  );
  var step = Math.max(1, Math.round(Number(quantum) || HUD_BAR_QUANTUM));
  width = Math.round(width / step) * step;
  width = Math.max(
    0,
    Math.min(
      innerWidth === undefined ? HUD_BAR_INNER_WIDTH : innerWidth,
      width
    )
  );

  var text = String(width);
  while (text.length < 3) text = "0" + text;
  return text;
}

export var HUD_RATIO_TEAM_MAX = 8;
export var HUD_RATIO_TEAM_NAMES = [
  "red",
  "blue",
  "yellow",
  "green",
  "cyan",
  "purple",
  "orange",
  "pink"
];
export var HUD_RATIO_TEAM_TOKEN_PREFIXES = [
  "qr",
  "qb",
  "qy",
  "qg",
  "qc",
  "qp",
  "qo",
  "qk"
];

export function hudRatioUnitWidths(values, innerWidth) {
  var widthMax = innerWidth === undefined ? HUD_BAR_INNER_WIDTH : innerWidth;
  var active = (values || []).slice(0, HUD_RATIO_TEAM_MAX);
  while (active.length < 1) active.push(0);

  var total = 0;
  for (var i = 0; i < active.length; i++) {
    active[i] = Math.max(0, Math.round(Number(active[i]) || 0));
    total += active[i];
  }

  var widths = [];
  if (total <= 0) {
    var equal = widthMax / active.length;
    var usedEqual = 0;
    for (var e = 0; e < active.length; e++) {
      var wEqual = e === active.length - 1
        ? widthMax - usedEqual
        : Math.floor(equal);
      widths.push(wEqual);
      usedEqual += wEqual;
    }
  } else {
    var raw = [];
    var used = 0;

    for (var r = 0; r < active.length; r++) {
      raw[r] = (active[r] / total) * widthMax;
      widths[r] = Math.floor(raw[r]);
      used += widths[r];
    }

    // Largest remainder distribution keeps the final bar exactly 180px.
    var remaining = widthMax - used;
    var order = [];
    for (var o = 0; o < active.length; o++) {
      order.push({
        index: o,
        frac: raw[o] - Math.floor(raw[o]),
        value: active[o]
      });
    }

    order.sort(function (a, b) {
      if (b.frac !== a.frac) return b.frac - a.frac;
      if (b.value !== a.value) return b.value - a.value;
      return a.index - b.index;
    });

    for (var add = 0; add < order.length && remaining > 0; add++) {
      widths[order[add].index]++;
      remaining--;
    }
  }

  return widths;
}

export function hudRatioDisplayValues(values, options) {
  var opts = options || {};
  var active = (values || []).slice(0, HUD_RATIO_TEAM_MAX);
  while (active.length < 1) active.push(0);

  var normalized = [];
  var hasPositive = false;
  for (var i = 0; i < active.length; i++) {
    var value = Math.max(0, Math.round(Number(active[i]) || 0));
    normalized.push(value);
    if (value > 0) hasPositive = true;
  }

  if (opts.zeroValuesAsEqual === false || hasPositive) {
    return normalized;
  }

  var equalValue = Math.max(1, Math.round(Number(opts.zeroDisplayValue) || 1));
  for (var z = 0; z < normalized.length; z++) {
    normalized[z] = equalValue;
  }

  return normalized;
}

export function hudRatioCumulativeEnds(widths) {
  var list = widths || [];
  var ends = [];
  var used = 0;

  for (var i = 0; i < list.length && i < HUD_RATIO_TEAM_MAX; i++) {
    used += Math.max(0, Math.round(Number(list[i]) || 0));
    ends.push(used);
  }

  return ends;
}

// Compatibility helpers retained for code that imports the old four-color API.
export function hudRatioRedEnd(widths) {
  return (hudRatioCumulativeEnds(widths)[0] || 0);
}

export function hudRatioRedWidth(widths) {
  return Math.max(0, Math.round(Number((widths || [])[0]) || 0));
}

export function hudRatioBlueEnd(widths) {
  return (hudRatioCumulativeEnds(widths)[1] || hudRatioRedEnd(widths));
}

export function hudRatioBlueWidth(widths) {
  return Math.max(0, Math.round(Number((widths || [])[1]) || 0));
}

export function hudRatioYellowEnd(widths) {
  return (hudRatioCumulativeEnds(widths)[2] || hudRatioBlueEnd(widths));
}

export function hudRatioYellowWidth(widths) {
  return Math.max(0, Math.round(Number((widths || [])[2]) || 0));
}

export function hudRatioGreenEnd(widths, innerWidth) {
  var ends = hudRatioCumulativeEnds(widths);
  return ends.length >= 4
    ? ends[3]
    : (innerWidth === undefined ? HUD_BAR_INNER_WIDTH : innerWidth);
}

export function hudRatioGreenWidth(widths) {
  return Math.max(0, Math.round(Number((widths || [])[3]) || 0));
}

export function hudRatioColorWidths(values, innerWidth) {
  var widths = hudRatioUnitWidths(values, innerWidth);
  var result = {};
  for (var i = 0; i < widths.length && i < HUD_RATIO_TEAM_MAX; i++) {
    result[HUD_RATIO_TEAM_NAMES[i]] = widths[i];
  }
  return result;
}

export function hudRatioColorEnds(values, innerWidth) {
  var widths = hudRatioUnitWidths(values, innerWidth);
  var ends = hudRatioCumulativeEnds(widths);
  var result = {};
  for (var i = 0; i < ends.length && i < HUD_RATIO_TEAM_MAX; i++) {
    result[HUD_RATIO_TEAM_NAMES[i]] = ends[i];
  }
  return result;
}

export function hudBuildRatioBarToken(values, options) {
  var opts = options || {};
  var innerWidth = opts.innerWidth === undefined
    ? HUD_BAR_INNER_WIDTH
    : opts.innerWidth;
  var quantum = opts.quantum === undefined ? HUD_BAR_QUANTUM : opts.quantum;

  var displayValues = hudRatioDisplayValues(values, {
    zeroValuesAsEqual: opts.zeroValuesAsEqual !== undefined
      ? opts.zeroValuesAsEqual
      : opts.equalFourWhenAllZero,
    zeroDisplayValue: opts.zeroDisplayValue
  });

  var token = "!rbar.|mteam|";
  var hasVisibleValue = false;

  for (var check = 0; check < displayValues.length; check++) {
    if ((Number(displayValues[check]) || 0) > 0) {
      hasVisibleValue = true;
      break;
    }
  }

  // With no tagged teams the ratio HUD intentionally contains only its
  // black background. Do not synthesize equal color shares in this mode.
  if (!hasVisibleValue && opts.zeroValuesAsEqual === false) {
    return token;
  }

  var widths = hudRatioUnitWidths(displayValues, innerWidth);
  var ends = hudRatioCumulativeEnds(widths);

  var teamNames = Array.isArray(opts.teamNames)
    ? opts.teamNames.slice(0, HUD_RATIO_TEAM_MAX)
    : HUD_RATIO_TEAM_NAMES.slice(0, ends.length);

  // Emit cumulative endpoints for the selected canonical team colors.
  for (var i = 0; i < ends.length && i < HUD_RATIO_TEAM_MAX; i++) {
    var teamName = String(
      teamNames[i] || HUD_RATIO_TEAM_NAMES[i] || ""
    ).toLowerCase();
    var teamIndex = HUD_RATIO_TEAM_NAMES.indexOf(teamName);
    if (teamIndex < 0) continue;

    token += HUD_RATIO_TEAM_TOKEN_PREFIXES[teamIndex]
      + hudPad3(ends[i], innerWidth, quantum)
      + "|";
  }

  return token;
}

export function hudCountdownRatio(remainingTicks, totalTicks) {
  var total = Math.max(1, Number(totalTicks) || 1);
  return hudClamp01((Number(remainingTicks) || 0) / total);
}

export function hudCountdownIsRed(ratio) {
  return hudClamp01(ratio) <= HUD_COUNTDOWN_RED_RATIO;
}

export function hudCountdownIsYellow(ratio) {
  var r = hudClamp01(ratio);
  return r > HUD_COUNTDOWN_RED_RATIO && r <= HUD_COUNTDOWN_YELLOW_RATIO;
}

export function hudCountdownIsBlue(ratio) {
  return hudClamp01(ratio) > HUD_COUNTDOWN_YELLOW_RATIO;
}

export function hudCountdownColorIndex(ratio) {
  var r = hudClamp01(ratio);
  return hudCountdownIsRed(r) ? HUD_XPBAR_COLOR_RED
    : hudCountdownIsYellow(r) ? HUD_XPBAR_COLOR_YELLOW
    : HUD_XPBAR_COLOR_BLUE;
}

export function hudCountdownWidth(ratio, innerWidth) {
  var widthMax = innerWidth === undefined ? HUD_BAR_INNER_WIDTH : innerWidth;
  return Math.round(hudClamp01(ratio) * widthMax);
}

export function hudBuildCountdownBarToken(remainingTicks, totalTicks, options) {
  var opts = options || {};
  var innerWidth = opts.innerWidth === undefined
    ? HUD_BAR_INNER_WIDTH
    : opts.innerWidth;
  var quantum = opts.quantum === undefined ? HUD_BAR_QUANTUM : opts.quantum;
  var ratio = hudCountdownRatio(remainingTicks, totalTicks);
  var colorIndex = hudCountdownColorIndex(ratio);
  var width = hudCountdownWidth(ratio, innerWidth);

  // Vanilla experience bar look (style "xp"): the UI draws the vanilla bar
  // textures and uses |pNNN| for the filled width, there is no color.
  if (String(opts.style || "").toLowerCase() === "xp") {
    return "!xpbar.|mvan|p" + hudPad3(width, innerWidth, quantum) + "|";
  }

  return "!xpbar.|mboss|b" + colorIndex
    + "|p" + hudPad3(width, innerWidth, quantum)
    + "|";
}

export function hudTimeMode(mode) {
  var text = String(mode || "").toLowerCase();
  if (text === HUD_TIME_MODE_COUNTUP || text === "up") {
    return HUD_TIME_MODE_COUNTUP;
  }
  if (text === HUD_TIME_MODE_TIMER || text === "time") {
    return HUD_TIME_MODE_TIMER;
  }
  return HUD_TIME_MODE_COUNTDOWN;
}

export function hudTicksToSeconds(ticks, rounding) {
  var value = Math.max(0, Number(ticks) || 0) / 20;
  if (rounding === "floor") return Math.floor(value);
  if (rounding === "round") return Math.round(value);
  return Math.ceil(value);
}

export function hudTimeValueTicks(mode, timing) {
  var m = hudTimeMode(mode);
  var t = timing || {};

  if (m === HUD_TIME_MODE_COUNTUP) {
    if (t.elapsedTicks !== undefined) return Math.max(0, Number(t.elapsedTicks) || 0);
    if (t.currentTicks !== undefined) return Math.max(0, Number(t.currentTicks) || 0);
    var totalUp = Math.max(0, Number(t.totalTicks) || 0);
    return Math.max(0, totalUp - Math.max(0, Number(t.remainingTicks) || 0));
  }

  if (m === HUD_TIME_MODE_TIMER) {
    if (t.timerTicks !== undefined) return Math.max(0, Number(t.timerTicks) || 0);
    if (t.currentTicks !== undefined) return Math.max(0, Number(t.currentTicks) || 0);
    if (t.elapsedTicks !== undefined) return Math.max(0, Number(t.elapsedTicks) || 0);
    return Math.max(0, Number(t.remainingTicks) || 0);
  }

  if (t.remainingTicks !== undefined) return Math.max(0, Number(t.remainingTicks) || 0);
  if (t.currentTicks !== undefined) return Math.max(0, Number(t.currentTicks) || 0);
  var totalDown = Math.max(0, Number(t.totalTicks) || 0);
  return Math.max(0, totalDown - Math.max(0, Number(t.elapsedTicks) || 0));
}

export function hudTimeDisplaySeconds(mode, timing, options) {
  var opts = options || {};
  var rounding = opts.rounding || (
    hudTimeMode(mode) === HUD_TIME_MODE_COUNTUP ? "floor" : "ceil"
  );
  return hudTicksToSeconds(hudTimeValueTicks(mode, timing), rounding);
}

export function hudTimeBarRatio(mode, timing) {
  var t = timing || {};
  var total = Math.max(1, Number(t.totalTicks) || 1);
  var value = hudTimeValueTicks(mode, t);
  return hudClamp01(value / total);
}

export function hudBuildValueBarToken(
  mode,
  currentValue,
  maxValue,
  options
) {
  var opts = options || {};
  var max = Math.max(1, Number(maxValue) || 1);
  var current = Math.max(
    0,
    Math.min(max, Number(currentValue) || 0)
  );
  var direction = String(mode || "").toLowerCase();

  var visibleValue = (
    direction === "countdown"
    || direction === "down"
  )
    ? Math.max(0, max - current)
    : current;

  var innerWidth = opts.innerWidth === undefined
    ? HUD_BAR_INNER_WIDTH
    : opts.innerWidth;
  var quantum = opts.quantum === undefined
    ? HUD_BAR_QUANTUM
    : opts.quantum;
  var ratio = hudClamp01(visibleValue / max);
  var width = hudCountdownWidth(
    ratio,
    innerWidth
  );

  var color = String(opts.color || "blue").trim().toLowerCase();

  // color "xp": the vanilla experience bar look (same token as the timers).
  if (color === "xp") {
    return "!xpbar.|mvan|p" + hudPad3(width, innerWidth, quantum) + "|";
  }

  if (
    color !== "blue"
    && color !== "red"
    && color !== "green"
    && color !== "yellow"
    && color !== "purple"
    && color !== "orange"
    && color !== "white"
  ) {
    color = "blue";
  }

  return "!cbar.|c"
    + color
    + "|p"
    + hudPad3(width, innerWidth, quantum)
    + "|";
}

export function hudBuildTimeBarToken(mode, timing, options) {
  var opts = options || {};
  var total = Math.max(1, Number((timing || {}).totalTicks) || 1);
  var value = hudTimeValueTicks(mode, timing);

  return hudBuildCountdownBarToken(value, total, opts);
}

export function hudBuildTimeTimerToken(mode, timing, options) {
  return hudBuildCountdownTimerToken(
    hudTimeDisplaySeconds(mode, timing, options)
  );
}

export function hudBuildTimeHudTokens(mode, timing, options) {
  return {
    mode: hudTimeMode(mode),
    barToken: hudBuildTimeBarToken(mode, timing, options),
    timerToken: hudBuildTimeTimerToken(mode, timing, options)
  };
}

export function hudBuildCountdownTimerToken(totalSecondsRemaining) {
  var clamped = Math.max(
    0,
    Math.min(
      5999,
      Math.round(totalSecondsRemaining) || 0
    )
  );

  var mm = Math.floor(clamped / 60);
  var ss = clamped % 60;
  var a = Math.floor(mm / 10);
  var b = mm % 10;
  var c = Math.floor(ss / 10);
  var d = ss % 10;

  return "!t|ta" + a + "|tb" + b + "|tc" + c + "|td" + d + "|";
}

export function hudFormatMmSs(totalSecondsRemaining) {
  var total = Math.max(0, Math.round(Number(totalSecondsRemaining) || 0));
  var mm = Math.floor(total / 60);
  var ss = total % 60;
  return String(mm) + ":" + (ss < 10 ? "0" : "") + String(ss);
}
