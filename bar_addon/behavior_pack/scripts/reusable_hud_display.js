import { system, world } from "@minecraft/server";
import {
  hudBuildCountdownBarToken,
  hudBuildCountdownTimerToken,
  hudBuildValueBarToken,
  hudBuildTimeBarToken,
  hudBuildTimeHudTokens,
  hudBuildTimeTimerToken,
  hudBuildRatioBarToken
} from "./reusable_hud_parts.js";

var HUD_CLEAR_TITLE = "!rt.";
var HUD_CLEAR_SUBTITLE = "!0";
var HUD_TEXT_TITLE_PREFIX = "!rtx.";
var HUD_TIMER_LABEL_TITLE_PREFIX = "!rtl.";
var hudStateByPlayer = {};
var hudSyncPendingByPlayer = {};

function clearReusableHudStateByKey(key) {
  var id = String(key || "");
  if (!id) return;

  delete hudStateByPlayer[id];
  delete hudSyncPendingByPlayer[id];
}

try {
  if (world.afterEvents && world.afterEvents.playerLeave) {
    world.afterEvents.playerLeave.subscribe(function (event) {
      try {
        clearReusableHudStateByKey(event && event.playerId);
        clearReusableHudStateByKey(event && event.playerName);
      } catch (e) {}
    });
  }
} catch (eLeave) {}

function playerKey(player) {
  if (!player) return "";
  return String(player.id || player.name || "");
}

function stateFor(player) {
  var key = playerKey(player);
  var state = hudStateByPlayer[key];
  if (!state) {
    state = {
      title: HUD_CLEAR_TITLE,
      overlayText: "",
      teamText: "",
      timerLabel: "",
      timerToken: "",
      barToken: "",
      // Rows (0-3) of 20px kept free at the top for boss bars.
      bossPad: 0,
      lastSentTitle: "",
      lastSentSubtitle: ""
    };
    hudStateByPlayer[key] = state;
  }
  return state;
}

function titleForState(state) {
  // Team selection is intentionally highest priority while the player is
  // standing in a team area. Normal bar/timer updates must not erase it.
  var teamText = String((state && state.teamText) || "");
  if (teamText) return HUD_TEXT_TITLE_PREFIX + teamText;

  var timerLabel = String((state && state.timerLabel) || "");
  if (timerLabel) return HUD_TIMER_LABEL_TITLE_PREFIX + timerLabel;

  var text = String((state && state.overlayText) || "");
  if (text) return HUD_TEXT_TITLE_PREFIX + text;

  return String((state && state.title) || HUD_CLEAR_TITLE);
}

// "!bpad.|bl1|bl2|" = leave 2 rows free (the UI shows one spacer per |blN|).
function bossPadToken(state) {
  var rows = Math.max(0, Math.min(3, Math.floor(Number(state && state.bossPad) || 0)));
  if (rows <= 0) return "";

  var token = "!bpad.";
  for (var i = 1; i <= rows; i++) token += "|bl" + i;
  return token + "|";
}

function combinedSubtitle(state) {
  var timerToken = String((state && state.timerToken) || "");
  var barToken = String((state && state.barToken) || "");
  return (timerToken || HUD_CLEAR_SUBTITLE) + barToken + bossPadToken(state);
}

function stateHasContent(state) {
  return !!(
    state
    && (state.overlayText || state.teamText || state.timerLabel
      || state.timerToken || state.barToken)
  );
}

// True while any player has something on the bar HUD.
export function hasActiveReusableHud() {
  for (var key in hudStateByPlayer) {
    if (Object.prototype.hasOwnProperty.call(hudStateByPlayer, key)
      && stateHasContent(hudStateByPlayer[key])) {
      return true;
    }
  }
  return false;
}

export function clearReusableHudState(player) {
  delete hudStateByPlayer[playerKey(player)];
  delete hudSyncPendingByPlayer[playerKey(player)];
}

function sendReusableHud(player, stayDuration, force) {
  if (!player || !player.onScreenDisplay) return;

  var state = stateFor(player);
  var stay = stayDuration === undefined ? 999999 : stayDuration;
  var title = titleForState(state);
  var subtitle = combinedSubtitle(state);

  if (!force && state.lastSentTitle === title && state.lastSentSubtitle === subtitle) {
    return;
  }

  try {
    player.onScreenDisplay.setTitle(title, {
      subtitle: subtitle,
      fadeInDuration: 0,
      stayDuration: stay,
      fadeOutDuration: 0
    });
    state.lastSentTitle = title;
    state.lastSentSubtitle = subtitle;
  } catch (e) {
    try {
      player.onScreenDisplay.setTitle(title);
      state.lastSentTitle = title;
      state.lastSentSubtitle = subtitle;
    } catch (e2) {}
  }
}

export function syncReusableHud(player, stayDuration) {
  sendReusableHud(player, stayDuration, true);
}

export function queueReusableHudSync(player, delayTicks) {
  if (!player) return;

  var key = playerKey(player);
  if (hudSyncPendingByPlayer[key]) {
    hudSyncPendingByPlayer[key].player = player;
    return;
  }

  hudSyncPendingByPlayer[key] = { player: player };

  system.runTimeout(function () {
    var pending = hudSyncPendingByPlayer[key];
    delete hudSyncPendingByPlayer[key];
    if (!pending || !pending.player) return;

    sendReusableHud(pending.player, 999999, false);
  }, Math.max(1, Math.floor(Number(delayTicks) || 1)));
}

// Keeps `rows` x 20px free above the bars so they sit below boss bars.
// Nothing is sent while the player has nothing on the HUD; the value is
// remembered and goes out with the next bar.
export function setReusableHudBossPad(player, rows) {
  if (!player) return;

  var state = stateFor(player);
  var next = Math.max(0, Math.min(3, Math.floor(Number(rows) || 0)));
  if (state.bossPad === next) return;

  state.bossPad = next;
  if (stateHasContent(state)) queueReusableHudSync(player);
}

export function getReusableHudBossPad(player) {
  if (!player) return 0;
  return stateFor(player).bossPad || 0;
}

export function setReusableHudBarToken(player, barToken, force) {
  if (!player) return;

  var state = stateFor(player);
  var next = String(barToken || "");
  if (!force && state.barToken === next) return;

  state.barToken = next;
  if (force) syncReusableHud(player);
  else queueReusableHudSync(player);
}

export function setReusableHudTimerToken(player, timerToken, force) {
  if (!player) return;

  var state = stateFor(player);
  var next = String(timerToken || "");
  if (!force && state.timerToken === next) return;

  state.timerToken = next;
  if (force) syncReusableHud(player);
  else queueReusableHudSync(player);
}

export function setReusableHudOverlayText(player, text, force) {
  if (!player) return;

  var state = stateFor(player);
  var next = String(text || "");
  if (!force && state.overlayText === next) return;

  state.overlayText = next;
  if (force) syncReusableHud(player);
  else queueReusableHudSync(player);
}

export function clearReusableHudOverlayText(player, force) {
  setReusableHudOverlayText(player, "", !!force);
}

export function setReusableHudTeamText(player, text, force) {
  if (!player) return;

  var state = stateFor(player);
  var next = String(text || "");
  if (!force && state.teamText === next) return;

  state.teamText = next;

  if (force) syncReusableHud(player);
  else queueReusableHudSync(player);
}

export function clearReusableHudTeamText(player, force) {
  setReusableHudTeamText(player, "", !!force);
}

export function setReusableHudTimerLabel(player, text, force) {
  if (!player) return;

  var state = stateFor(player);
  var next = String(text || "");
  if (!force && state.timerLabel === next) return;

  state.timerLabel = next;
  if (force) syncReusableHud(player);
  else queueReusableHudSync(player);
}

export function clearReusableHudTimerLabel(player, force) {
  setReusableHudTimerLabel(player, "", !!force);
}

export function showReusableRatioBar(player, values, options) {
  setReusableHudBarToken(
    player,
    hudBuildRatioBarToken(values, options),
    options && options.force
  );
}

export function showReusableRatioHud(player, values, options) {
  if (!player) return;

  var opts = options || {};
  var state = stateFor(player);
  var title = String(opts.title || "").trim();
  var seconds = Math.max(
    0,
    Math.floor(Number(opts.clockSeconds) || 0)
  );
  var timerEnabled = !!opts.timerEnabled;

  state.title = HUD_CLEAR_TITLE;
  state.teamText = "";
  state.timerLabel = "";
  state.timerToken = "";
  state.overlayText = "";

  if (timerEnabled) {
    state.timerLabel = title ? ("§l" + title + "§r") : "";
    state.timerToken = hudBuildCountdownTimerToken(seconds);
  } else if (title) {
    state.overlayText = "§l" + title + "§r";
  }

  state.barToken = hudBuildRatioBarToken(values, opts);

  if (opts.force) {
    syncReusableHud(player);
  } else {
    queueReusableHudSync(player);
  }
}

export function showReusableCountdownBar(
  player,
  remainingTicks,
  totalTicks,
  options
) {
  setReusableHudBarToken(
    player,
    hudBuildCountdownBarToken(remainingTicks, totalTicks, options),
    options && options.force
  );
}

export function showReusableCountdownTimer(player, seconds, force) {
  setReusableHudTimerToken(
    player,
    hudBuildCountdownTimerToken(seconds),
    !!force
  );
}

export function showReusableCountdownHud(
  player,
  remainingTicks,
  totalTicks,
  options
) {
  var seconds = Math.max(0, Math.ceil((Number(remainingTicks) || 0) / 20));
  var state = stateFor(player);
  state.timerToken = hudBuildCountdownTimerToken(seconds);
  state.barToken = hudBuildCountdownBarToken(remainingTicks, totalTicks, options);
  if (options && options.force) syncReusableHud(player);
  else queueReusableHudSync(player);
}

export function showReusableTimeBar(player, mode, timing, options) {
  setReusableHudBarToken(
    player,
    hudBuildTimeBarToken(mode, timing, options),
    options && options.force
  );
}

export function showReusableValueBarOnly(
  player,
  mode,
  currentValue,
  maxValue,
  options
) {
  if (!player) return;

  var opts = options || {};
  var state = stateFor(player);

  state.title = HUD_CLEAR_TITLE;
  state.overlayText = "";
  state.teamText = "";
  state.timerLabel = "";
  state.timerToken = "";
  state.barToken = hudBuildValueBarToken(
    mode,
    currentValue,
    maxValue,
    opts
  );

  if (opts.force) {
    syncReusableHud(player);
  } else {
    queueReusableHudSync(player);
  }
}

// Counter-only HUD path.
// This is intentionally atomic: timer label/digits are removed before the
// counter title and bar are written, so a previous timer can never remain
// layered over /rt:countup or /rt:countdown.
export function showReusableCounterHud(
  player,
  mode,
  sourceLabel,
  displayValue,
  currentValue,
  maxValue,
  options
) {
  if (!player) return;

  var opts = options || {};
  var state = stateFor(player);
  var shown = Math.max(0, Math.floor(Number(displayValue) || 0));
  var max = Math.max(1, Math.floor(Number(maxValue) || 1));
  var title = String(opts.title || "").trim();
  var displayMode = String(opts.displayMode || "none").toLowerCase();
  if (
    displayMode !== "count"
    && displayMode !== "timer"
    && displayMode !== "none"
  ) {
    displayMode = "none";
  }

  state.title = HUD_CLEAR_TITLE;
  state.teamText = "";

  // Counter bars always use !cbar for the bar itself. The optional clock below
  // is display-only and never controls bar width, color, or completion.
  state.timerLabel = "";
  state.timerToken = "";
  state.overlayText = "";

  if (displayMode === "count") {
    var countText = String(shown) + "/" + String(max);
    state.overlayText = title
      ? ("§l" + title + "§r " + countText)
      : countText;
  } else if (displayMode === "timer") {
    state.timerLabel = title ? ("§l" + title + "§r") : "";
    state.timerToken = hudBuildCountdownTimerToken(
      Math.max(0, Math.floor(Number(opts.elapsedSeconds) || 0))
    );
  } else if (title) {
    // "none" hides the secondary value but keeps the requested bar title.
    state.overlayText = "§l" + title + "§r";
  }

  // The bar is built from the same whole number that the text shows, so a
  // value such as 9.99 does not show "9/10" next to a full bar.
  var direction = String(mode || "").toLowerCase();
  var countingDown = direction === "countdown" || direction === "down";
  var shownForBar = Math.min(max, shown);
  var barCurrent = countingDown ? (max - shownForBar) : shownForBar;

  state.barToken = hudBuildValueBarToken(
    mode,
    barCurrent,
    max,
    opts
  );

  if (opts.force) {
    syncReusableHud(player);
  } else {
    queueReusableHudSync(player);
  }
}

export function showReusableTimeTimer(player, mode, timing, options) {
  setReusableHudTimerToken(
    player,
    hudBuildTimeTimerToken(mode, timing, options),
    options && options.force
  );
}

export function showReusableTimeHud(player, mode, timing, options) {
  if (!player) return;

  var tokens = hudBuildTimeHudTokens(mode, timing, options);
  var state = stateFor(player);
  state.timerToken = tokens.timerToken;
  state.barToken = tokens.barToken;
  if (options && options.force) syncReusableHud(player);
  else queueReusableHudSync(player);
}

export function clearReusableHud(player, force) {
  if (!player) return;

  var state = stateFor(player);
  state.overlayText = "";
  state.teamText = "";
  state.timerLabel = "";
  state.timerToken = "";
  state.barToken = "";

  if (force) {
    syncReusableHud(player, 1);
  } else {
    queueReusableHudSync(player);
  }
}
