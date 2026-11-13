// Ratio bar family.

import { system } from "@minecraft/server";
import {
  showReusableRatioHud
} from "../reusable_hud_display.js";
import {
  hudRatioTeamForPlayer
} from "../reusable_team_ratio_bar.js";
import {
  parseRatioTeamSelection,
  ratioTeamValues,
  ratioTeamPresence
} from "./bar_common.js";
import {
  syncRatioCommandBridge
} from "./ratio_command_bridge.js";

function ratioElapsedSeconds(config) {
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

export function updateRatioBar(players, config, options) {
  var cfg = config || {};
  var opts = options || {};
  var list = players || [];
  var aggregatePlayers = Array.isArray(opts.aggregatePlayers)
    ? opts.aggregatePlayers
    : list;
  var selectedTeams = parseRatioTeamSelection(
    cfg.ratioTeams || cfg.teamCount
  );
  var values = ratioTeamValues(
    aggregatePlayers,
    cfg.source,
    selectedTeams
  );
  var presence = ratioTeamPresence(
    aggregatePlayers,
    selectedTeams
  );

  var totalValue = 0;
  var taggedTeamCount = 0;
  for (var sumIndex = 0; sumIndex < values.length; sumIndex++) {
    totalValue += Math.max(0, Number(values[sumIndex]) || 0);
    if (presence[sumIndex]) taggedTeamCount++;
  }

  // Ratio has three distinct phases:
  //
  // 1) Never started:
  //    Ignore old source values and show selected tagged teams equally.
  //
  // 2) Running:
  //    Use real values; while all are zero keep the equal tagged-team split.
  //    Save every live visual as the frozen/reload snapshot.
  //
  // 3) Started but stopped/finished:
  //    Keep the last live snapshot. Do NOT fall back to "pre-start" just
  //    because running=false. This is what preserves a two-color result after
  //    world reload even when only the first player has loaded so far.
  var hasStarted = !!cfg.ratioHasStarted;
  var noAggregatePlayers = aggregatePlayers.length <= 0;
  var useSavedSnapshot = (
    Array.isArray(cfg.ratioLastDisplayValues)
    && cfg.ratioLastDisplayValues.length === selectedTeams.length
    && (
      (hasStarted && !cfg.running)
      || !!cfg.ratioRestoreHold
      || (cfg.running && noAggregatePlayers)
    )
  );

  var displayValues;
  var displayPresence;
  var bridgeValues;

  if (useSavedSnapshot) {
    // The visual itself is frozen, but "active" continues to reflect who is
    // actually online now. Player presence must never rewrite the frozen bar.
    // This also protects the last live frame when the final online player
    // leaves during a running round.
    displayValues = cfg.ratioLastDisplayValues.slice();
    displayPresence = presence.slice();
    bridgeValues = (
      Array.isArray(cfg.ratioLastValues)
      && cfg.ratioLastValues.length === selectedTeams.length
    )
      ? cfg.ratioLastValues.slice()
      : values.slice();
  } else if (!hasStarted) {
    // PRE-PLAY STICKY TEAMS:
    // A selected team becomes visible when an eligible tagged player is seen.
    // Once seen, keep that team visible until a new /rt:ratio or /rt:play.
    // Therefore a player leaving before the game starts cannot collapse a
    // previously established two-color bar back to one color.
    var previousPreplayPresence = (
      Array.isArray(cfg.ratioLastPresence)
      && cfg.ratioLastPresence.length === selectedTeams.length
    )
      ? cfg.ratioLastPresence
      : presence.map(function () { return 0; });

    var stickyPreplayPresence = presence.map(function (item, index) {
      return (item || previousPreplayPresence[index]) ? 1 : 0;
    });

    displayValues = stickyPreplayPresence.slice();
    // Keep command-bridge active status tied to actual online presence.
    displayPresence = presence.slice();
    bridgeValues = values.map(function () { return 0; });

    // Persist the sticky visual/presence. It survives player leave and reload.
    cfg.ratioLastDisplayValues = displayValues.slice();
    cfg.ratioLastPresence = stickyPreplayPresence.slice();
    cfg.ratioLastValues = bridgeValues.slice();
  } else {
    displayValues = totalValue > 0
      ? values.slice()
      : presence.slice();
    displayPresence = presence.slice();
    bridgeValues = values.slice();

    // Save the complete live frame. These arrays are persisted by the
    // controller and become the exact frozen visual after stop/reload.
    cfg.ratioLastDisplayValues = displayValues.slice();
    cfg.ratioLastPresence = displayPresence.slice();
    cfg.ratioLastValues = values.slice();
  }

  var commandState = syncRatioCommandBridge(
    bridgeValues,
    displayPresence,
    displayValues,
    !!cfg.running,
    selectedTeams
  );

  var ratioSeconds = Math.max(
    0,
    Math.floor(Number(cfg.ratioSeconds) || 0)
  );
  var elapsedSeconds = ratioElapsedSeconds(cfg);
  var clockSeconds = ratioSeconds > 0
    ? Math.max(0, ratioSeconds - elapsedSeconds)
    : 0;

  for (var i = 0; i < list.length; i++) {
    if (opts.onlyTeamMembers && !hudRatioTeamForPlayer(list[i])) continue;

    var ratioOptions = {};
    for (var key in opts) ratioOptions[key] = opts[key];
    ratioOptions.zeroValuesAsEqual = false;

    ratioOptions.title = String(cfg.ratioTitle || "");
    ratioOptions.timerEnabled = ratioSeconds > 0;
    ratioOptions.clockSeconds = clockSeconds;
    ratioOptions.teamNames = selectedTeams.slice();

    showReusableRatioHud(
      list[i],
      displayValues,
      ratioOptions
    );
  }

  return {
    kind: "ratio",
    teamCount: selectedTeams.length,
    teams: selectedTeams.slice(),
    values: values.slice(),
    presence: displayPresence.slice(),
    taggedTeamCount: displayPresence.reduce(function (sum, item) {
      return sum + (item ? 1 : 0);
    }, 0),
    blackOnly: displayValues.every(function (item) {
      return !(Math.max(0, Number(item) || 0) > 0);
    }),
    percentages: commandState.percentages.slice(),
    title: String(cfg.ratioTitle || ""),
    timerEnabled: ratioSeconds > 0,
    timerSeconds: ratioSeconds,
    elapsedSeconds: elapsedSeconds,
    clockSeconds: clockSeconds
  };
}
