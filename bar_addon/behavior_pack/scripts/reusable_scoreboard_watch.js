import { system, world } from "@minecraft/server";
import { createNumericWatcher } from "./reusable_numeric_watch.js";

function stringValue(value) {
  return String(
    value === undefined || value === null ? "" : value
  );
}

function scoreboardValue(objectiveId, participant) {
  try {
    var objective = world.scoreboard.getObjective(
      stringValue(objectiveId)
    );

    if (!objective) return undefined;
    return objective.getScore(participant);
  } catch (e) {}

  return undefined;
}

export function getScoreValue(objectiveId, participant) {
  return scoreboardValue(objectiveId, participant);
}

// Watches one scoreboard participant (player, identity, or fake-player string).
export function watchScore(
  objectiveOrOptions,
  participantValue,
  optionsValue
) {
  var options = {};

  if (
    objectiveOrOptions
    && typeof objectiveOrOptions === "object"
    && !Array.isArray(objectiveOrOptions)
  ) {
    options = objectiveOrOptions;
  } else {
    options.objective = objectiveOrOptions;
    options.participant = participantValue;

    var extra = optionsValue || {};
    for (var key in extra) options[key] = extra[key];
  }

  var objectiveId = stringValue(options.objective);
  var participant = options.participant;
  var intervalTicks = Math.max(
    1,
    Math.floor(Number(options.intervalTicks) || 1)
  );

  var numeric = createNumericWatcher({
    sourceType: "scoreboard",
    sourceId: objectiveId + ":" + stringValue(participant)
  });

  var handle = undefined;
  var stopped = false;
  var initialized = false;

  function meta() {
    return {
      sourceType: "scoreboard",
      sourceId: objectiveId + ":" + stringValue(participant),
      objective: objectiveId,
      participant: participant
    };
  }

  function poll() {
    if (stopped) return undefined;

    var value = scoreboardValue(objectiveId, participant);
    if (value === undefined) return undefined;

    // Initial score establishes the baseline and intentionally does not fire.
    if (!initialized) {
      initialized = true;
      numeric.prime(value);
      return value;
    }

    numeric.update(value, meta());
    return value;
  }

  function start() {
    if (handle !== undefined || stopped) return;

    poll();
    handle = system.runInterval(function () {
      poll();
    }, intervalTicks);
  }

  function stop() {
    stopped = true;

    if (handle === undefined) return;
    try {
      system.clearRun(handle);
    } catch (e) {}

    handle = undefined;
  }

  var api = {
    poll: poll,
    stop: stop,
    getValue: numeric.getValue,

    onChange: numeric.onChange,
    onIncrease: numeric.onIncrease,
    onDecrease: numeric.onDecrease,
    onBelow: numeric.onBelow,
    onAtOrBelow: numeric.onAtOrBelow,
    onAbove: numeric.onAbove,
    onAtOrAbove: numeric.onAtOrAbove,
    onEqual: numeric.onEqual,
    onCross: numeric.onCross,
    onRange: numeric.onRange
  };

  start();
  return api;
}

// Optional bridge: expose timer state back to a Minecraft scoreboard.
// Default field is remainingSeconds.
export function mirrorTimerToScoreboard(timer, options) {
  var opts = options || {};
  var objectiveId = stringValue(opts.objective);
  var participant = opts.participant;
  var field = stringValue(opts.field || "remainingSeconds");
  var createObjective = !!opts.createObjective;
  var subscriptions = [];

  function objective() {
    var target;

    try {
      target = world.scoreboard.getObjective(objectiveId);
    } catch (e) {}

    if (!target && createObjective) {
      try {
        target = world.scoreboard.addObjective(
          objectiveId,
          stringValue(opts.displayName || objectiveId)
        );
      } catch (e2) {}
    }

    return target;
  }

  function write(state) {
    if (!state) return;

    var value = Number(state[field]);
    if (!isFinite(value)) return;

    var target = objective();
    if (!target) return;

    try {
      target.setScore(participant, Math.floor(value));
    } catch (e) {}
  }

  if (!timer || typeof timer.getState !== "function") {
    return {
      sync: function () {},
      stop: function () {}
    };
  }

  function subscribe(method) {
    if (typeof timer[method] !== "function") return;
    subscriptions.push(timer[method](write));
  }

  subscribe("onStart");
  subscribe("onResume");
  subscribe("onPause");
  subscribe("onSecond");
  subscribe("onFinish");
  subscribe("onReset");

  write(timer.getState());

  return {
    sync: function () {
      write(timer.getState());
    },
    stop: function () {
      for (var i = 0; i < subscriptions.length; i++) {
        try {
          subscriptions[i]();
        } catch (e) {}
      }
      subscriptions = [];
    }
  };
}
