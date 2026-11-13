import { system } from "@minecraft/server";

// Generic numeric threshold engine.
// It is intentionally independent from timers and scoreboards so the same
// crossing rules can be reused with any numeric game/API value.

function numericValue(value) {
  var number = Number(value);
  if (!isFinite(number)) return undefined;
  return number;
}

function copyMeta(meta) {
  var out = {};
  var source = meta || {};
  for (var key in source) out[key] = source[key];
  return out;
}

export function createNumericWatcher(options) {
  var opts = options || {};
  var listeners = [];
  var hasValue = false;
  var currentValue = undefined;
  var previousValue = undefined;

  function addListener(type, config, callback) {
    if (typeof callback !== "function") {
      return function () {};
    }

    var entry = {
      type: type,
      config: config || {},
      callback: callback,
      active: true
    };
    listeners.push(entry);

    // Every subscription returns an unsubscribe function.
    return function () {
      entry.active = false;
    };
  }

  function eventBase(oldValue, newValue, meta) {
    var direction = "same";
    if (newValue > oldValue) direction = "up";
    if (newValue < oldValue) direction = "down";

    var event = copyMeta(meta);
    event.sourceType = event.sourceType || opts.sourceType || "number";
    event.sourceId = event.sourceId || opts.sourceId || "";
    event.previousValue = oldValue;
    event.value = newValue;
    event.delta = newValue - oldValue;
    event.direction = direction;
    return event;
  }

  // Crossings are used instead of value equality so lag/skipped values do
  // not miss a threshold (for example 51 -> 49 still crosses 50).
  function crossedBelow(oldValue, newValue, threshold) {
    return oldValue >= threshold && newValue < threshold;
  }

  function crossedAtOrBelow(oldValue, newValue, threshold) {
    return oldValue > threshold && newValue <= threshold;
  }

  function crossedAbove(oldValue, newValue, threshold) {
    return oldValue <= threshold && newValue > threshold;
  }

  function crossedAtOrAbove(oldValue, newValue, threshold) {
    return oldValue < threshold && newValue >= threshold;
  }

  function crossedEither(oldValue, newValue, threshold) {
    return (
      (oldValue < threshold && newValue >= threshold)
      || (oldValue > threshold && newValue <= threshold)
    );
  }

  function dispatch(oldValue, newValue, meta) {
    var snapshot = listeners.slice();

    for (var i = 0; i < snapshot.length; i++) {
      var item = snapshot[i];
      if (!item || !item.active) continue;

      var type = item.type;
      var config = item.config || {};
      var threshold = numericValue(config.threshold);
      var shouldFire = false;
      var event = eventBase(oldValue, newValue, meta);

      if (type === "change") {
        shouldFire = oldValue !== newValue;
      } else if (type === "increase") {
        shouldFire = newValue > oldValue;
      } else if (type === "decrease") {
        shouldFire = newValue < oldValue;
      } else if (type === "below" && threshold !== undefined) {
        shouldFire = crossedBelow(oldValue, newValue, threshold);
        event.threshold = threshold;
      } else if (type === "atOrBelow" && threshold !== undefined) {
        shouldFire = crossedAtOrBelow(oldValue, newValue, threshold);
        event.threshold = threshold;
      } else if (type === "above" && threshold !== undefined) {
        shouldFire = crossedAbove(oldValue, newValue, threshold);
        event.threshold = threshold;
      } else if (type === "atOrAbove" && threshold !== undefined) {
        shouldFire = crossedAtOrAbove(oldValue, newValue, threshold);
        event.threshold = threshold;
      } else if (type === "equal" && threshold !== undefined) {
        shouldFire = oldValue !== threshold && newValue === threshold;
        event.threshold = threshold;
      } else if (type === "cross" && threshold !== undefined) {
        shouldFire = crossedEither(oldValue, newValue, threshold);
        event.threshold = threshold;
      } else if (type === "range") {
        var min = numericValue(config.min);
        var max = numericValue(config.max);

        if (min !== undefined && max !== undefined) {
          if (min > max) {
            var swap = min;
            min = max;
            max = swap;
          }

          var wasInside = oldValue >= min && oldValue <= max;
          var isInside = newValue >= min && newValue <= max;
          shouldFire = !wasInside && isInside;
          event.min = min;
          event.max = max;
        }
      }

      if (!shouldFire) continue;

      try {
        item.callback(event);
      } catch (e) {
        try {
          console.warn("[NumericWatcher] callback error: " + e);
        } catch (e2) {}
      }
    }
  }

  function update(value, meta) {
    var next = numericValue(value);
    if (next === undefined) return false;

    if (!hasValue) {
      hasValue = true;
      currentValue = next;
      previousValue = next;
      return true;
    }

    var oldValue = currentValue;
    previousValue = oldValue;
    currentValue = next;

    if (oldValue !== next) {
      dispatch(oldValue, next, meta);
    }

    return true;
  }

  function prime(value) {
    var next = numericValue(value);
    if (next === undefined) return false;

    hasValue = true;
    previousValue = next;
    currentValue = next;
    return true;
  }

  function reset(value) {
    hasValue = false;
    currentValue = undefined;
    previousValue = undefined;
    if (value !== undefined) prime(value);
  }

  return {
    update: update,
    prime: prime,
    reset: reset,
    hasValue: function () { return hasValue; },
    getValue: function () { return currentValue; },
    getPreviousValue: function () { return previousValue; },

    onChange: function (callback) {
      return addListener("change", {}, callback);
    },
    onIncrease: function (callback) {
      return addListener("increase", {}, callback);
    },
    onDecrease: function (callback) {
      return addListener("decrease", {}, callback);
    },
    onBelow: function (threshold, callback) {
      return addListener("below", { threshold: threshold }, callback);
    },
    onAtOrBelow: function (threshold, callback) {
      return addListener("atOrBelow", { threshold: threshold }, callback);
    },
    onAbove: function (threshold, callback) {
      return addListener("above", { threshold: threshold }, callback);
    },
    onAtOrAbove: function (threshold, callback) {
      return addListener("atOrAbove", { threshold: threshold }, callback);
    },
    onEqual: function (threshold, callback) {
      return addListener("equal", { threshold: threshold }, callback);
    },
    onCross: function (threshold, callback) {
      return addListener("cross", { threshold: threshold }, callback);
    },
    onRange: function (min, max, callback) {
      return addListener("range", { min: min, max: max }, callback);
    },

    clearListeners: function () {
      listeners = [];
    }
  };
}

// Watches any API/getter that returns a number.
// Example:
// watchValue(() => game.energy).onBelow(20, callback);
export function watchValue(getter, options) {
  var opts = options || {};
  var intervalTicks = Math.max(
    1,
    Math.floor(Number(opts.intervalTicks) || 1)
  );

  var numeric = createNumericWatcher({
    sourceType: opts.sourceType || "api",
    sourceId: opts.sourceId || "value"
  });

  var handle = undefined;
  var stopped = false;
  var initialized = false;

  function meta() {
    var out = {
      sourceType: opts.sourceType || "api",
      sourceId: opts.sourceId || "value"
    };

    var extra = typeof opts.meta === "function"
      ? opts.meta()
      : opts.meta;

    extra = extra || {};
    for (var key in extra) out[key] = extra[key];
    return out;
  }

  function poll() {
    if (stopped || typeof getter !== "function") return undefined;

    var value;
    try {
      value = getter();
    } catch (e) {
      return undefined;
    }

    var number = numericValue(value);
    if (number === undefined) return undefined;

    // First sample establishes the baseline and intentionally does not fire.
    if (!initialized) {
      initialized = true;
      numeric.prime(number);
      return number;
    }

    numeric.update(number, meta());
    return number;
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

  start();

  return {
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
}
