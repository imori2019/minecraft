import { system } from "@minecraft/server";
import { createNumericWatcher } from "./reusable_numeric_watch.js";

function currentTick() {
  try {
    return system.currentTick;
  } catch (e) {}
  return 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positiveSeconds(value, fallbackValue) {
  return Math.max(1, Math.floor(Number(value) || fallbackValue || 1));
}

function createListenerStore() {
  return {
    configure: [],
    start: [],
    pause: [],
    resume: [],
    finish: [],
    stop: [],
    reset: [],
    second: []
  };
}

export function createReusableTimer(options) {
  var opts = options || {};
  var listeners = createListenerStore();
  var loopHandle = undefined;

  var state = {
    configured: false,
    totalTicks: positiveSeconds(opts.seconds, 60) * 20,
    elapsedTicks: 0,
    startedTick: 0,
    running: false,
    paused: false,
    finished: false,
    runId: 0,
    lastVisibleSecond: undefined
  };

  var remainingWatcher = createNumericWatcher({
    sourceType: "timer",
    sourceId: String(opts.id || "timer") + ":remainingSeconds"
  });

  var percentWatcher = createNumericWatcher({
    sourceType: "timer",
    sourceId: String(opts.id || "timer") + ":remainingPercent"
  });

  function elapsedTicksNow() {
    var elapsed = state.elapsedTicks;

    if (state.running) {
      elapsed += Math.max(0, currentTick() - state.startedTick);
    }

    return clamp(elapsed, 0, state.totalTicks);
  }

  function snapshot() {
    var elapsedTicks = elapsedTicksNow();
    var remainingTicks = Math.max(0, state.totalTicks - elapsedTicks);
    var totalSeconds = Math.max(1, Math.ceil(state.totalTicks / 20));
    var remainingSeconds = Math.max(0, Math.ceil(remainingTicks / 20));
    var elapsedSeconds = Math.max(0, totalSeconds - remainingSeconds);
    var remainingPercent = state.totalTicks <= 0
      ? 0
      : (remainingTicks / state.totalTicks) * 100;

    return {
      configured: state.configured,
      runId: state.runId,

      totalTicks: state.totalTicks,
      elapsedTicks: elapsedTicks,
      remainingTicks: remainingTicks,

      totalSeconds: totalSeconds,
      elapsedSeconds: elapsedSeconds,
      remainingSeconds: remainingSeconds,

      elapsedPercent: 100 - remainingPercent,
      remainingPercent: remainingPercent,

      running: state.running,
      paused: state.paused,
      finished: state.finished
    };
  }

  function emit(name, event) {
    var list = listeners[name] || [];
    var copy = list.slice();

    for (var i = 0; i < copy.length; i++) {
      var item = copy[i];
      if (!item || !item.active) continue;

      try {
        item.callback(event);
      } catch (e) {
        try {
          console.warn("[ReusableTimer] " + name + " callback error: " + e);
        } catch (e2) {}
      }
    }
  }

  function subscribe(name, callback) {
    if (typeof callback !== "function") return function () {};

    var item = {
      active: true,
      callback: callback
    };

    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(item);

    return function () {
      item.active = false;
    };
  }

  function timerMeta(timerState) {
    return {
      sourceType: "timer",
      sourceId: String(opts.id || "timer"),
      runId: timerState.runId,
      timerState: timerState
    };
  }

  function timerEventFromNumeric(event) {
    var timerState = event && event.timerState
      ? event.timerState
      : snapshot();

    var out = {};

    for (var key in timerState) {
      out[key] = timerState[key];
    }

    for (var eventKey in event) {
      if (eventKey === "timerState") continue;
      out[eventKey] = event[eventKey];
    }

    return out;
  }

  function clearLoop() {
    if (loopHandle === undefined) return;

    try {
      system.clearRun(loopHandle);
    } catch (e) {}

    loopHandle = undefined;
  }

  function updateWatchers(timerState) {
    var meta = timerMeta(timerState);

    remainingWatcher.update(
      timerState.remainingSeconds,
      meta
    );

    percentWatcher.update(
      timerState.remainingPercent,
      meta
    );

    if (state.lastVisibleSecond !== timerState.remainingSeconds) {
      state.lastVisibleSecond = timerState.remainingSeconds;
      emit("second", timerState);
    }
  }

  function tick() {
    if (!state.running) return snapshot();

    var timerState = snapshot();
    updateWatchers(timerState);

    if (timerState.remainingTicks <= 0 && !state.finished) {
      state.elapsedTicks = state.totalTicks;
      state.running = false;
      state.paused = false;
      state.finished = true;
      clearLoop();

      var finishState = snapshot();
      updateWatchers(finishState);
      emit("finish", finishState);
      return finishState;
    }

    return timerState;
  }

  function ensureLoop() {
    if (loopHandle !== undefined) return;

    loopHandle = system.runInterval(function () {
      tick();
    }, 1);
  }

  function configure(config) {
    var input = config || {};
    clearLoop();

    state.configured = true;
    state.totalTicks = positiveSeconds(input.seconds, 60) * 20;
    state.elapsedTicks = 0;
    state.startedTick = 0;
    state.running = false;
    state.paused = false;
    state.finished = false;
    state.lastVisibleSecond = undefined;

    var timerState = snapshot();
    remainingWatcher.reset(timerState.remainingSeconds);
    percentWatcher.reset(timerState.remainingPercent);
    state.lastVisibleSecond = timerState.remainingSeconds;

    emit("configure", timerState);
    return timerState;
  }

  function start() {
    if (!state.configured) {
      configure({ seconds: opts.seconds || 60 });
    }

    if (state.running) return snapshot();

    if (state.finished || state.elapsedTicks >= state.totalTicks) {
      state.elapsedTicks = 0;
      state.finished = false;
      state.paused = false;
      state.lastVisibleSecond = undefined;
    }

    var wasPaused = state.paused && state.elapsedTicks > 0;

    state.startedTick = currentTick();
    state.running = true;
    state.paused = false;

    if (!wasPaused) state.runId += 1;

    var timerState = snapshot();

    if (!wasPaused) {
      remainingWatcher.reset(timerState.remainingSeconds);
      percentWatcher.reset(timerState.remainingPercent);
      state.lastVisibleSecond = timerState.remainingSeconds;

      emit("start", timerState);
      // Initial visible second is also a valid onSecond event.
      emit("second", timerState);
    } else {
      emit("resume", timerState);
    }

    ensureLoop();
    return timerState;
  }

  function pause() {
    if (!state.running) return snapshot();

    state.elapsedTicks = elapsedTicksNow();
    state.running = false;
    state.paused = true;
    clearLoop();

    var timerState = snapshot();
    updateWatchers(timerState);
    emit("pause", timerState);
    return timerState;
  }

  function stop() {
    if (state.running) {
      state.elapsedTicks = elapsedTicksNow();
    }

    state.running = false;
    state.paused = false;
    clearLoop();

    var timerState = snapshot();
    updateWatchers(timerState);
    emit("stop", timerState);
    return timerState;
  }

  function reset() {
    clearLoop();

    state.elapsedTicks = 0;
    state.startedTick = 0;
    state.running = false;
    state.paused = false;
    state.finished = false;
    state.lastVisibleSecond = undefined;

    var timerState = snapshot();
    remainingWatcher.reset(timerState.remainingSeconds);
    percentWatcher.reset(timerState.remainingPercent);
    state.lastVisibleSecond = timerState.remainingSeconds;

    emit("reset", timerState);
    return timerState;
  }

  function restore(savedState) {
    var saved = savedState || {};
    clearLoop();

    var totalTicks = Math.max(
      20,
      Math.floor(
        Number(saved.totalTicks)
        || (Number(saved.totalSeconds) * 20)
        || state.totalTicks
        || 1200
      )
    );

    var elapsedTicks = Math.max(
      0,
      Math.floor(
        Number(saved.elapsedTicks)
        || (Number(saved.elapsedSeconds) * 20)
        || 0
      )
    );

    state.configured = saved.configured !== false;
    state.totalTicks = totalTicks;
    state.elapsedTicks = clamp(
      elapsedTicks,
      0,
      totalTicks
    );
    state.startedTick = 0;

    // A timer that was running before a world/script reload is restored
    // as "paused", then the bar persistence layer may resume it. This
    // avoids counting time while the world was closed and prevents
    // the start callback/message from firing a second time.
    var hadBeenRunning = !!saved.running;
    state.running = false;
    state.paused = (
      (hadBeenRunning || !!saved.paused)
      && state.elapsedTicks < state.totalTicks
    );
    state.finished = (
      !!saved.finished
      || state.elapsedTicks >= state.totalTicks
    );
    state.runId = Math.max(
      0,
      Math.floor(Number(saved.runId) || 0)
    );
    state.lastVisibleSecond = undefined;

    var timerState = snapshot();
    remainingWatcher.reset(timerState.remainingSeconds);
    percentWatcher.reset(timerState.remainingPercent);
    state.lastVisibleSecond = timerState.remainingSeconds;

    return timerState;
  }

  function thresholdDelegate(watcher, method, threshold, callback) {
    if (typeof callback !== "function") return function () {};

    return watcher[method](threshold, function (event) {
      callback(timerEventFromNumeric(event));
    });
  }

  function rangeDelegate(watcher, min, max, callback) {
    if (typeof callback !== "function") return function () {};

    return watcher.onRange(min, max, function (event) {
      callback(timerEventFromNumeric(event));
    });
  }

  // Convenience API:
  // onThreshold({ remainingSeconds: 10 }, callback)
  // onThreshold({ remainingPercent: 50 }, callback)
  // uses <= crossing semantics.
  function onThreshold(config, callback) {
    var input = config || {};

    if (input.remainingSeconds !== undefined) {
      return thresholdDelegate(
        remainingWatcher,
        "onAtOrBelow",
        input.remainingSeconds,
        callback
      );
    }

    if (input.remainingPercent !== undefined) {
      return thresholdDelegate(
        percentWatcher,
        "onAtOrBelow",
        input.remainingPercent,
        callback
      );
    }

    return function () {};
  }

  return {
    configure: configure,
    start: start,
    pause: pause,
    resume: start,
    stop: stop,
    cancel: stop,
    reset: reset,
    restore: restore,
    update: tick,
    getState: snapshot,

    onConfigure: function (callback) { return subscribe("configure", callback); },
    onStart: function (callback) { return subscribe("start", callback); },
    onPause: function (callback) { return subscribe("pause", callback); },
    onResume: function (callback) { return subscribe("resume", callback); },
    onFinish: function (callback) { return subscribe("finish", callback); },
    onStop: function (callback) { return subscribe("stop", callback); },
    onReset: function (callback) { return subscribe("reset", callback); },
    onSecond: function (callback) { return subscribe("second", callback); },

    // Remaining seconds.
    onBelow: function (threshold, callback) {
      return thresholdDelegate(
        remainingWatcher,
        "onBelow",
        threshold,
        callback
      );
    },
    onAtOrBelow: function (threshold, callback) {
      return thresholdDelegate(
        remainingWatcher,
        "onAtOrBelow",
        threshold,
        callback
      );
    },
    onAbove: function (threshold, callback) {
      return thresholdDelegate(
        remainingWatcher,
        "onAbove",
        threshold,
        callback
      );
    },
    onAtOrAbove: function (threshold, callback) {
      return thresholdDelegate(
        remainingWatcher,
        "onAtOrAbove",
        threshold,
        callback
      );
    },
    onEqual: function (threshold, callback) {
      return thresholdDelegate(
        remainingWatcher,
        "onEqual",
        threshold,
        callback
      );
    },
    onRange: function (min, max, callback) {
      return rangeDelegate(
        remainingWatcher,
        min,
        max,
        callback
      );
    },

    // Remaining percentage.
    onPercentBelow: function (threshold, callback) {
      return thresholdDelegate(
        percentWatcher,
        "onBelow",
        threshold,
        callback
      );
    },
    onPercentAtOrBelow: function (threshold, callback) {
      return thresholdDelegate(
        percentWatcher,
        "onAtOrBelow",
        threshold,
        callback
      );
    },
    onPercentAbove: function (threshold, callback) {
      return thresholdDelegate(
        percentWatcher,
        "onAbove",
        threshold,
        callback
      );
    },
    onPercentAtOrAbove: function (threshold, callback) {
      return thresholdDelegate(
        percentWatcher,
        "onAtOrAbove",
        threshold,
        callback
      );
    },
    onPercentRange: function (min, max, callback) {
      return rangeDelegate(
        percentWatcher,
        min,
        max,
        callback
      );
    },

    onThreshold: onThreshold
  };
}

// Singleton used by the current HUD bar timer.
export var barTimer = createReusableTimer({
  id: "barTimer",
  seconds: 60
});
