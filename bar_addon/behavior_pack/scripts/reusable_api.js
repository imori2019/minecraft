// Public developer entry point.
//
// Typical import:
// import {
//   barTimer,
//   configureReusableCompositeBar,
//   getReusableBarInfo,
//   hudSetRatioTeamTag,
//   watchScore,
//   watchValue
// } from "./reusable_api.js";

export {
  createNumericWatcher,
  watchValue
} from "./reusable_numeric_watch.js";

export {
  createReusableTimer
} from "./reusable_timer.js";

export {
  watchScore,
  getScoreValue,
  mirrorTimerToScoreboard
} from "./reusable_scoreboard_watch.js";

export {
  barTimer,
  configureReusableBarTimer,
  configureReusableCompositeBar,
  getReusableCompositeBarState,
  configureReusableCountupBar,
  configureReusableCountdownBar,
  startReusableBarTimer,
  pauseReusableBarTimer,
  resetReusableBarTimer,
  getReusableBarTimerState,
  getReusableBarInfo,
  getReusableBarRuntimeStats,
  resetReusableBarForGame,
  hardResetReusableBar,
  clearReusableBarCommandScores,
  syncReusableBarPlayer,
  initializeReusableBarPersistence,
  loadReusableBarState,
  syncReusableTimerScoreboard,
  reusableTimerScoreboard
} from "./reusable_bar_commands.js";

export {
  HUD_RATIO_TEAM_ORDER,
  HUD_RATIO_TEAM_TAGS,
  hudRatioTeamTagState,
  hudNormalizeRatioTeamTags,
  hudRatioTeamForPlayer,
  hudSetRatioTeamTag,
  hudClearRatioTeamTags,
  getHudTeamRuntimeStats,
  hudGetTeamResetEpoch,
  hudAdvanceTeamResetEpoch,
  hudEnsurePlayerTeamResetEpoch
} from "./reusable_team_ratio_bar.js";

export {
  hasReusableTeamAreas,
  getReusableTeamAreaState
} from "./reusable_team_area.js";

export {
  hardResetReusableGame,
  getReusableGameDebugState
} from "./reusable_game_commands.js";

export {
  setReusableHudTeamText,
  clearReusableHudTeamText
} from "./reusable_hud_display.js";


export {
  isReusableStatSource,
  reusableStatKeyFromSource,
  getReusableStatValue,
  getReusableStatSourceValue,
  reusableSourceLabel
} from "./reusable_stat_source.js";

export {
  getReusableStoredStat,
  setReusableStoredStat,
  addReusableStoredStat,
  maxReusableStoredStat,
  minReusableStoredStat,
  listReusableStoredStats,
  flushReusableStats
} from "./reusable_stat_store.js";

export {
  showReusableValueBarOnly
} from "./reusable_hud_display.js";

export {
  hudBuildValueBarToken
} from "./reusable_hud_parts.js";
