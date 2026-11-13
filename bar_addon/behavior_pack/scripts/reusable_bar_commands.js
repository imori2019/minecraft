import * as minecraftServer from "@minecraft/server";
import {
  clearReusableHud,
  setReusableHudOverlayText,
  setReusableHudTimerLabel,
  setReusableHudTimerToken,
  showReusableTimeHud,
  syncReusableHud
} from "./reusable_hud_display.js";
import {
  barKind,
  isTimedCounterMode,
  resetCounterSource,
  ratioSelectedPlayers,
  parseRatioTeamSelection,
  ratioTeamSelectionIsValid,
  ratioTeamSelectionToken
} from "./bar/bar_common.js";
import {
  updateCounterBar
} from "./bar/counter_bar.js";
import { updateRatioBar } from "./bar/ratio_bar.js";
import {
  clearRatioCommandBridge,
  resetRatioCommandEvents
} from "./bar/ratio_command_bridge.js";
import {
  barTimer,
  updateTimerHud,
  updateLegacyTimedProgressHud
} from "./bar/timer.js";
import {
  canAccessWorldDynamicProperties,
  clearChunkedJson,
  readChunkedJson,
  writeChunkedJson
} from "./reusable_persistence.js";
import { updateReusableBossPadNow } from "./reusable_boss_pad.js";
import {
  clearScoreWriteCache,
  getCachedObjective,
  writeScoreCached
} from "./reusable_score_writer.js";
import {
  isReusableStatSource,
  reusableStatComboNameError,
  reusableStatComboMember,
  reusableStatSourceError
} from "./reusable_stat_source.js";
import {
  deleteReusableStatCombo,
  getReusableStatCombo,
  listReusableStatCombos,
  setReusableStatCombo
} from "./reusable_stat_combo.js";
import {
  compileStatExpression,
  describeStatExpression
} from "./reusable_stat_expr.js";

var CustomCommandParamType = minecraftServer.CustomCommandParamType || {};
var CustomCommandPermissionLevel =
  minecraftServer.CustomCommandPermissionLevel
  || minecraftServer.CommandPermissionLevel
  || {};
var CustomCommandStatus = minecraftServer.CustomCommandStatus || {};
var system = minecraftServer.system;
var world = minecraftServer.world;

var CUSTOM_COMMAND_PARAM_STRING = CustomCommandParamType.String || "String";
var CUSTOM_COMMAND_PARAM_INTEGER = CustomCommandParamType.Integer || "Integer";
var CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS =
  CustomCommandPermissionLevel.GameDirectors || 1;
var CUSTOM_COMMAND_STATUS_SUCCESS = CustomCommandStatus.Success || 0;
var CUSTOM_COMMAND_STATUS_FAILURE = CustomCommandStatus.Failure || 1;

var barCommandsRegistered = false;
var barCommandRegistrationFailures = [];
var barRuntimeHandle = undefined;
var barRuntimeIntervalTicks = 0;
var timerApiHooksRegistered = false;
var BAR_PERSISTENCE_PREFIX = "rt_hud:bar_state_v1";
var barPersistenceLoaded = false;
var barPersistenceInitialized = false;
var barPersistenceRestoring = false;
var barPersistenceSavePending = false;
var barConfig = {
  mode: "",
  source: "",
  maxValue: 0,
  teamCount: 4,
  ratioTeams: "red_blue_yellow_green",
  ratioTitle: "",
  ratioSeconds: 0,

  // Ratio lifecycle:
  // false = configured but never started (live equal pre-start split)
  // true + running = live round
  // true + !running = finished/stopped; freeze the last live split
  ratioHasStarted: false,
  ratioLastDisplayValues: [],
  ratioLastPresence: [],
  ratioLastValues: [],
  ratioRestoreHold: false,

  // Names of players whose source has already been initialized for the
  // current source-driven round. Persisting this prevents a reconnect from
  // being mistaken for a brand-new mid-round participant and reset to 0.
  roundParticipants: [],

  running: false,
  // Counter-only elapsed clock state. This is intentionally separate from
  // reusable_timer.js so /rt:countup and /rt:countdown never become timer bars.
  startedTick: 0,
  pausedTicks: 0,
  counterTitle: "",
  counterDisplay: "none",
  counterColor: "blue",
  // Counter source baseline captured on the first /rt:play.
  counterBaseline: 0,
  counterBaselineReady: false,
  // Last clamped live counter value. Used to freeze a stopped counter across
  // player resyncs and world reloads until the next /rt:play.
  counterLastCurrent: 0,
  timerLabel: "",
  timerStartMessage: "",
  timerEndMessage: "",
  timerEndMessageSent: false,
  timerSoundEnabled: false,
  lastCountdownSoundSecond: -1,
  timerFinishSoundSent: false,
  timerDirection: "down",
  timerSeconds: 0,
  timerVisible: true,
  // false = hide only the timer digits; the label is shown as a title.
  timerDigitsVisible: true,
  // "" = boss bar look, "xp" = vanilla experience bar look (time bars).
  barStyle: ""
};

function copyBarConfigForSave() {
  return {
    mode: String(barConfig.mode || ""),
    source: String(barConfig.source || ""),
    maxValue: Number(barConfig.maxValue) || 0,
    teamCount: Number(barConfig.teamCount) || 4,
    ratioTeams: ratioTeamSelectionToken(
      barConfig.ratioTeams,
      barConfig.teamCount
    ),
    ratioTitle: String(barConfig.ratioTitle || ""),
    ratioSeconds: Math.max(
      0,
      Math.floor(Number(barConfig.ratioSeconds) || 0)
    ),
    ratioHasStarted: !!barConfig.ratioHasStarted,
    ratioLastDisplayValues: Array.isArray(barConfig.ratioLastDisplayValues)
      ? barConfig.ratioLastDisplayValues.slice(0, 8)
      : [],
    ratioLastPresence: Array.isArray(barConfig.ratioLastPresence)
      ? barConfig.ratioLastPresence.slice(0, 8)
      : [],
    ratioLastValues: Array.isArray(barConfig.ratioLastValues)
      ? barConfig.ratioLastValues.slice(0, 8)
      : [],
    roundParticipants: Array.isArray(barConfig.roundParticipants)
      ? barConfig.roundParticipants.slice(0, 128)
      : [],
    running: !!barConfig.running,
    // Save the accumulated counter clock rather than a raw system tick.
    // Offline time is intentionally not counted after reload.
    pausedTicks: counterElapsedTicks(),
    counterTitle: String(barConfig.counterTitle || ""),
    counterDisplay: normalizeCounterDisplay(barConfig.counterDisplay),
    counterColor: normalizeCounterColor(barConfig.counterColor),
    counterBaseline: Number(barConfig.counterBaseline) || 0,
    counterBaselineReady: !!barConfig.counterBaselineReady,
    counterLastCurrent: Math.max(
      0,
      Math.floor(Number(barConfig.counterLastCurrent) || 0)
    ),

    timerLabel: String(barConfig.timerLabel || ""),
    timerStartMessage: String(barConfig.timerStartMessage || ""),
    timerEndMessage: String(barConfig.timerEndMessage || ""),
    timerEndMessageSent: !!barConfig.timerEndMessageSent,
    timerSoundEnabled: false,
    lastCountdownSoundSecond:
      Number(barConfig.lastCountdownSoundSecond) || -1,
    timerFinishSoundSent: !!barConfig.timerFinishSoundSent,
    timerDirection: String(barConfig.timerDirection || "down"),
    timerSeconds: Math.max(
      0,
      Math.floor(Number(barConfig.timerSeconds) || 0)
    ),
    timerVisible: barConfig.timerVisible !== false,
    timerDigitsVisible: barConfig.timerDigitsVisible !== false,
    barStyle: String(barConfig.barStyle || "") === "xp" ? "xp" : ""
  };
}

function barPersistentState() {
  return {
    version: 3,
    config: copyBarConfigForSave(),
    timerState: barTimer.getState()
  };
}

function migrateReusableBarState(savedState) {
  if (!savedState || typeof savedState !== "object") {
    return undefined;
  }

  var originalVersion = Math.max(
    0,
    Math.floor(Number(savedState.version) || 0)
  );

  var migrated = {
    version: 3,
    config: savedState.config || {},
    timerState: savedState.timerState || undefined,
    migratedFrom: originalVersion
  };

  var config = migrated.config;

  if (!config.timerDirection) {
    config.timerDirection = (
      String(config.mode || "") === "time_countup"
        ? "up"
        : "down"
    );
  }

  if (!Number(config.timerSeconds)) {
    config.timerSeconds = Math.max(
      0,
      Math.floor(
        Number(
          migrated.timerState
          && migrated.timerState.totalSeconds
        )
        || Number(config.maxValue)
        || 0
      )
    );
  }

  config.timerSoundEnabled = false;

  if (config.teamCount === undefined) {
    config.teamCount = 4;
  }
  if (config.ratioTeams === undefined) {
    config.ratioTeams = ratioTeamSelectionToken(
      config.teamCount,
      config.teamCount
    );
  }
  if (config.ratioTitle === undefined) {
    config.ratioTitle = "";
  }
  if (config.ratioSeconds === undefined) {
    config.ratioSeconds = 0;
  }
  if (config.ratioHasStarted === undefined) {
    // Older saves cannot distinguish "never started" from "stopped".
    // A saved running ratio definitely started; otherwise default to pre-start.
    config.ratioHasStarted = (
      String(config.mode || "") === "ratio"
      && !!config.running
    );
  }
  if (!Array.isArray(config.ratioLastDisplayValues)) {
    config.ratioLastDisplayValues = [];
  }
  if (!Array.isArray(config.ratioLastPresence)) {
    config.ratioLastPresence = [];
  }
  if (!Array.isArray(config.ratioLastValues)) {
    config.ratioLastValues = [];
  }
  if (!Array.isArray(config.roundParticipants)) {
    config.roundParticipants = [];
  }

  if (config.counterTitle === undefined) {
    config.counterTitle = "";
  }
  if (config.counterDisplay === undefined) {
    config.counterDisplay = "none";
  }
  if (config.counterColor === undefined) {
    config.counterColor = "blue";
  }
  if (config.counterBaseline === undefined) {
    config.counterBaseline = 0;
  }
  if (config.counterBaselineReady === undefined) {
    config.counterBaselineReady = false;
  }
  if (config.counterLastCurrent === undefined) {
    config.counterLastCurrent = 0;
  }
  if (config.pausedTicks === undefined) {
    config.pausedTicks = 0;
  }

  return migrated;
}

function saveReusableBarStateNow() {
  if (barPersistenceRestoring) return false;

  // An empty bar is represented by no saved state.
  if (!barConfig.mode) {
    clearChunkedJson(BAR_PERSISTENCE_PREFIX);
    return true;
  }

  return writeChunkedJson(
    BAR_PERSISTENCE_PREFIX,
    barPersistentState()
  );
}

function queueReusableBarStateSave() {
  if (barPersistenceRestoring || barPersistenceSavePending) return;

  barPersistenceSavePending = true;

  system.run(function () {
    barPersistenceSavePending = false;
    saveReusableBarStateNow();
  });
}

function clearReusableBarSavedState() {
  clearChunkedJson(BAR_PERSISTENCE_PREFIX);
}

function applySavedBarConfig(savedConfig) {
  var saved = savedConfig || {};

  barConfig.mode = String(saved.mode || "");
  barConfig.source = String(saved.source || "");
  barConfig.maxValue = Math.max(
    0,
    Math.floor(Number(saved.maxValue) || 0)
  );
  barConfig.teamCount = Math.max(
    1,
    Math.min(8, Math.floor(Number(saved.teamCount) || 4))
  );
  barConfig.ratioTeams = ratioTeamSelectionToken(
    saved.ratioTeams,
    barConfig.teamCount
  );
  barConfig.teamCount = parseRatioTeamSelection(
    barConfig.ratioTeams
  ).length || barConfig.teamCount;
  barConfig.ratioTitle = String(saved.ratioTitle || "");
  barConfig.ratioSeconds = Math.max(
    0,
    Math.floor(Number(saved.ratioSeconds) || 0)
  );
  barConfig.ratioHasStarted = !!saved.ratioHasStarted;
  barConfig.ratioLastDisplayValues = Array.isArray(saved.ratioLastDisplayValues)
    ? saved.ratioLastDisplayValues.slice(0, 8)
    : [];
  barConfig.ratioLastPresence = Array.isArray(saved.ratioLastPresence)
    ? saved.ratioLastPresence.slice(0, 8)
    : [];
  barConfig.ratioLastValues = Array.isArray(saved.ratioLastValues)
    ? saved.ratioLastValues.slice(0, 8)
    : [];
  barConfig.roundParticipants = Array.isArray(saved.roundParticipants)
    ? saved.roundParticipants
        .slice(0, 128)
        .map(function (name) {
          return String(name || "").trim().toLowerCase();
        })
        .filter(function (name, index, array) {
          return !!name && array.indexOf(name) === index;
        })
    : [];

  // Any saved ratio visual is restored from its snapshot. The controller
  // keeps that visual frozen until the next explicit /rt:play or reconfigure.
  barConfig.ratioRestoreHold = (
    String(saved.mode || "") === "ratio"
    && barConfig.ratioLastDisplayValues.length > 0
  );

  barConfig.running = !!saved.running;

  // Reopening a world restores the exact last ratio visual as a frozen HUD.
  // Keep ratioHasStarted exactly as it was saved: pre-play stays pre-play,
  // finished stays finished. ratioRestoreHold alone prevents recalculation.
  if (
    String(saved.mode || "") === "ratio"
    && barConfig.ratioLastDisplayValues.length > 0
  ) {
    barConfig.running = false;
    barConfig.ratioRestoreHold = true;
  }
  barConfig.pausedTicks = Math.max(
    0,
    Math.floor(Number(saved.pausedTicks) || 0)
  );
  barConfig.startedTick = barConfig.running ? currentTick() : 0;
  barConfig.counterTitle = String(saved.counterTitle || "");
  barConfig.counterDisplay = normalizeCounterDisplay(saved.counterDisplay);
  barConfig.counterColor = normalizeCounterColor(saved.counterColor);
  barConfig.counterBaseline = Number(saved.counterBaseline) || 0;
  barConfig.counterBaselineReady = !!saved.counterBaselineReady;
  barConfig.counterLastCurrent = Math.max(
    0,
    Math.floor(Number(saved.counterLastCurrent) || 0)
  );

  barConfig.timerLabel = String(saved.timerLabel || "");
  barConfig.timerStartMessage = String(
    saved.timerStartMessage || ""
  );
  barConfig.timerEndMessage = String(
    saved.timerEndMessage || ""
  );
  barConfig.timerEndMessageSent = !!saved.timerEndMessageSent;
  barConfig.timerSoundEnabled = false;
  barConfig.lastCountdownSoundSecond = Number(
    saved.lastCountdownSoundSecond
  );
  if (!isFinite(barConfig.lastCountdownSoundSecond)) {
    barConfig.lastCountdownSoundSecond = -1;
  }
  barConfig.timerFinishSoundSent = !!saved.timerFinishSoundSent;
  barConfig.timerDirection = (
    String(saved.timerDirection || "down").toLowerCase() === "up"
      ? "up"
      : "down"
  );
  barConfig.timerSeconds = Math.max(
    0,
    Math.floor(Number(saved.timerSeconds) || 0)
  );
  barConfig.timerVisible = saved.timerVisible !== false;
  barConfig.timerDigitsVisible = saved.timerDigitsVisible !== false;
  barConfig.barStyle = String(saved.barStyle || "") === "xp" ? "xp" : "";
}


var playersCacheTick = -1;
var playersCache = [];

// One world.getPlayers() per tick; callers get their own copy.
function allPlayers() {
  var tick = -2;
  try {
    tick = system.currentTick;
  } catch (e) {}

  if (tick !== playersCacheTick) {
    try {
      playersCache = world.getPlayers();
    } catch (e2) {
      playersCache = [];
    }
    playersCacheTick = tick;
  }

  return playersCache.slice();
}

function roundParticipantName(player) {
  try {
    return String(player && player.name || "").trim().toLowerCase();
  } catch (e) {}
  return "";
}

function hasRoundParticipant(player) {
  var name = roundParticipantName(player);
  if (!name) return false;
  return (
    Array.isArray(barConfig.roundParticipants)
    && barConfig.roundParticipants.indexOf(name) >= 0
  );
}

function rememberRoundParticipant(player) {
  var name = roundParticipantName(player);
  if (!name) return false;

  if (!Array.isArray(barConfig.roundParticipants)) {
    barConfig.roundParticipants = [];
  }

  if (barConfig.roundParticipants.indexOf(name) >= 0) {
    return false;
  }

  barConfig.roundParticipants.push(name);
  return true;
}

function resetRoundParticipants(players) {
  barConfig.roundParticipants = [];
  var list = Array.isArray(players) ? players : [];
  for (var i = 0; i < list.length; i++) {
    rememberRoundParticipant(list[i]);
  }
}

function ensureLiveRatioParticipants(players) {
  if (
    !barConfig.running
    || barKind(barConfig.mode) !== "ratio"
  ) {
    return false;
  }

  var selected = ratioSelectedPlayers(
    Array.isArray(players) ? players : [],
    barConfig.ratioTeams
  );
  var newcomers = [];

  for (var i = 0; i < selected.length; i++) {
    if (!hasRoundParticipant(selected[i])) {
      newcomers.push(selected[i]);
    }
  }

  if (newcomers.length <= 0) return false;

  // This also catches a player who was already online but received a selected
  // team tag after /rt:play. They are initialized exactly once for the round.
  resetCounterSource(newcomers, barConfig.source);
  for (var n = 0; n < newcomers.length; n++) {
    rememberRoundParticipant(newcomers[n]);
  }
  queueReusableBarStateSave();
  return true;
}

function senderFromOrigin(origin) {
  try {
    if (origin && origin.sourceEntity && origin.sourceEntity.typeId === "minecraft:player") {
      return origin.sourceEntity;
    }
  } catch (e) {}

  try {
    if (origin && origin.initiator && origin.initiator.typeId === "minecraft:player") {
      return origin.initiator;
    }
  } catch (e2) {}

  return undefined;
}

function commandResult(status, message) {
  return {
    status: status,
    message: message
  };
}

function commandSuccess(message) {
  return commandResult(CUSTOM_COMMAND_STATUS_SUCCESS, message || "");
}

function commandFailure(message) {
  return commandResult(CUSTOM_COMMAND_STATUS_FAILURE, message || "");
}

function optionalStringParameters(names) {
  var params = [];
  var list = Array.isArray(names) ? names : [];

  for (var i = 0; i < list.length; i++) {
    params.push({
      type: CUSTOM_COMMAND_PARAM_STRING,
      name: list[i]
    });
  }

  return params;
}

function stringParameter(name) {
  return {
    type: CUSTOM_COMMAND_PARAM_STRING,
    name: name
  };
}

function integerParameter(name) {
  return {
    type: CUSTOM_COMMAND_PARAM_INTEGER,
    name: name
  };
}

function commandArgs(args) {
  var out = [];
  var list = Array.isArray(args) ? args : [];

  for (var i = 0; i < list.length; i++) {
    var value = list[i];
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      var nested = commandArgs(value);
      for (var j = 0; j < nested.length; j++) {
        out.push(nested[j]);
      }
      continue;
    }

    var text = String(value).trim();
    if (text) out.push(text);
  }

  return out;
}

function currentTick() {
  try {
    return system.currentTick;
  } catch (e) {}
  return 0;
}

function counterClockSpec(value) {
  var text = String(value || "").trim().toLowerCase();

  if (text === "count" || text === "none") {
    return {
      valid: true,
      mode: text,
      raw: text,
      direction: "",
      seconds: 0
    };
  }

  var match = /^([da])(\d+)$/.exec(text);
  if (!match) {
    return {
      valid: false,
      mode: "none",
      raw: "none",
      direction: "",
      seconds: 0
    };
  }

  var seconds = Math.floor(Number(match[2]));
  if (!isFinite(seconds) || seconds < 1 || seconds > 5999) {
    return {
      valid: false,
      mode: "none",
      raw: "none",
      direction: "",
      seconds: 0
    };
  }

  return {
    valid: true,
    mode: "timer",
    raw: match[1] + String(seconds),
    direction: match[1] === "d" ? "down" : "up",
    seconds: seconds
  };
}

function normalizeCounterDisplay(value) {
  var spec = counterClockSpec(value);
  return spec.valid ? spec.raw : "none";
}

function counterDisplayIsValid(value) {
  return counterClockSpec(value).valid;
}

function normalizeCounterTitle(value) {
  var text = String(
    value === undefined || value === null ? "" : value
  ).trim();

  // Convenient explicit "no title" spellings.
  if (text === "0" || text === "-") return "";
  return text;
}

var COUNTER_BAR_COLORS = {
  blue: true,
  red: true,
  green: true,
  yellow: true,
  purple: true,
  orange: true,
  white: true,
  // vanilla experience bar look
  xp: true
};

function normalizeCounterColor(value) {
  var color = String(value || "blue").trim().toLowerCase();
  return COUNTER_BAR_COLORS[color] ? color : "blue";
}

function counterColorIsValid(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return true;
  }
  return !!COUNTER_BAR_COLORS[String(value).trim().toLowerCase()];
}

function counterElapsedTicks() {
  var base = Math.max(
    0,
    Math.floor(Number(barConfig.pausedTicks) || 0)
  );

  if (!barConfig.running) return base;

  return base + Math.max(
    0,
    currentTick() - Math.floor(Number(barConfig.startedTick) || 0)
  );
}

function timerMessage(value, zeroMeansEmpty) {
  var text = String(value === undefined || value === null ? "" : value).trim();
  if (zeroMeansEmpty && text === "0") return "";
  return text;
}

function timerSoundSetting(value) {
  var text = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();

  if (text === "off" || text === "0" || text === "false") {
    return false;
  }

  return true;
}

// Optional trailing "digits" argument of the timer-driven commands:
//   (omitted) / on -> show the timer digits (default)
//   off            -> hide only the digits; the label becomes a bar title
function digitsSetting(value) {
  var text = String(
    value === undefined || value === null ? "" : value
  ).trim().toLowerCase();

  if (!text) return "";
  if (text === "off" || text === "hide" || text === "0" || text === "false") {
    return "off";
  }
  if (text === "on" || text === "show" || text === "1" || text === "true") {
    return "on";
  }
  return "invalid";
}

// In the timer-driven commands a message argument of 0 means "no message",
// the same way 0 means "no label". It lets later arguments be given.
function messageOrEmpty(value) {
  var text = String(
    value === undefined || value === null ? "" : value
  ).trim();
  return text === "0" ? "" : text;
}

// The clock on the HUD has four digits (mm:ss), so it can show 99:59 at most.
var CLOCK_MAX_SECONDS = 5999;

function clockLimitMessage(seconds) {
  return "The clock shows up to 99:59 (" + CLOCK_MAX_SECONDS + " seconds), but "
    + seconds + " was given. Use " + CLOCK_MAX_SECONDS
    + " or less, or hide the digits with off";
}

// Optional trailing "style" argument of the timer-driven commands:
//   (omitted) / boss -> boss bar look (default)
//   xp               -> vanilla experience bar look
function styleSetting(value) {
  var text = String(
    value === undefined || value === null ? "" : value
  ).trim().toLowerCase();

  if (!text) return "";
  if (text === "xp") return "xp";
  if (text === "boss" || text === "default" || text === "normal") return "boss";
  return "invalid";
}

function styleSettingIsValid(value) {
  return styleSetting(value) !== "invalid";
}

// Must run right after setBarConfig(), which resets the style.
function applyBarStyle(result, value) {
  if (styleSetting(value) !== "xp") return;
  if (!result || result.status !== CUSTOM_COMMAND_STATUS_SUCCESS) return;

  barConfig.barStyle = "xp";
  queueReusableBarStateSave();
}

function digitsSettingIsValid(value) {
  return digitsSetting(value) !== "invalid";
}

// Must run right after setBarConfig(), which resets digits to visible.
function applyTimerDigitsSetting(result, value) {
  if (digitsSetting(value) !== "off") return;
  if (!result || result.status !== CUSTOM_COMMAND_STATUS_SUCCESS) return;

  barConfig.timerDigitsVisible = false;
  queueReusableBarStateSave();
}

function timerLabel(value) {
  var text = String(value === undefined || value === null ? "" : value).trim();
  if (!text || text === "0") return "";

  // ':' is rendered by JSON UI using the exact timer-digit control.
  while (
    text.slice(-1) === ":"
    || text.slice(-1) === "："
  ) {
    text = text.slice(0, -1).trim();
  }

  if (!text) return "";
  return "§l" + text + "§r";
}

function sendTimerMessage(message) {
  var text = String(message || "").trim();
  if (!text) return;

  try {
    world.sendMessage(text);
  } catch (e) {}
}

var TIMER_EXECUTE_OBJECTIVES = {
  remaining: "rt_timer",
  elapsed: "rt_elapsed",
  total: "rt_total",
  percent: "rt_percent",
  running: "rt_running",
  paused: "rt_paused",
  finished: "rt_finished",
  run: "rt_run",

  // Legacy one-tick remaining-second event.
  event: "rt_event",

  // Unified event/state objectives.
  timeEvent: "rt_time_event",
  percentEvent: "rt_percent_event",
  barValue: "rt_bar",
  barMax: "rt_bar_max",
  barEvent: "rt_bar_event",
  finishEvent: "rt_finish_event"
};

var timerScoreboardWritePending = false;
var timerScoreboardPendingState = undefined;
var timerScoreboardWriteGeneration = 0;

var timerEventPreviousPercent = undefined;
var timerEventPreviousBarValue = undefined;
var eventPulseQueues = {};
var eventPulseBusy = {};
var eventPulseGeneration = 0;
var lastWrittenBarValue = undefined;
var lastWrittenBarMax = undefined;
var ratioSnapshotLastSaveTick = -1000;


function timerScoreboardState(state) {
  var source = state || barTimer.getState();

  return {
    remaining: Math.max(
      0,
      Math.floor(Number(source.remainingSeconds) || 0)
    ),
    elapsed: Math.max(
      0,
      Math.floor(Number(source.elapsedSeconds) || 0)
    ),
    total: Math.max(
      0,
      Math.floor(Number(source.totalSeconds) || 0)
    ),
    percent: Math.max(
      0,
      Math.min(
        100,
        Math.floor(Number(source.remainingPercent) || 0)
      )
    ),
    running: source.running ? 1 : 0,
    paused: source.paused ? 1 : 0,
    finished: source.finished ? 1 : 0,
    run: Math.max(
      0,
      Math.floor(Number(source.runId) || 0)
    )
  };
}

function getOrCreateTimerObjective(id, displayName) {
  return getCachedObjective(id, displayName);
}

function playerScoreKey(player) {
  try {
    return String(player.id);
  } catch (e) {}
  return "";
}

// Unchanged values are not written again (see reusable_score_writer.js).
function setPlayerObjectiveScore(objective, player, value) {
  if (!objective || !player) return;

  var key = playerScoreKey(player);

  // Use a real player ScoreboardIdentity.
  // Bedrock execute-if-score can then read the value using @p/@a/@s.
  var identity;
  try {
    identity = player.scoreboardIdentity;
  } catch (e) {}

  if (identity && writeScoreCached(objective, identity, key, value)) return;

  // Current stable API also accepts Entity directly.
  writeScoreCached(objective, player, key, value);
}

function writeTimerExecuteScoreboardNow(state) {
  // Normal source-driven counters own rt_bar/rt_timer through
  // writeCounterCommandStateNow(). Do not overwrite those mirrored values
  // with the unrelated reusable_timer engine.
  if (
    barKind(barConfig.mode) === "counter"
    && !isTimedCounterMode(barConfig.mode)
  ) {
    return false;
  }

  var values = timerScoreboardState(state);

  var objectives = {
    remaining: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.remaining,
      "RT Timer Remaining"
    ),
    elapsed: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.elapsed,
      "RT Timer Elapsed"
    ),
    total: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.total,
      "RT Timer Total"
    ),
    percent: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.percent,
      "RT Timer Percent"
    ),
    running: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.running,
      "RT Timer Running"
    ),
    paused: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.paused,
      "RT Timer Paused"
    ),
    finished: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.finished,
      "RT Timer Finished"
    ),
    run: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.run,
      "RT Timer Run"
    ),
    barValue: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.barValue,
      "RT Bar Value"
    ),
    barMax: getOrCreateTimerObjective(
      TIMER_EXECUTE_OBJECTIVES.barMax,
      "RT Bar Max"
    )
  };

  var barStateValue = (
    barConfig.mode === "time_countup"
    || barConfig.mode === "time_countdown"
  )
    ? compositeBarCurrentValue(state || barTimer.getState())
    : 0;
  var barStateMax = (
    barConfig.mode === "time_countup"
    || barConfig.mode === "time_countdown"
  )
    ? Math.max(1, Math.floor(Number(barConfig.maxValue) || 1))
    : 0;

  var players = allPlayers();

  for (var i = 0; i < players.length; i++) {
    var player = players[i];

    setPlayerObjectiveScore(
      objectives.remaining,
      player,
      values.remaining
    );
    setPlayerObjectiveScore(
      objectives.elapsed,
      player,
      values.elapsed
    );
    setPlayerObjectiveScore(
      objectives.total,
      player,
      values.total
    );
    setPlayerObjectiveScore(
      objectives.percent,
      player,
      values.percent
    );
    setPlayerObjectiveScore(
      objectives.running,
      player,
      values.running
    );
    setPlayerObjectiveScore(
      objectives.paused,
      player,
      values.paused
    );
    setPlayerObjectiveScore(
      objectives.finished,
      player,
      values.finished
    );
    setPlayerObjectiveScore(
      objectives.run,
      player,
      values.run
    );
    setPlayerObjectiveScore(
      objectives.barValue,
      player,
      barStateValue
    );
    setPlayerObjectiveScore(
      objectives.barMax,
      player,
      barStateMax
    );
  }

  return players.length > 0;
}

function setEventObjectiveValue(objectiveId, displayName, value) {
  var objective = getOrCreateTimerObjective(
    objectiveId,
    displayName
  );
  if (!objective) return;

  var players = allPlayers();

  for (var i = 0; i < players.length; i++) {
    setPlayerObjectiveScore(
      objective,
      players[i],
      value
    );
  }
}

function runEventPulseQueue(objectiveId, displayName, resetValue) {
  if (eventPulseBusy[objectiveId] !== undefined) return;

  var queue = eventPulseQueues[objectiveId] || [];
  if (queue.length <= 0) return;

  var generation = eventPulseGeneration;
  eventPulseBusy[objectiveId] = generation;

  function releaseBusyIfOwned() {
    if (eventPulseBusy[objectiveId] === generation) {
      delete eventPulseBusy[objectiveId];
    }
  }

  function nextPulse() {
    // Reconfiguration/reset invalidates every scheduled old pulse.
    // An old generation must never unlock a newer generation's queue.
    if (generation !== eventPulseGeneration) {
      releaseBusyIfOwned();
      return;
    }

    var currentQueue = eventPulseQueues[objectiveId] || [];

    if (currentQueue.length <= 0) {
      setEventObjectiveValue(
        objectiveId,
        displayName,
        resetValue
      );
      releaseBusyIfOwned();
      return;
    }

    var value = currentQueue.shift();

    setEventObjectiveValue(
      objectiveId,
      displayName,
      value
    );

    system.runTimeout(function () {
      if (generation !== eventPulseGeneration) {
        releaseBusyIfOwned();
        return;
      }

      setEventObjectiveValue(
        objectiveId,
        displayName,
        resetValue
      );

      system.runTimeout(nextPulse, 1);
    }, 1);
  }

  nextPulse();
}

function queueEventValues(
  objectiveId,
  displayName,
  values,
  resetValue
) {
  var list = Array.isArray(values) ? values : [values];

  if (!eventPulseQueues[objectiveId]) {
    eventPulseQueues[objectiveId] = [];
  }

  for (var i = 0; i < list.length; i++) {
    var number = Math.floor(Number(list[i]));
    if (!isFinite(number)) continue;
    eventPulseQueues[objectiveId].push(number);
  }

  runEventPulseQueue(
    objectiveId,
    displayName,
    resetValue === undefined ? -1 : resetValue
  );
}

function displayedTimerSecond(state) {
  var source = state || barTimer.getState();

  if (barConfig.timerDirection === "up") {
    return Math.max(
      0,
      Math.floor(Number(source.elapsedSeconds) || 0)
    );
  }

  return Math.max(
    0,
    Math.floor(Number(source.remainingSeconds) || 0)
  );
}

function clearUnifiedEventPulses() {
  eventPulseGeneration += 1;
  eventPulseQueues = {};
  eventPulseBusy = {};

  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.event,
    "RT Timer Event",
    -1
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.timeEvent,
    "RT Time Event",
    -1
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.percentEvent,
    "RT Percent Event",
    -1
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.barEvent,
    "RT Bar Event",
    -1
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.finishEvent,
    "RT Finish Event",
    0
  );
}

function resetUnifiedEventTracking(state) {
  var source = state || barTimer.getState();

  clearUnifiedEventPulses();

  timerEventPreviousPercent = Math.max(
    0,
    Math.min(
      100,
      Math.floor(Number(source.remainingPercent) || 0)
    )
  );

  if (
    barConfig.mode === "time_countup"
    || barConfig.mode === "time_countdown"
  ) {
    timerEventPreviousBarValue = compositeBarCurrentValue(source);
  } else {
    timerEventPreviousBarValue = undefined;
  }

  lastWrittenBarValue = undefined;
  lastWrittenBarMax = undefined;
  pulseCounterClockEvent.previous = undefined;
  pulseRatioClockEvent.previous = undefined;
}


function processPercentThresholdEvents(state) {
  var source = state || barTimer.getState();
  var current = Math.max(
    0,
    Math.min(
      100,
      Math.floor(Number(source.remainingPercent) || 0)
    )
  );

  if (timerEventPreviousPercent === undefined) {
    timerEventPreviousPercent = current;
    return;
  }

  var previous = timerEventPreviousPercent;
  timerEventPreviousPercent = current;

  if (current >= previous) return;

  var crossed = [];
  for (var threshold = 90; threshold >= 0; threshold -= 10) {
    if (previous > threshold && current <= threshold) {
      crossed.push(threshold);
    }
  }

  if (crossed.length > 0) {
    queueEventValues(
      TIMER_EXECUTE_OBJECTIVES.percentEvent,
      "RT Percent Event",
      crossed,
      -1
    );
  }
}

function crossedIntegerValues(previous, current) {
  if (previous === undefined || current === undefined) return [];
  if (previous === current) return [];

  var out = [];

  if (current > previous) {
    for (var value = previous + 1; value <= current; value++) {
      out.push(value);
    }
  } else {
    for (var down = previous - 1; down >= current; down--) {
      out.push(down);
    }
  }

  return out;
}

function writeCompositeBarStateNow(state) {
  var source = state || barTimer.getState();

  if (
    barConfig.mode !== "time_countup"
    && barConfig.mode !== "time_countdown"
  ) {
    return;
  }

  var current = compositeBarCurrentValue(source);
  var maximum = Math.max(
    1,
    Math.floor(Number(barConfig.maxValue) || 1)
  );

  if (lastWrittenBarValue !== current) {
    setEventObjectiveValue(
      TIMER_EXECUTE_OBJECTIVES.barValue,
      "RT Bar Value",
      current
    );
    lastWrittenBarValue = current;
  }

  if (lastWrittenBarMax !== maximum) {
    setEventObjectiveValue(
      TIMER_EXECUTE_OBJECTIVES.barMax,
      "RT Bar Max",
      maximum
    );
    lastWrittenBarMax = maximum;
  }

  if (timerEventPreviousBarValue === undefined) {
    timerEventPreviousBarValue = current;
    return;
  }

  var crossed = crossedIntegerValues(
    timerEventPreviousBarValue,
    current
  );
  timerEventPreviousBarValue = current;

  if (crossed.length > 0) {
    queueEventValues(
      TIMER_EXECUTE_OBJECTIVES.barEvent,
      "RT Bar Event",
      crossed,
      -1
    );
  }
}

function writeCounterCommandStateNow(counterState) {
  var state = counterState || {};
  if (state.kind !== "counter") return false;

  var current = Math.max(
    0,
    Math.floor(Number(state.displayValue) || 0)
  );
  var maximum = Math.max(
    1,
    Math.floor(Number(state.max) || 1)
  );

  // rt_bar always mirrors the number the player sees for the bar.
  // countup:   0 -> max
  // countdown: max -> 0
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.barValue,
    "RT Bar Value",
    current
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.barMax,
    "RT Bar Max",
    maximum
  );

  if (timerEventPreviousBarValue === undefined) {
    timerEventPreviousBarValue = current;

    // Treat the visible start value as a one-shot event too.
    // Configuration-time draws do not fire because barConfig.running is false.
    if (barConfig.running) {
      queueEventValues(
        TIMER_EXECUTE_OBJECTIVES.barEvent,
        "RT Bar Event",
        current,
        -1
      );
    }
  } else {
    var crossed = crossedIntegerValues(
      timerEventPreviousBarValue,
      current
    );
    timerEventPreviousBarValue = current;

    if (crossed.length > 0) {
      queueEventValues(
        TIMER_EXECUTE_OBJECTIVES.barEvent,
        "RT Bar Event",
        crossed,
        -1
      );
    }
  }

  lastWrittenBarValue = current;
  lastWrittenBarMax = maximum;

  // If this counter is displaying d60/a60, rt_timer mirrors the exact
  // displayed clock number as well. This keeps command-block checks aligned
  // with the HUD instead of exposing the separate reusable_timer engine.
  var hasClock = String(state.displayMode || "") === "timer";
  var clockValue = hasClock
    ? Math.max(0, Math.floor(Number(state.clockSeconds) || 0))
    : 0;
  var clockLimit = hasClock
    ? Math.max(1, Math.floor(Number(state.clockLimitSeconds) || 1))
    : 0;
  var elapsed = hasClock
    ? Math.max(0, Math.floor(Number(state.elapsedSeconds) || 0))
    : 0;
  var running = hasClock && barConfig.running ? 1 : 0;
  var finished = 0;

  if (hasClock) {
    if (String(state.clockDirection || "") === "down") {
      finished = clockValue <= 0 ? 1 : 0;
    } else {
      finished = clockValue >= clockLimit ? 1 : 0;
    }
  }

  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.remaining,
    "RT Timer Display",
    clockValue
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.elapsed,
    "RT Timer Elapsed",
    elapsed
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.total,
    "RT Timer Total",
    clockLimit
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.running,
    "RT Timer Running",
    running
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.finished,
    "RT Timer Finished",
    finished
  );

  return true;
}

function writeRatioTimerCommandStateNow(ratioState) {
  var state = ratioState || {};
  if (state.kind !== "ratio") return false;

  var enabled = !!state.timerEnabled;
  var current = enabled
    ? Math.max(0, Math.floor(Number(state.clockSeconds) || 0))
    : 0;
  var elapsed = enabled
    ? Math.max(0, Math.floor(Number(state.elapsedSeconds) || 0))
    : 0;
  var total = enabled
    ? Math.max(0, Math.floor(Number(state.timerSeconds) || 0))
    : 0;

  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.remaining,
    "RT Timer Remaining",
    current
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.elapsed,
    "RT Timer Elapsed",
    elapsed
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.total,
    "RT Timer Total",
    total
  );
  setEventObjectiveValue(
    TIMER_EXECUTE_OBJECTIVES.running,
    "RT Timer Running",
    enabled && barConfig.running && current > 0 ? 1 : 0
  );

  return true;
}

function pulseRatioClockEvent(ratioState) {
  var state = ratioState || {};

  if (
    state.kind !== "ratio"
    || !state.timerEnabled
  ) {
    pulseRatioClockEvent.previous = undefined;
    return;
  }

  var current = Math.max(
    0,
    Math.floor(Number(state.clockSeconds) || 0)
  );

  if (pulseRatioClockEvent.previous === undefined) {
    pulseRatioClockEvent.previous = current;

    // The configured start second is also a one-shot event on /rt:play.
    if (barConfig.running) {
      queueEventValues(
        TIMER_EXECUTE_OBJECTIVES.timeEvent,
        "RT Time Event",
        current,
        -1
      );
    }
    return;
  }

  var crossed = crossedIntegerValues(
    pulseRatioClockEvent.previous,
    current
  );
  pulseRatioClockEvent.previous = current;

  if (crossed.length > 0) {
    queueEventValues(
      TIMER_EXECUTE_OBJECTIVES.timeEvent,
      "RT Time Event",
      crossed,
      -1
    );
  }
}
pulseRatioClockEvent.previous = undefined;

function pulseCounterClockEvent(counterState) {
  var state = counterState || {};
  if (String(state.displayMode || "") !== "timer") return;

  var current = Math.max(
    0,
    Math.floor(Number(state.clockSeconds) || 0)
  );

  if (pulseCounterClockEvent.previous === undefined) {
    pulseCounterClockEvent.previous = current;

    // /rt:play start value is a real one-shot event.
    // Pre-start/configuration draws are ignored.
    if (barConfig.running) {
      queueEventValues(
        TIMER_EXECUTE_OBJECTIVES.timeEvent,
        "RT Time Event",
        current,
        -1
      );
    }
    return;
  }

  var crossed = crossedIntegerValues(
    pulseCounterClockEvent.previous,
    current
  );
  pulseCounterClockEvent.previous = current;

  if (crossed.length > 0) {
    queueEventValues(
      TIMER_EXECUTE_OBJECTIVES.timeEvent,
      "RT Time Event",
      crossed,
      -1
    );
  }
}
pulseCounterClockEvent.previous = undefined;

function pulseDisplayedTimeEvent(state) {
  queueEventValues(
    TIMER_EXECUTE_OBJECTIVES.timeEvent,
    "RT Time Event",
    displayedTimerSecond(state),
    -1
  );
}

function pulseFinishEvent() {
  queueEventValues(
    TIMER_EXECUTE_OBJECTIVES.finishEvent,
    "RT Finish Event",
    1,
    0
  );
}

function clearReusableBarCommandScoresNow() {
  clearUnifiedEventPulses();
  clearScoreWriteCache();

  var zeroObjectives = [
    [TIMER_EXECUTE_OBJECTIVES.remaining, "RT Timer Remaining"],
    [TIMER_EXECUTE_OBJECTIVES.elapsed, "RT Timer Elapsed"],
    [TIMER_EXECUTE_OBJECTIVES.total, "RT Timer Total"],
    [TIMER_EXECUTE_OBJECTIVES.percent, "RT Timer Percent"],
    [TIMER_EXECUTE_OBJECTIVES.running, "RT Timer Running"],
    [TIMER_EXECUTE_OBJECTIVES.paused, "RT Timer Paused"],
    [TIMER_EXECUTE_OBJECTIVES.finished, "RT Timer Finished"],
    [TIMER_EXECUTE_OBJECTIVES.run, "RT Timer Run"],
    [TIMER_EXECUTE_OBJECTIVES.barValue, "RT Bar Value"],
    [TIMER_EXECUTE_OBJECTIVES.barMax, "RT Bar Max"]
  ];

  for (var i = 0; i < zeroObjectives.length; i++) {
    setEventObjectiveValue(
      zeroObjectives[i][0],
      zeroObjectives[i][1],
      0
    );
  }

  lastWrittenBarValue = 0;
  lastWrittenBarMax = 0;
  timerEventPreviousPercent = undefined;
  timerEventPreviousBarValue = undefined;
}

export function clearReusableBarCommandScores() {
  system.run(function () {
    clearReusableBarCommandScoresNow();
  });
}

function prepareBarForReconfigure() {
  var replacingRatio = barKind(barConfig.mode) === "ratio";

  // Stop visual updates and pause any previous timer before replacing config.
  // This prevents old timer callbacks and queued events from leaking into
  // the newly configured game.
  stopBarLoop();

  try {
    if (isTimedBarMode(barConfig.mode)) {
      barTimer.pause();
    }
  } catch (e) {}

  barConfig.running = false;
  barConfig.roundParticipants = [];

  // barTimer.pause() above may have queued a deferred scoreboard write from
  // the old mode. Invalidate it before clearing/writing the new mode.
  invalidateTimerScoreboardWrites();
  resetUnifiedEventTracking(barTimer.getState());

  // A new mode must never inherit state objectives from the previous mode.
  // setBarConfig is invoked in normal system execution, so clear synchronously
  // before the newly configured renderer writes its own state.
  clearReusableBarCommandScoresNow();

  if (replacingRatio) {
    clearRatioCommandBridge();
  }
}

function writeTimerRemainingImmediately(state) {
  var values = timerScoreboardState(state);
  var objective = getOrCreateTimerObjective(
    TIMER_EXECUTE_OBJECTIVES.remaining,
    "RT Timer Remaining"
  );

  if (!objective) return false;

  var players = allPlayers();
  for (var i = 0; i < players.length; i++) {
    setPlayerObjectiveScore(
      objective,
      players[i],
      values.remaining
    );
  }

  return players.length > 0;
}

function pulseTimerSecondEvent(state) {
  var values = timerScoreboardState(state);

  queueEventValues(
    TIMER_EXECUTE_OBJECTIVES.event,
    "RT Timer Event",
    values.remaining,
    -1
  );
}


// Writes are deferred out of restricted command/event contexts.
// Multiple changes in the same tick are coalesced to the latest state.
function invalidateTimerScoreboardWrites() {
  // Any already-scheduled callback belongs to an older mode/configuration.
  // It must not be allowed to overwrite the new mode on the next tick.
  timerScoreboardWriteGeneration += 1;
  timerScoreboardPendingState = undefined;
  timerScoreboardWritePending = false;
}

function syncTimerExecuteScoreboard(state) {
  timerScoreboardPendingState = state || barTimer.getState();

  if (timerScoreboardWritePending) return;
  timerScoreboardWritePending = true;
  var myGeneration = timerScoreboardWriteGeneration;

  system.run(function () {
    if (myGeneration !== timerScoreboardWriteGeneration) {
      return;
    }

    timerScoreboardWritePending = false;

    var latest = timerScoreboardPendingState;
    timerScoreboardPendingState = undefined;

    writeTimerExecuteScoreboardNow(
      latest || barTimer.getState()
    );
  });
}

export function syncReusableTimerScoreboard() {
  syncTimerExecuteScoreboard(barTimer.getState());
}

function registerTimerApiHooks() {
  if (timerApiHooksRegistered) return;
  timerApiHooksRegistered = true;

  barTimer.onConfigure(function (event) {
    resetUnifiedEventTracking(event);
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }
    queueReusableBarStateSave();
  });

  barTimer.onStart(function (event) {
    barConfig.running = true;
    queueReusableBarStateSave();
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }

    barConfig.timerEndMessageSent = false;
    barConfig.lastCountdownSoundSecond = -1;
    barConfig.timerFinishSoundSent = false;

    sendTimerMessage(barConfig.timerStartMessage);
  });

  barTimer.onResume(function (event) {
    barConfig.running = true;
    queueReusableBarStateSave();
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }
  });

  barTimer.onPause(function (event) {
    barConfig.running = false;
    queueReusableBarStateSave();
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }
  });

  // Countdown sound is now just one consumer of the public onSecond API.
  barTimer.onSecond(function (event) {
    // Persist progress once per visible second.
    queueReusableBarStateSave();
    // Important: HUD and rt_timer must change in the same timer tick.
    // The old implementation deferred rt_timer by system.run(), leaving
    // one tick where HUD showed 9 but scoreboard still contained 10.
    writeTimerRemainingImmediately(event);
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }

    // Legacy remaining-second event.
    pulseTimerSecondEvent(event);

    // Unified one-shot events.
    pulseDisplayedTimeEvent(event);
    processPercentThresholdEvents(event);
  });

  barTimer.onFinish(function (event) {
    barConfig.running = false;
    queueReusableBarStateSave();
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }
    processPercentThresholdEvents(event);
    writeCompositeBarStateNow(event);
    pulseFinishEvent();

    if (!barConfig.timerEndMessageSent) {
      barConfig.timerEndMessageSent = true;
      sendTimerMessage(barConfig.timerEndMessage);
    }

    stopBarLoop();

    // Make sure HUD receives the final 00:00 state.
    system.run(function () {
      updateBar({ force: true });
    });
  });

  barTimer.onStop(function (event) {
    barConfig.running = false;
    queueReusableBarStateSave();
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }
  });

  barTimer.onReset(function (event) {
    barConfig.running = false;
    queueReusableBarStateSave();
    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(event);
    }
  });
}

registerTimerApiHooks();

system.run(function () {
  if (isTimedBarMode(barConfig.mode)) {
    syncTimerExecuteScoreboard(barTimer.getState());
  }
});

function normalizedMode(mode) {
  var text = String(mode || "").toLowerCase();

  // Existing scoreboard-driven counter bars.
  if (text === "down" || text === "countdown" || text === "countdoun") {
    return "countdown";
  }
  if (text === "up" || text === "countup") {
    return "countup";
  }

  // New timer-driven progress bars.
  if (
    text === "countdownbar"
    || text === "timedown"
    || text === "timecountdown"
    || text === "time_countdown"
  ) {
    return "time_countdown";
  }
  if (
    text === "countupbar"
    || text === "timeup"
    || text === "timecountup"
    || text === "time_countup"
  ) {
    return "time_countup";
  }

  if (text === "account" || text === "ratio" || text === "score") {
    return "ratio";
  }
  if (text === "time" || text === "timer") return "timer";
  return "";
}

function isTimedBarMode(mode) {
  return (
    mode === "timer"
    || mode === "time_countdown"
    || mode === "time_countup"
  );
}

function maxNumber(value, fallbackValue) {
  return Math.max(1, Math.floor(Number(value) || fallbackValue || 1));
}

function teamCount(value) {
  return Math.max(1, Math.min(8, Math.floor(Number(value) || 4)));
}

function stopBarLoop() {
  if (barRuntimeHandle === undefined) return;

  try {
    system.clearRun(barRuntimeHandle);
  } catch (e) {}

  barRuntimeHandle = undefined;
  barRuntimeIntervalTicks = 0;
}


function clearBarForPlayers(players) {
  var list = players || [];
  for (var i = 0; i < list.length; i++) {
    clearReusableHud(list[i], false);
  }
}




function compositeTimerDirection(value) {
  return String(value || "").toLowerCase() === "up" ? "up" : "down";
}

function compositeBarMode(value) {
  var text = String(value || "").toLowerCase();
  if (text === "up" || text === "countup") return "time_countup";
  if (text === "down" || text === "countdown") return "time_countdown";
  return "";
}

function compositeBarCurrentValue(timerState) {
  // Returns the current bar step as a NUMBER (0..max).
  //   countdownbar: max -> 0   (ceil, so it drops once per step)
  //   countupbar  : 0 -> max   (floor, so it rises once per step)
  var state = timerState || barTimer.getState();
  var maxValue = Math.max(
    1,
    Math.floor(Number(barConfig.maxValue) || 1)
  );
  var totalTicks = Math.max(
    1,
    Number(state.totalTicks) || 1
  );
  var elapsedTicks = Math.max(
    0,
    Math.min(totalTicks, Number(state.elapsedTicks) || 0)
  );
  var remainingTicks = Math.max(
    0,
    Math.min(totalTicks, Number(state.remainingTicks) || 0)
  );

  var value;
  if (barConfig.mode === "time_countup") {
    value = Math.floor((elapsedTicks / totalTicks) * maxValue + 1e-9);
  } else {
    value = Math.ceil((remainingTicks / totalTicks) * maxValue - 1e-9);
  }

  return Math.max(0, Math.min(maxValue, value));
}

function compositeBarTiming(timerState) {
  var current = compositeBarCurrentValue(timerState);
  var maxValue = Math.max(
    1,
    Math.floor(Number(barConfig.maxValue) || 1)
  );

  // Reuse the existing time-bar renderer with "20 ticks per logical unit".
  // This makes the configured max value affect the bar in real discrete steps.
  if (barConfig.mode === "time_countup") {
    return {
      elapsedTicks: current * 20,
      remainingTicks: (maxValue - current) * 20,
      totalTicks: maxValue * 20
    };
  }

  return {
    elapsedTicks: (maxValue - current) * 20,
    remainingTicks: current * 20,
    totalTicks: maxValue * 20
  };
}

function compositeTimerTiming(timerState) {
  var state = timerState || barTimer.getState();

  return {
    elapsedTicks: Math.max(0, Number(state.elapsedTicks) || 0),
    remainingTicks: Math.max(0, Number(state.remainingTicks) || 0),
    totalTicks: Math.max(1, Number(state.totalTicks) || 1)
  };
}

function configureCompositeTimedBar(
  barMode,
  maxValue,
  label,
  startMessage,
  endMessage,
  timerDirection,
  timerSeconds
) {
  var mode = compositeBarMode(barMode);
  if (!mode) {
    return commandFailure("Use up or down");
  }

  var max = Math.max(
    1,
    Math.floor(Number(maxValue) || 1)
  );
  var seconds = Math.max(
    1,
    Math.floor(Number(timerSeconds) || 1)
  );

  prepareBarForReconfigure();
  resetCounterDisplayConfig();

  barConfig.mode = mode;
  barConfig.source = "";
  barConfig.maxValue = max;
  barConfig.teamCount = 4;
  barConfig.ratioTeams = "red_blue_yellow_green";
  barConfig.ratioTitle = "";
  barConfig.ratioSeconds = 0;
  barConfig.running = false;
  barConfig.startedTick = 0;
  barConfig.pausedTicks = 0;

  barConfig.timerLabel = timerLabel(label);
  barConfig.timerStartMessage = timerMessage(startMessage, true);
  barConfig.timerEndMessage = timerMessage(endMessage, false);
  barConfig.timerEndMessageSent = false;

  // The new grammar currently has no sound argument.
  // Keep composite bars silent unless a later syntax adds it explicitly.
  barConfig.timerSoundEnabled = false;
  barConfig.lastCountdownSoundSecond = -1;
  barConfig.timerFinishSoundSent = false;

  barConfig.timerDirection = compositeTimerDirection(timerDirection);
  barConfig.timerSeconds = seconds;
  barConfig.timerVisible = true;
  barConfig.timerDigitsVisible = true;
  barConfig.barStyle = "";

  barTimer.configure({
    seconds: seconds
  });

  stopBarLoop();

  system.run(function () {
    updateBar({ force: true });
  });

  queueReusableBarStateSave();
  return commandSuccess();
}

function positiveIntegerCommandValue(value, label) {
  var number = Math.floor(Number(value));

  if (!isFinite(number) || number <= 0) {
    return {
      ok: false,
      message: String(label || "Value") + " must be 1 or more"
    };
  }

  return {
    ok: true,
    value: number
  };
}

function updateTimedProgressBar(players, options) {
  var opts = options || {};
  var timerState = barTimer.getState();

  // Scoreboard/event integration stays in the command controller.
  // Visual rendering belongs to the counter family module.
  writeCompositeBarStateNow(timerState);

  updateLegacyTimedProgressHud(
    players,
    barConfig,
    compositeBarTiming(timerState),
    compositeTimerTiming(timerState),
    opts
  );

  if (timerState.finished) {
    stopBarLoop();
  }
}

// The HUD is only sent when it changes. If something else clears or replaces
// the title (a /title command, a death screen ...), the bar would stay hidden
// until its value changes, so every few seconds it is sent again.
var HUD_REFRESH_TICKS = 100;
var lastHudRefreshTick = -1;

function refreshHudIfDue(list) {
  var tick = 0;
  try {
    tick = system.currentTick;
  } catch (e) {}

  if (lastHudRefreshTick >= 0 && tick - lastHudRefreshTick < HUD_REFRESH_TICKS && tick >= lastHudRefreshTick) {
    return;
  }
  lastHudRefreshTick = tick;

  for (var i = 0; i < list.length; i++) {
    try {
      syncReusableHud(list[i]);
    } catch (e2) {}
  }
}

function updateBarForPlayers(players, options) {
  var list = Array.isArray(players) ? players : [];
  var kind = barKind(barConfig.mode);

  // Ratio state also drives fake-player command bridge objectives.
  // It must still update when zero real players are online (for example when
  // the last player leaves), even though there is no HUD target to draw.
  if (list.length <= 0 && kind !== "ratio") return;

  if (kind === "ratio") {
    var ratioOptions = {};
    var ratioSourceOptions = options || {};
    for (var ratioKey in ratioSourceOptions) {
      ratioOptions[ratioKey] = ratioSourceOptions[ratioKey];
    }

    // Ratio totals are global. A one-player HUD resync must not temporarily
    // replace the shared command-bridge values with that player's data only.
    var ratioAggregatePlayers = allPlayers();

    // Initialize newly eligible players before reading the live ratio. This
    // handles both true mid-round joins and team tags added after /rt:play.
    ensureLiveRatioParticipants(ratioAggregatePlayers);

    ratioOptions.aggregatePlayers = ratioAggregatePlayers;

    var ratioState = updateRatioBar(
      list,
      barConfig,
      ratioOptions
    );

    // Persist ratio snapshots at most once per visible second.
    // This includes PRE-PLAY equal splits, so closing the world before
    // /rt:play still restores the exact multi-color bar on next load.
    if (
      (
        barConfig.running
        || (
          !barConfig.ratioHasStarted
          && !barConfig.ratioRestoreHold
        )
      )
      && currentTick() - ratioSnapshotLastSaveTick >= 20
    ) {
      ratioSnapshotLastSaveTick = currentTick();
      queueReusableBarStateSave();
    }

    writeRatioTimerCommandStateNow(ratioState);
    pulseRatioClockEvent(ratioState);
    return;
  }

  if (kind === "timer") {
    var timerState = updateTimerHud(list, barConfig, options);
    if (
      timerState
      && (timerState.finished || timerState.remainingTicks <= 0)
    ) {
      stopBarLoop();
    }
    return;
  }

  if (kind === "counter") {
    if (isTimedCounterMode(barConfig.mode)) {
      updateTimedProgressBar(list, options);
    } else {
      var counterOptions = {};
      var counterSourceOptions = options || {};
      for (var counterKey in counterSourceOptions) {
        counterOptions[counterKey] = counterSourceOptions[counterKey];
      }
      counterOptions.aggregatePlayers = allPlayers();

      var counterState = updateCounterBar(
        list,
        barConfig,
        counterOptions
      );
      writeCounterCommandStateNow(counterState);
      pulseCounterClockEvent(counterState);
    }
  }
}

function updateBar(options) {
  var players = allPlayers();
  updateBarForPlayers(players, options);

  // Only while a bar is set: put a hidden or replaced HUD back.
  if (barConfig.mode) refreshHudIfDue(players);
}

export function syncReusableBarPlayer(player) {
  if (!player || !barConfig.mode) return false;

  updateBarForPlayers(
    [player],
    { force: true }
  );

  // State scores are mirrored to all online players. Normal counters already
  // write their command bridge during updateBarForPlayers(); timed modes use
  // the reusable timer bridge.
  if (
    barKind(barConfig.mode) !== "counter"
    && barKind(barConfig.mode) !== "ratio"
  ) {
    syncTimerExecuteScoreboard(barTimer.getState());
  } else if (
    barKind(barConfig.mode) === "counter"
    && isTimedCounterMode(barConfig.mode)
  ) {
    syncTimerExecuteScoreboard(barTimer.getState());
  }
  return true;
}

function startBarLoop(options) {
  var opts = {};
  var source = options || {};
  for (var key in source) {
    opts[key] = source[key];
  }
  opts.force = true;
  var sourceDrivenStatMode = (
    (
      barConfig.mode === "countup"
      || barConfig.mode === "countdown"
    )
    && isReusableStatSource(barConfig.source)
  );

  var defaultInterval = sourceDrivenStatMode
    ? 2
    : (
        (
          barConfig.mode === "time_countdown"
          || barConfig.mode === "time_countup"
        )
          ? 4
          : (barConfig.mode === "timer" ? 20 : 10)
      );
  var intervalTicks = Math.max(
    1,
    Math.floor(Number(opts.intervalTicks) || defaultInterval)
  );

  stopBarLoop();
  barRuntimeIntervalTicks = intervalTicks;
  barRuntimeHandle = system.runInterval(function () {
    opts.force = false;
    updateBar(opts);
  }, intervalTicks);
  updateBar(opts);
}

function resetCounterDisplayConfig() {
  barConfig.counterTitle = "";
  barConfig.counterDisplay = "none";
  barConfig.counterColor = "blue";
  barConfig.counterBaseline = 0;
  barConfig.counterBaselineReady = false;
  barConfig.counterLastCurrent = 0;
  barConfig.startedTick = 0;
  barConfig.pausedTicks = 0;
}

function setBarConfig(args) {
  var mode = normalizedMode(args[1]);
  if (!mode) return commandFailure("Use /rt:countdown|countup|ratio|timer ...");

  prepareBarForReconfigure();

  if (mode === "timer") {
    resetCounterDisplayConfig();
    barConfig.mode = "timer";
    barConfig.source = "";
    barConfig.maxValue = maxNumber(args[2], 60);
    barConfig.teamCount = 4;
    barConfig.ratioTeams = "red_blue_yellow_green";
    barConfig.running = false;
    barConfig.startedTick = 0;
    barConfig.pausedTicks = 0;

    // /rt:bar set timer <seconds> <label> <startMessage> <endMessage>
    barConfig.timerSoundEnabled = false;
    barConfig.timerLabel = timerLabel(args[4]);
    barConfig.timerStartMessage = timerMessage(args[5], true);
    barConfig.timerEndMessage = timerMessage(args[6], false);
    barConfig.timerEndMessageSent = false;
    barConfig.lastCountdownSoundSecond = -1;
    barConfig.timerFinishSoundSent = false;
    barConfig.timerDirection = (
      mode === "time_countup" ? "up" : "down"
    );
    barConfig.timerSeconds = barConfig.maxValue;
    barConfig.timerVisible = true;
    barConfig.timerDigitsVisible = true;
    barConfig.barStyle = "";

    barTimer.configure({
      seconds: barConfig.timerSeconds
    });

    stopBarLoop();
    system.run(function () {
      updateBar({ force: true });
    });

    // "bar set" itself should be silent.
    queueReusableBarStateSave();
    return commandSuccess();
  }

  if (mode === "time_countdown" || mode === "time_countup") {
    resetCounterDisplayConfig();
    barConfig.mode = mode;
    barConfig.source = "";
    barConfig.maxValue = maxNumber(args[2], 60);
    barConfig.teamCount = 4;
    barConfig.ratioTeams = "red_blue_yellow_green";
    barConfig.running = false;
    barConfig.startedTick = 0;
    barConfig.pausedTicks = 0;

    // /rt:countdownbar <seconds> [label]
    // /rt:countupbar   <seconds> [label]
    barConfig.timerLabel = timerLabel(args[3]);
    barConfig.timerStartMessage = "";
    barConfig.timerEndMessage = "";
    barConfig.timerEndMessageSent = false;

    // Progress bars are intentionally silent by default.
    barConfig.timerSoundEnabled = false;
    barConfig.lastCountdownSoundSecond = -1;
    barConfig.timerFinishSoundSent = false;
    barConfig.timerDirection = "down";
    barConfig.timerSeconds = barConfig.maxValue;
    barConfig.timerVisible = true;
    barConfig.timerDigitsVisible = true;
    barConfig.barStyle = "";

    barTimer.configure({
      seconds: barConfig.timerSeconds
    });

    stopBarLoop();
    system.run(function () {
      updateBar({ force: true });
    });

    queueReusableBarStateSave();
    return commandSuccess();
  }

  if (mode === "ratio") {
    if (!args[2]) return commandFailure(
      "Use /rt:ratio <scoreboard> <teams> <title> [seconds]"
    );

    var selectedRatioTeams = parseRatioTeamSelection(args[3]);
    if (selectedRatioTeams.length <= 0) {
      return commandFailure(
        "Teams: red_blue_yellow_green_cyan_purple_orange_pink"
      );
    }

    resetCounterDisplayConfig();
    barConfig.mode = "ratio";
    barConfig.source = args[2];
    barConfig.maxValue = 0;
    barConfig.ratioTeams = selectedRatioTeams.join("_");
    barConfig.teamCount = selectedRatioTeams.length;
    barConfig.ratioTitle = normalizeCounterTitle(args[4]);
    barConfig.ratioSeconds = Math.max(
      0,
      Math.floor(Number(args[5]) || 0)
    );
    barConfig.ratioHasStarted = false;
    barConfig.ratioLastDisplayValues = [];
    barConfig.ratioLastPresence = [];
    barConfig.ratioLastValues = [];
    barConfig.ratioRestoreHold = false;
    barConfig.running = false;
    barConfig.startedTick = 0;
    barConfig.pausedTicks = 0;
    barConfig.timerLabel = "";
    barConfig.timerStartMessage = "";
    barConfig.timerEndMessage = "";
    barConfig.timerEndMessageSent = false;
    barConfig.timerSoundEnabled = false;
    barConfig.lastCountdownSoundSecond = -1;
    barConfig.timerFinishSoundSent = false;
    barTimer.stop();
    stopBarLoop();

    // Ratio setup remains live before /rt:play so adding/removing team tags
    // immediately updates the equal pre-start color split.
    system.run(function () {
      startBarLoop({ force: true });
    });

    queueReusableBarStateSave();
    return commandSuccess();
  }

  if (!args[2]) return commandFailure(
    "Use /rt:" + mode + " <scoreboard> <max> <title> <display> [color]"
  );
  barConfig.mode = mode;
  barConfig.source = args[2];
  barConfig.maxValue = maxNumber(args[3], 100);
  barConfig.teamCount = 4;
  barConfig.ratioTeams = "red_blue_yellow_green";
  barConfig.ratioTitle = "";
  barConfig.ratioSeconds = 0;
  barConfig.ratioHasStarted = false;
  barConfig.ratioLastDisplayValues = [];
  barConfig.ratioLastPresence = [];
  barConfig.ratioLastValues = [];
  barConfig.ratioRestoreHold = false;
  barConfig.running = false;
  barConfig.startedTick = 0;
  barConfig.pausedTicks = 0;
  barConfig.counterTitle = normalizeCounterTitle(args[4]);
  barConfig.counterDisplay = normalizeCounterDisplay(args[5]);
  barConfig.counterColor = normalizeCounterColor(args[6]);
  // Do not read the source yet. Before /rt:play the visual is always at its
  // defined start position: countup=0%, countdown=100%.
  // /rt:play will reset the actual configured source to 0.
  barConfig.counterBaseline = 0;
  barConfig.counterBaselineReady = false;
  barConfig.counterLastCurrent = 0;
  barConfig.timerLabel = "";
  barConfig.timerStartMessage = "";
  barConfig.timerEndMessage = "";
  barConfig.timerEndMessageSent = false;
  barConfig.timerSoundEnabled = false;
  barConfig.lastCountdownSoundSecond = -1;
  barConfig.timerFinishSoundSent = false;
  barConfig.timerDirection = "down";
  barConfig.timerSeconds = 0;
  barTimer.stop();
  stopBarLoop();

  // Draw the configured counter immediately, but do NOT reflect the source
  // until /rt:play. updateCounterBar renders the defined start state while
  // the counter is not running:
  //   countup   = 0%
  //   countdown = 100%
  system.run(function () {
    updateBar({ force: true });
  });

  queueReusableBarStateSave();
  return commandSuccess();
}

function hideReusableTimerDisplay() {
  barConfig.timerVisible = false;

  var players = allPlayers();
  for (var i = 0; i < players.length; i++) {
    setReusableHudTimerToken(players[i], "", false);
    setReusableHudTimerLabel(players[i], "", false);
  }

  queueReusableBarStateSave();
  return commandSuccess("Timer hidden");
}

function setSimpleTimer(seconds, label, digits, startMessage, endMessage, style) {
  // Public shortcut syntax:
  //   /rt:timer <seconds> [label]
  //
  // Sound/message configuration is intentionally not exposed by /rt:timer.
  // Keep the internal timer defaults deterministic.
  var requestedSeconds = Math.floor(Number(seconds));
  if (isFinite(requestedSeconds) && requestedSeconds === 0) {
    return hideReusableTimerDisplay();
  }

  var simpleResult = setBarConfig([
    "set",
    "timer",
    seconds,
    "off",
    label,
    messageOrEmpty(startMessage),
    messageOrEmpty(endMessage)
  ]);
  applyTimerDigitsSetting(simpleResult, digits);
  applyBarStyle(simpleResult, style);
  return simpleResult;
}

// /rt:countdownbar|countupbar <seconds> [label] [digits] [start] [end] [max] [up|down]
// One timer-driven bar. max defaults to the seconds (one step per second);
// the last argument sets the direction of the digits (default down).
function setTimedProgressBar(
  mode,
  seconds,
  label,
  digits,
  startMessage,
  endMessage,
  maxValue,
  timerDirection,
  style
) {
  var totalSeconds = Math.max(1, Math.floor(Number(seconds) || 1));
  var max = (maxValue === undefined || maxValue === null)
    ? totalSeconds
    : maxValue;

  var progressResult = configureCompositeTimedBar(
    mode,
    max,
    label,
    messageOrEmpty(startMessage),
    messageOrEmpty(endMessage),
    timerDirection,
    totalSeconds
  );
  applyTimerDigitsSetting(progressResult, digits);
  applyBarStyle(progressResult, style);
  return progressResult;
}

function setCounterMode(
  mode,
  source,
  maxValue,
  title,
  displayMode,
  color
) {
  var counterResult = setBarConfig([
    "set",
    mode,
    source,
    maxValue,
    title,
    displayMode,
    color
  ]);
  return counterResult;
}

function setRatioMode(source, teams, title, seconds) {
  var selectedTeams = parseRatioTeamSelection(teams);
  var requestedSeconds = (
    seconds === undefined
      ? 0
      : Math.floor(Number(seconds))
  );

  if (selectedTeams.length <= 0) {
    return commandFailure(
      "Teams: red_blue_yellow_green_cyan_purple_orange_pink"
    );
  }

  if (!isFinite(requestedSeconds) || requestedSeconds < 0) {
    return commandFailure(
      "Ratio timer seconds must be 0 or more"
    );
  }

  var ratioResult = setBarConfig([
    "set",
    "ratio",
    source,
    selectedTeams.join("_"),
    title,
    requestedSeconds
  ]);
  return ratioResult;
}

function playBar(options) {
  if (!barConfig.mode) {
    return commandFailure("Set a bar first (/rt:timer, /rt:countdown, /rt:countup, /rt:ratio ...)");
  }

  // /rt:play is idempotent while already running. Reinitializing event
  // trackers here would make the next normal update look like a fresh start
  // and duplicate rt_bar_event / rt_ratio_event without a new round.
  if (barConfig.running) {
    return commandSuccess("Bar already running");
  }

  resetUnifiedEventTracking(barTimer.getState());

  // Know where the boss bars are before the first frame is drawn.
  try {
    updateReusableBossPadNow();
  } catch (eBossPad) {}

  if (barKind(barConfig.mode) === "ratio") {
    resetRatioCommandEvents();

    if (!barConfig.running) {
      // A new /rt:play explicitly starts a new round. Discard any frozen
      // result restored from the previous round before resetting the source.
      barConfig.ratioHasStarted = true;
      barConfig.ratioLastDisplayValues = [];
      barConfig.ratioLastPresence = [];
      barConfig.ratioLastValues = [];
      barConfig.ratioRestoreHold = false;

      // A fresh ratio run always starts from real source values of 0.
      // This matches the counter modes and guarantees that old stat/scoreboard
      // values cannot bias the first live ratio.
      var ratioStartPlayers = ratioSelectedPlayers(
        allPlayers(),
        barConfig.ratioTeams
      );
      resetCounterSource(
        ratioStartPlayers,
        barConfig.source
      );
      resetRoundParticipants(ratioStartPlayers);

      // Ratio timer is display-only and restarts from the configured second
      // count on every fresh /rt:play.
      barConfig.startedTick = currentTick();
      barConfig.pausedTicks = 0;
      pulseRatioClockEvent.previous = undefined;
    }
  }

  if (isTimedBarMode(barConfig.mode)) {
    barTimer.start();
    barConfig.running = barTimer.getState().running;
  } else {
    if (
      barKind(barConfig.mode) === "counter"
      && !isTimedCounterMode(barConfig.mode)
      && !barConfig.running
    ) {
      // A fresh counter run always starts from a real source value of 0.
      // Countup therefore begins empty, while countdown begins full because
      // its display value is max-current.
      var counterStartPlayers = allPlayers();
      resetCounterSource(
        counterStartPlayers,
        barConfig.source
      );
      resetRoundParticipants(counterStartPlayers);

      barConfig.counterBaseline = 0;
      barConfig.counterBaselineReady = true;
      barConfig.counterLastCurrent = 0;

      // Counter clock display is independent from the bar source.
      barConfig.startedTick = currentTick();
      barConfig.pausedTicks = 0;
    }
    barConfig.running = true;
  }

  system.run(function () {
    startBarLoop(options);
  });

  queueReusableBarStateSave();
  return commandSuccess();
}

function stopBar() {
  // Capture the latest source-driven frame before running becomes false.
  // Ratio stores ratioLast*; normal counters store counterLastCurrent.
  if (
    barConfig.running
    && (
      barKind(barConfig.mode) === "ratio"
      || barConfig.mode === "countup"
      || barConfig.mode === "countdown"
    )
  ) {
    updateBar({ force: true });
  }

  if (isTimedBarMode(barConfig.mode)) {
    barTimer.pause();
  } else if (
    barKind(barConfig.mode) === "counter"
    && !isTimedCounterMode(barConfig.mode)
    && barConfig.running
  ) {
    barConfig.pausedTicks = counterElapsedTicks();
    barConfig.startedTick = 0;
  } else if (
    barKind(barConfig.mode) === "ratio"
    && barConfig.running
  ) {
    barConfig.pausedTicks = counterElapsedTicks();
    barConfig.startedTick = 0;
  }

  barConfig.running = false;
  stopBarLoop();
  clearUnifiedEventPulses();

  if (barKind(barConfig.mode) === "ratio") {
    resetRatioCommandEvents();
  }
  queueReusableBarStateSave();

  if (isTimedBarMode(barConfig.mode)) {
    syncTimerExecuteScoreboard(barTimer.getState());
  } else {
    // Source-driven counter/ratio clocks own rt_timer themselves. Keep their
    // last visible number frozen and only mark the clock as no longer running.
    setEventObjectiveValue(
      TIMER_EXECUTE_OBJECTIVES.running,
      "RT Timer Running",
      0
    );
  }

  return commandSuccess("Bar stopped");
}

function cleanTimerLabelForInfo(value) {
  return String(value || "")
    .replace(/§[0-9a-fklmnor]/gi, "")
    .trim();
}

function barInfoText() {
  if (!barConfig.mode) return "Bar: none";

  var timerState = barTimer.getState();
  var parts = [
    "mode=" + String(barConfig.mode || "")
  ];

  if (barConfig.source) {
    parts.push("source=" + String(barConfig.source));

    if (
      barConfig.mode === "countup"
      || barConfig.mode === "countdown"
    ) {
      parts.push(
        "display=" + normalizeCounterDisplay(barConfig.counterDisplay) + " color=" + normalizeCounterColor(barConfig.counterColor)
      );
      if (barConfig.counterTitle) {
        parts.push("title=" + String(barConfig.counterTitle));
      }
    }
  }

  if (barConfig.mode === "ratio") {
    parts.push(
      "teams="
      + ratioTeamSelectionToken(
        barConfig.ratioTeams,
        barConfig.teamCount
      )
    );
    if (barConfig.ratioTitle) {
      parts.push("title=" + String(barConfig.ratioTitle));
    }
    parts.push("seconds=" + String(barConfig.ratioSeconds || 0));
  }

  if (barConfig.maxValue) {
    parts.push("max=" + String(barConfig.maxValue));
  }

  if (
    barConfig.mode === "time_countup"
    || barConfig.mode === "time_countdown"
  ) {
    parts.push(
      "bar=" + String(compositeBarCurrentValue(timerState))
    );
  }

  if (isTimedBarMode(barConfig.mode)) {
    parts.push(
      "time="
      + String(displayedTimerSecond(timerState))
      + "/"
      + String(Math.max(0, Math.floor(Number(timerState.totalSeconds) || 0)))
    );
    parts.push(
      "timer=" + String(barConfig.timerDirection || "down")
    );
    parts.push(
      "timerVisible=" + (barConfig.timerVisible === false ? "0" : "1")
    );
    parts.push(
      "digits=" + (barConfig.timerDigitsVisible === false ? "0" : "1")
    );
    parts.push(
      "style=" + (barConfig.barStyle === "xp" ? "xp" : "boss")
    );
  }

  var label = cleanTimerLabelForInfo(barConfig.timerLabel);
  if (label) parts.push("label=" + label);

  parts.push("running=" + (barConfig.running ? "1" : "0"));

  return "Bar: " + parts.join(" / ");
}

export function getReusableBarInfo() {
  var timerState = barTimer.getState();

  return {
    mode: String(barConfig.mode || ""),
    source: String(barConfig.source || ""),
    maxValue: Math.max(0, Math.floor(Number(barConfig.maxValue) || 0)),
    teamCount: Math.max(1, Math.floor(Number(barConfig.teamCount) || 1)),
    ratioTeams: ratioTeamSelectionToken(
      barConfig.ratioTeams,
      barConfig.teamCount
    ),
    ratioHasStarted: !!barConfig.ratioHasStarted,
    ratioRestoreHold: !!barConfig.ratioRestoreHold,
    ratioLastDisplayValues: Array.isArray(barConfig.ratioLastDisplayValues)
      ? barConfig.ratioLastDisplayValues.slice()
      : [],
    ratioLastPresence: Array.isArray(barConfig.ratioLastPresence)
      ? barConfig.ratioLastPresence.slice()
      : [],
    ratioLastValues: Array.isArray(barConfig.ratioLastValues)
      ? barConfig.ratioLastValues.slice()
      : [],
    running: !!barConfig.running,
    counterTitle: String(barConfig.counterTitle || ""),
    counterDisplay: normalizeCounterDisplay(barConfig.counterDisplay),
    counterColor: normalizeCounterColor(barConfig.counterColor),
    counterBaseline: Number(barConfig.counterBaseline) || 0,
    counterBaselineReady: !!barConfig.counterBaselineReady,
    counterLastCurrent: Math.max(
      0,
      Math.floor(Number(barConfig.counterLastCurrent) || 0)
    ),
    roundParticipants: Array.isArray(barConfig.roundParticipants)
      ? barConfig.roundParticipants.slice()
      : [],
    counterElapsedSeconds: Math.floor(counterElapsedTicks() / 20),
    label: cleanTimerLabelForInfo(barConfig.timerLabel),
    timerDirection: String(barConfig.timerDirection || "down"),
    timerSeconds: Math.max(0, Math.floor(Number(barConfig.timerSeconds) || 0)),
    timerVisible: barConfig.timerVisible !== false,
    timerDigitsVisible: barConfig.timerDigitsVisible !== false,
    barStyle: barConfig.barStyle === "xp" ? "xp" : "boss",
    barValue: (
      barConfig.mode === "time_countup"
      || barConfig.mode === "time_countdown"
    )
      ? compositeBarCurrentValue(timerState)
      : 0,
    timerState: timerState
  };
}

function removeBar() {
  barConfig.mode = "";
  barConfig.source = "";
  barConfig.maxValue = 0;
  barConfig.teamCount = 4;
  barConfig.ratioTeams = "red_blue_yellow_green";
  barConfig.ratioTitle = "";
  barConfig.ratioSeconds = 0;
  barConfig.ratioHasStarted = false;
  barConfig.ratioLastDisplayValues = [];
  barConfig.ratioLastPresence = [];
  barConfig.ratioLastValues = [];
  barConfig.ratioRestoreHold = false;
  barConfig.roundParticipants = [];
  barConfig.running = false;
  barConfig.startedTick = 0;
  barConfig.pausedTicks = 0;
  barConfig.counterTitle = "";
  barConfig.counterDisplay = "none";
  barConfig.counterColor = "blue";
  barConfig.counterBaseline = 0;
  barConfig.counterBaselineReady = false;
  barConfig.counterLastCurrent = 0;
  barConfig.timerLabel = "";
  barConfig.timerStartMessage = "";
  barConfig.timerEndMessage = "";
  barConfig.timerEndMessageSent = false;
  barConfig.timerSoundEnabled = false;
  barConfig.lastCountdownSoundSecond = -1;
  barConfig.timerFinishSoundSent = false;
  barConfig.timerVisible = true;
  barConfig.timerDigitsVisible = true;
  barConfig.barStyle = "";
  barTimer.reset();
  stopBarLoop();

  clearReusableBarSavedState();

  system.run(function () {
    clearReusableBarCommandScoresNow();
    clearRatioCommandBridge();
    clearBarForPlayers(allPlayers());
  });

  return commandSuccess("Bar removed");
}

function showHudTestTargets(targets) {
  var list = Array.isArray(targets) ? targets : [];

  for (var i = 0; i < list.length; i++) {
    var target = list[i];
    if (!target) continue;

    showReusableTimeHud(target, "countdown", {
      elapsedTicks: 0,
      remainingTicks: 60 * 20,
      totalTicks: 60 * 20
    }, { force: true });
    setReusableHudOverlayText(target, "", true);
  }

  return commandSuccess("HUD test sent");
}

function showHudTest(origin) {
  var player = senderFromOrigin(origin);
  var targets = player ? [player] : allPlayers();

  return showHudTestTargets(targets);
}


export function loadReusableBarState(force) {
  if (barPersistenceLoaded && !force) {
    return !!barConfig.mode;
  }

  if (!canAccessWorldDynamicProperties(BAR_PERSISTENCE_PREFIX)) {
    return false;
  }

  var rawSaved = readChunkedJson(BAR_PERSISTENCE_PREFIX);
  barPersistenceLoaded = true;
  var saved = migrateReusableBarState(rawSaved);
  if (!saved || !saved.config) return false;

  var shouldResave = Number(rawSaved && rawSaved.version) !== 3;
  barPersistenceRestoring = true;

  try {
    applySavedBarConfig(saved.config);

    if (isTimedBarMode(barConfig.mode)) {
      if (
        saved.timerState
        && typeof barTimer.restore === "function"
      ) {
        barTimer.restore(saved.timerState);
      } else {
        barTimer.configure({
          seconds: Math.max(
            1,
            barConfig.timerSeconds
            || barConfig.maxValue
            || 60
          )
        });
      }

      // Resume any timer-driven bar that was running before world reload.
      // Offline time is not counted.
      if (
        saved.timerState
        && saved.timerState.running
        && !saved.timerState.finished
      ) {
        barTimer.start();
        barConfig.running = true;
      } else {
        barConfig.running = false;
      }
    }

    return !!barConfig.mode;
  } catch (e) {
    barConfig.mode = "";
    return false;
  } finally {
    barPersistenceRestoring = false;

    if (shouldResave && barConfig.mode) {
      system.run(function () {
        saveReusableBarStateNow();
      });
    }
  }
}

export function initializeReusableBarPersistence(options) {
  var opts = options || {};

  function applyLoadedBarToWorld() {
    if (!barPersistenceLoaded) {
      loadReusableBarState();
    } else if (!barConfig.mode) {
      // If an earlier read happened before world data was fully visible,
      // force a fresh read at worldLoad/playerSpawn rather than keeping a
      // false "empty" result forever.
      loadReusableBarState(true);
    }

    if (!barConfig.mode) return;

    updateBar({ force: true });

    if (
      barConfig.running
      || barKind(barConfig.mode) === "ratio"
    ) {
      // Restored/frozen ratio bars also keep a lightweight loop. The saved
      // display snapshot remains immutable while ratioRestoreHold is true,
      // but rt_ratio_active can still follow current online/tag presence.
      startBarLoop(opts);
    }

    if (isTimedBarMode(barConfig.mode)) {
      syncTimerExecuteScoreboard(barTimer.getState());
    }
    queueReusableBarStateSave();
  }

  if (!barPersistenceInitialized) {
    barPersistenceInitialized = true;

    // worldLoad is the strongest retry point if the first system.run happened
    // before dynamic properties were available.
    try {
      if (world.afterEvents && world.afterEvents.worldLoad) {
        world.afterEvents.worldLoad.subscribe(function () {
          system.run(function () {
            applyLoadedBarToWorld();
          });
        });
      }
    } catch (eWorldLoad) {}

    try {
      if (world.afterEvents && world.afterEvents.playerSpawn) {
        world.afterEvents.playerSpawn.subscribe(function (event) {
          if (!event || !event.player) return;
          var player = event.player;
          var initialSpawn = !!event.initialSpawn;

          system.run(function () {
            if (!barPersistenceLoaded) {
              loadReusableBarState();
            } else if (!barConfig.mode) {
              loadReusableBarState(true);
            }

            // A player joining an already-running round must not bring an old
            // persisted stat/score into the live total. PlayerSpawnAfterEvent
            // distinguishes an initial join from a death-respawn, so deaths
            // never wipe legitimate in-round progress.
            if (
              initialSpawn
              && barConfig.running
              && !hasRoundParticipant(player)
            ) {
              if (
                barConfig.mode === "countup"
                || barConfig.mode === "countdown"
              ) {
                resetCounterSource([player], barConfig.source);
                rememberRoundParticipant(player);
                queueReusableBarStateSave();
              } else if (barKind(barConfig.mode) === "ratio") {
                var joinedRatioPlayers = ratioSelectedPlayers(
                  [player],
                  barConfig.ratioTeams
                );
                if (joinedRatioPlayers.length > 0) {
                  resetCounterSource(
                    joinedRatioPlayers,
                    barConfig.source
                  );
                  rememberRoundParticipant(player);
                  queueReusableBarStateSave();
                }
              }
            }

            syncReusableBarPlayer(player);

            if (
              barKind(barConfig.mode) === "ratio"
              && !barConfig.ratioHasStarted
              && !barConfig.ratioRestoreHold
            ) {
              queueReusableBarStateSave();
            }

            if (
              barConfig.mode
              && barConfig.running
              && barRuntimeHandle === undefined
            ) {
              startBarLoop(opts);
            }
          });
        });
      }
    } catch (eSpawn) {}

    try {
      if (world.afterEvents && world.afterEvents.playerLeave) {
        world.afterEvents.playerLeave.subscribe(function () {
          system.run(function () {
            if (!barConfig.mode) return;

            if (
              barConfig.mode === "ratio"
              || barConfig.mode === "countup"
              || barConfig.mode === "countdown"
            ) {
              updateBar({ force: true });

              // Pre-play ratio team colors are sticky. Save the refreshed
              // snapshot immediately when a player leaves so reload cannot
              // regress to a one-color state.
              if (barConfig.mode === "ratio") {
                queueReusableBarStateSave();
              }
            }
          });
        });
      }
    } catch (eLeave) {}
  }

  // Immediate normal-execution attempt. If not ready, worldLoad/playerSpawn
  // will retry without barPersistenceLoaded being incorrectly latched true.
  system.run(function () {
    applyLoadedBarToWorld();
  });

  return !!barConfig.mode;
}

// ---------------------------------------------------------------------
// Developer-facing HUD timer facade.
// Pure timer/event logic is also available from reusable_timer.js.
// ---------------------------------------------------------------------
export function configureReusableCompositeBar(config) {
  var input = config || {};

  var result = configureCompositeTimedBar(
    input.mode || "up",
    input.max === undefined ? 100 : input.max,
    input.label || "",
    input.startMessage === undefined ? "" : input.startMessage,
    input.endMessage === undefined ? "" : input.endMessage,
    input.timerDirection || "down",
    input.seconds === undefined ? 60 : input.seconds
  );

  var timerState = barTimer.getState();

  return {
    commandResult: result,
    mode: barConfig.mode,
    maxValue: barConfig.maxValue,
    currentValue: compositeBarCurrentValue(timerState),
    timerDirection: barConfig.timerDirection,
    timerState: timerState
  };
}

export function getReusableCompositeBarState() {
  var timerState = barTimer.getState();

  return {
    mode: barConfig.mode,
    maxValue: barConfig.maxValue,
    currentValue: (
      isTimedBarMode(barConfig.mode)
        ? compositeBarCurrentValue(timerState)
        : 0
    ),
    timerDirection: barConfig.timerDirection,
    timerSeconds: barConfig.timerSeconds,
    running: !!barConfig.running,
    timerState: timerState
  };
}

export function configureReusableCountupBar(config) {
  var input = config || {};

  setTimedProgressBar(
    "time_countup",
    input.seconds === undefined ? 60 : input.seconds,
    input.label || ""
  );

  return barTimer.getState();
}

export function configureReusableCountdownBar(config) {
  var input = config || {};

  setTimedProgressBar(
    "time_countdown",
    input.seconds === undefined ? 60 : input.seconds,
    input.label || ""
  );

  return barTimer.getState();
}

export function configureReusableBarTimer(config) {
  var input = config || {};

  setBarConfig([
    "set",
    "timer",
    input.seconds === undefined ? 60 : input.seconds,
    "off",
    input.label || "",
    input.startMessage === undefined ? "" : input.startMessage,
    input.endMessage === undefined ? "" : input.endMessage
  ]);

  return barTimer.getState();
}

export function resetReusableBarForGame() {
  stopBarLoop();
  barConfig.running = false;
  barConfig.roundParticipants = [];
  clearUnifiedEventPulses();

  if (
    barConfig.mode === "countup"
    || barConfig.mode === "countdown"
  ) {
    barConfig.counterBaseline = 0;
    barConfig.counterBaselineReady = false;
    barConfig.counterLastCurrent = 0;
    barConfig.startedTick = 0;
    barConfig.pausedTicks = 0;
  }

  if (barKind(barConfig.mode) === "ratio") {
    // Game reset means "back to configured pre-play state", not "keep the
    // previous round's frozen result".
    barConfig.ratioHasStarted = false;
    barConfig.ratioLastDisplayValues = [];
    barConfig.ratioLastPresence = [];
    barConfig.ratioLastValues = [];
    barConfig.ratioRestoreHold = false;
    barConfig.startedTick = 0;
    barConfig.pausedTicks = 0;
    resetRatioCommandEvents();
  }

  if (isTimedBarMode(barConfig.mode)) {
    barTimer.reset();
    resetUnifiedEventTracking(barTimer.getState());
    syncTimerExecuteScoreboard(barTimer.getState());
  }

  system.run(function () {
    if (!barConfig.mode) return;

    if (barKind(barConfig.mode) === "ratio") {
      // Pre-play ratio must keep watching team tags after /rt:game reset.
      startBarLoop({ force: true });
    } else {
      updateBar({ force: true });
    }
  });

  queueReusableBarStateSave();
  return getReusableBarInfo();
}

export function hardResetReusableBar() {
  removeBar();
  return true;
}

export function getReusableBarRuntimeStats() {
  return {
    loopActive: barRuntimeHandle !== undefined,
    intervalTicks: barRuntimeIntervalTicks,
    eventQueueObjectives: Object.keys(eventPulseQueues).length,
    commandsRegistered: !!barCommandsRegistered,
    commandRegistrationFailures: barCommandRegistrationFailures.slice(),
    persistenceLoaded: !!barPersistenceLoaded,
    persistenceInitialized: !!barPersistenceInitialized,
    persistenceSchema: 3
  };
}

export function startReusableBarTimer(options) {
  playBar(options);
  return barTimer.getState();
}

export function pauseReusableBarTimer() {
  stopBar();
  return barTimer.getState();
}

export function resetReusableBarTimer() {
  clearUnifiedEventPulses();
  barTimer.reset();
  resetUnifiedEventTracking(barTimer.getState());
  if (isTimedBarMode(barConfig.mode)) {
    syncTimerExecuteScoreboard(barTimer.getState());
  }
  queueReusableBarStateSave();

  system.run(function () {
    updateBar({ force: true });
  });

  return barTimer.getState();
}

export function getReusableBarTimerState() {
  return barTimer.getState();
}

export { barTimer };

export var reusableTimerScoreboard = {
  // rt_timer mirrors the timer number currently shown on the HUD.
  remaining: "rt_timer",
  displayed: "rt_timer",
  elapsed: "rt_elapsed",
  total: "rt_total",
  percent: "rt_percent",
  running: "rt_running",
  paused: "rt_paused",
  finished: "rt_finished",
  runId: "rt_run",

  // Legacy.
  event: "rt_event",

  // Unified event/state objectives.
  timeEvent: "rt_time_event",
  percentEvent: "rt_percent_event",
  barValue: "rt_bar",
  barMax: "rt_bar_max",
  barEvent: "rt_bar_event",
  finishEvent: "rt_finish_event"
};


export function registerBarCustomCommands(startupEvent, options) {
  if (barCommandsRegistered) return false;

  var registry = startupEvent && startupEvent.customCommandRegistry;
  if (!registry || typeof registry.registerCommand !== "function") {
    return false;
  }

  var opts = options || {};

  var registeredAny = false;

  function registerBarCommand(commandName, parameters, callback, required) {
    var definition = {
      name: commandName,
      description: "Configure and control the reusable HUD bar",
      permissionLevel: opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
      cheatsRequired: true
    };

    if (required) {
      definition.mandatoryParameters = parameters || [];
    } else {
      definition.optionalParameters = parameters || [];
    }

    registry.registerCommand(definition, callback);
  }

  function registerTimerCommand(commandName) {
    var definition = {
      name: commandName,
      description: "Set reusable HUD timer",
      permissionLevel: opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
      cheatsRequired: true,
      mandatoryParameters: [
        integerParameter("seconds")
      ],
      optionalParameters: [
        stringParameter("label"),
        stringParameter("digits"),
        stringParameter("startMessage"),
        stringParameter("endMessage"),
        stringParameter("style")
      ]
    };

    registry.registerCommand(definition, function (origin, ...args) {
      var list = commandArgs(args);
      var requestedSeconds = Math.floor(Number(list[0]));
      if (!isFinite(requestedSeconds) || requestedSeconds < 0) {
        return commandFailure("Timer seconds must be 0 or more");
      }

      if (!digitsSettingIsValid(list[2])) {
        return commandFailure("Digits must be on or off");
      }

      if (requestedSeconds > CLOCK_MAX_SECONDS && digitsSetting(list[2]) !== "off") {
        return commandFailure(clockLimitMessage(requestedSeconds));
      }

      if (!styleSettingIsValid(list[5])) {
        return commandFailure("Style must be xp or boss");
      }

      var savedArgs = list.slice();
      system.run(function () {
        setSimpleTimer(
          savedArgs[0],
          savedArgs[1],
          savedArgs[2],
          savedArgs[3],
          savedArgs[4],
          savedArgs[5]
        );
      });
      return commandSuccess();
    });
  }

  function registerTimedProgressCommand(commandName, mode) {
    var definition = {
      name: commandName,
      description: "Set timer-driven reusable HUD progress bar",
      permissionLevel:
        opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
      cheatsRequired: true,
      mandatoryParameters: [
        integerParameter("seconds")
      ],
      optionalParameters: [
        stringParameter("label"),
        stringParameter("digits"),
        stringParameter("startMessage"),
        stringParameter("endMessage"),
        integerParameter("max"),
        stringParameter("timer"),
        stringParameter("style")
      ]
    };

    registry.registerCommand(definition, function (origin, ...args) {
      var list = commandArgs(args);
      var check = positiveIntegerCommandValue(
        list[0],
        "Timer seconds"
      );
      if (!check.ok) return commandFailure(check.message);

      if (!digitsSettingIsValid(list[2])) {
        return commandFailure("Digits must be on or off");
      }

      var barSeconds = Math.floor(Number(list[0]) || 0);
      if (barSeconds > CLOCK_MAX_SECONDS && digitsSetting(list[2]) !== "off") {
        return commandFailure(clockLimitMessage(barSeconds));
      }

      if (list[5] !== undefined && list[5] !== null) {
        var maxCheck = positiveIntegerCommandValue(list[5], "Bar max");
        if (!maxCheck.ok) return commandFailure(maxCheck.message);
      }

      var timerDirection = String(
        list[6] === undefined || list[6] === null ? "" : list[6]
      ).trim().toLowerCase();
      if (
        timerDirection !== ""
        && timerDirection !== "up"
        && timerDirection !== "down"
      ) {
        return commandFailure("Timer must be up or down");
      }

      if (!styleSettingIsValid(list[7])) {
        return commandFailure("Style must be xp or boss");
      }

      var savedMode = mode;
      var savedArgs = list.slice();
      system.run(function () {
        setTimedProgressBar(
          savedMode,
          savedArgs[0],
          savedArgs[1],
          savedArgs[2],
          savedArgs[3],
          savedArgs[4],
          savedArgs[5],
          savedArgs[6],
          savedArgs[7]
        );
      });
      return commandSuccess();
    });
  }

  function registerCounterCommand(commandName, mode) {
    var definition = {
      name: commandName,
      description: "Configure a reusable counter HUD bar",
      permissionLevel: opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
      cheatsRequired: true,
      mandatoryParameters: [
        stringParameter("source"),
        integerParameter("max"),
        stringParameter("title"),
        stringParameter("display")
      ],
      optionalParameters: [
        stringParameter("color")
      ]
    };

    registry.registerCommand(definition, function (origin, ...args) {
      var list = commandArgs(args);
      var check = positiveIntegerCommandValue(
        list[1],
        "Bar max"
      );
      if (!check.ok) return commandFailure(check.message);

      var counterStatError = reusableStatSourceError(list[0]);
      if (counterStatError) return commandFailure(counterStatError);

      if (!counterDisplayIsValid(list[3])) {
        return commandFailure(
          "Display must be count, d<seconds>, a<seconds> (up to 5999 seconds), or none"
        );
      }

      if (!counterColorIsValid(list[4])) {
        return commandFailure(
          "Color must be blue, red, green, yellow, purple, orange, white, or xp"
        );
      }

      var savedMode = mode;
      var savedArgs = list.slice();
      system.run(function () {
        setCounterMode(
          savedMode,
          savedArgs[0],
          savedArgs[1],
          savedArgs[2],
          savedArgs[3],
          savedArgs[4]
        );
      });
      return commandSuccess();
    });
  }

  function registerRatioCommand(commandName) {
    var definition = {
      name: commandName,
      description: "Configure a reusable team ratio HUD bar",
      permissionLevel: opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
      cheatsRequired: true,
      mandatoryParameters: [
        stringParameter("source"),
        stringParameter("teams"),
        stringParameter("title")
      ],
      optionalParameters: [
        integerParameter("seconds")
      ]
    };

    registry.registerCommand(definition, function (origin, ...args) {
      var list = commandArgs(args);
      var ratioStatError = reusableStatSourceError(list[0]);
      if (ratioStatError) return commandFailure(ratioStatError);

      var selectedTeams = parseRatioTeamSelection(list[1]);
      var requestedSeconds = (
        list[3] === undefined
          ? 0
          : Math.floor(Number(list[3]))
      );

      if (selectedTeams.length <= 0) {
        return commandFailure(
          "Teams: red_blue_yellow_green_cyan_purple_orange_pink"
        );
      }

      if (
        !isFinite(requestedSeconds)
        || requestedSeconds < 0
      ) {
        return commandFailure(
          "Ratio timer seconds must be 0 or more"
        );
      }

      if (requestedSeconds > CLOCK_MAX_SECONDS) {
        return commandFailure(
          "The clock shows up to 99:59 (" + CLOCK_MAX_SECONDS + " seconds), but "
          + requestedSeconds + " was given. Use " + CLOCK_MAX_SECONDS
          + " or less, or leave the seconds out"
        );
      }

      var savedArgs = list.slice();
      system.run(function () {
        setRatioMode(
          savedArgs[0],
          savedArgs[1],
          savedArgs[2],
          savedArgs[3]
        );
      });
      return commandSuccess();
    });
  }

  // /rt:stat <name> <formula>     make a named stat from a formula
  // /rt:stat <name> delete          remove it
  // /rt:stat list                   show all of them
  // The formula is read from left to right:  kills.zombie + killed_by.zombie * 2
  function registerStatComboCommand(commandName) {
    var optional = [];
    for (var n = 1; n <= 7; n++) {
      optional.push(stringParameter("formula" + n));
    }

    var definition = {
      name: commandName,
      description: "Named stat from a formula (left to right): name kills.zombie - killed_by.zombie | name delete | list",
      permissionLevel: opts.permissionLevel || CUSTOM_COMMAND_PERMISSION_GAME_DIRECTORS,
      cheatsRequired: true,
      mandatoryParameters: [
        stringParameter("name")
      ],
      optionalParameters: optional
    };

    registry.registerCommand(definition, function (origin, ...args) {
      var list = commandArgs(args);
      var name = String(list[0] === undefined ? "" : list[0]).trim();

      if (list.length === 1 && name.toLowerCase() === "list") {
        var all = listReusableStatCombos();
        if (all.length <= 0) return commandSuccess("No named stats yet");

        return commandSuccess(
          all.map(function (item) {
            return item.name + " = " + item.text;
          }).join("\n")
        );
      }

      if (list.length === 1) {
        return commandFailure(
          "Use /rt:stat <name> <formula>  |  /rt:stat <name> delete  |  /rt:stat list"
        );
      }

      if (list.length === 2 && String(list[1]).trim().toLowerCase() === "delete") {
        if (!getReusableStatCombo(name)) {
          return commandFailure("No named stat '" + name + "'");
        }
        system.run(function () {
          deleteReusableStatCombo(name);
        });
        return commandSuccess("Deleted " + name);
      }

      var nameError = reusableStatComboNameError(name);
      if (nameError) return commandFailure(nameError);

      // The words after the name are joined, so both
      //   /rt:stat A kills.zombie - deaths     and     /rt:stat A kills.zombie-deaths
      // work (or put the whole formula in "...").
      var formula = list.slice(1).join(" ");
      var compiled = compileStatExpression(formula, reusableStatComboMember);
      if (!compiled.ok) return commandFailure(compiled.error);

      var savedItems = compiled.items.slice();
      system.run(function () {
        setReusableStatCombo(name, savedItems);
      });
      return commandSuccess(
        name + " = " + describeStatExpression(savedItems)
        + "  (calculated left to right, use it as stat:" + name + ")"
      );
    });
  }

  function registerSimpleCommand(commandName, callback) {
    registerBarCommand(commandName, [], callback);
  }

  barCommandRegistrationFailures = [];

  function tryRegister(name, callback) {
    try {
      callback();
      registeredAny = true;
      return true;
    } catch (e) {
      barCommandRegistrationFailures.push(
        String(name || "unknown")
        + ": "
        + String(e && e.message ? e.message : e)
      );
      return false;
    }
  }

  // Source-driven commands register first so they cannot be taken down by
  // a failure in another command definition.
  tryRegister("rt:countup", function () {
    registerCounterCommand("rt:countup", "countup");
  });

  tryRegister("rt:countdown", function () {
    registerCounterCommand("rt:countdown", "countdown");
  });

  tryRegister("rt:ratio", function () {
    registerRatioCommand("rt:ratio");
  });

  tryRegister("rt:timer", function () {
    registerTimerCommand("rt:timer");
  });

  tryRegister("rt:countupbar", function () {
    registerTimedProgressCommand(
      "rt:countupbar",
      "countup"
    );
  });

  tryRegister("rt:countdownbar", function () {
    registerTimedProgressCommand(
      "rt:countdownbar",
      "countdown"
    );
  });

  tryRegister("rt:play", function () {
    registerSimpleCommand("rt:play", function () {
      system.run(function () {
        playBar(opts);
      });
      return commandSuccess();
    });
  });

  tryRegister("rt:stop", function () {
    registerSimpleCommand("rt:stop", function () {
      system.run(function () {
        stopBar();
      });
      return commandSuccess("Bar stopped");
    });
  });

  tryRegister("rt:remove", function () {
    registerSimpleCommand("rt:remove", function () {
      system.run(function () {
        removeBar();
      });
      return commandSuccess("Bar removed");
    });
  });

  tryRegister("rt:stat", function () {
    registerStatComboCommand("rt:stat");
  });

  tryRegister("rt:hudtest", function () {
    registerSimpleCommand("rt:hudtest", function (origin) {
      var sender = senderFromOrigin(origin);
      var targets = sender ? [sender] : allPlayers();

      system.run(function () {
        showHudTestTargets(targets);
      });
      return commandSuccess("HUD test sent");
    });
  });

  barCommandsRegistered = registeredAny;
  return registeredAny;
}

export function registerBarCommandShortcuts(startupEvent, options) {
  return registerBarCustomCommands(startupEvent, options);
}
