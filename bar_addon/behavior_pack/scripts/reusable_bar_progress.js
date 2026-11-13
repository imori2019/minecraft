function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeDirection(value) {
  var text = String(value || "").toLowerCase();
  return (
    text === "down"
    || text === "countdown"
  ) ? "down" : "up";
}

function createListenerBucket() {
  var listeners = [];

  return {
    add: function (callback) {
      if (typeof callback !== "function") {
        return function () {};
      }

      listeners.push(callback);

      return function () {
        var index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },

    emit: function (event) {
      var copy = listeners.slice();

      for (var i = 0; i < copy.length; i++) {
        try {
          copy[i](event);
        } catch (e) {}
      }
    }
  };
}

export function createReusableBarProgress(options) {
  var input = options || {};

  var state = {
    direction: normalizeDirection(input.direction),
    maxValue: Math.max(
      1,
      Math.floor(Number(input.maxValue) || 100)
    ),
    value: 0,
    runId: 0,
    complete: false
  };

  var changeListeners = createListenerBucket();
  var completeListeners = createListenerBucket();
  var resetListeners = createListenerBucket();

  function initialValue() {
    return state.direction === "down"
      ? state.maxValue
      : 0;
  }

  function snapshot() {
    return {
      direction: state.direction,
      maxValue: state.maxValue,
      value: state.value,
      runId: state.runId,
      complete: state.complete,
      percent: state.maxValue > 0
        ? (state.value / state.maxValue) * 100
        : 0
    };
  }

  function computeComplete(value) {
    if (state.direction === "down") {
      return value <= 0;
    }

    return value >= state.maxValue;
  }

  function emitChange(previousValue, reason) {
    var current = snapshot();

    changeListeners.emit({
      previousValue: previousValue,
      value: current.value,
      delta: current.value - previousValue,
      reason: String(reason || "set"),
      state: current
    });

    if (current.complete) {
      completeListeners.emit({
        reason: String(reason || "set"),
        state: current
      });
    }

    return current;
  }

  function configure(config) {
    var next = config || {};

    state.direction = normalizeDirection(
      next.direction === undefined
        ? state.direction
        : next.direction
    );

    state.maxValue = Math.max(
      1,
      Math.floor(
        Number(
          next.maxValue === undefined
            ? state.maxValue
            : next.maxValue
        ) || 1
      )
    );

    var configuredValue = (
      next.value === undefined
        ? initialValue()
        : Number(next.value)
    );

    state.value = clamp(
      configuredValue,
      0,
      state.maxValue
    );
    state.complete = computeComplete(state.value);
    state.runId++;

    var current = snapshot();

    changeListeners.emit({
      previousValue: current.value,
      value: current.value,
      delta: 0,
      reason: "configure",
      state: current
    });

    return current;
  }

  function setValue(value, reason) {
    var previous = state.value;

    state.value = clamp(
      value,
      0,
      state.maxValue
    );
    state.complete = computeComplete(state.value);

    return emitChange(previous, reason || "set");
  }

  function add(amount) {
    return setValue(
      state.value + (Number(amount) || 0),
      "add"
    );
  }

  function subtract(amount) {
    return setValue(
      state.value - (Number(amount) || 0),
      "subtract"
    );
  }

  // Direction-aware step.
  // UP:   step(1) => +1
  // DOWN: step(1) => -1
  function step(amount) {
    var delta = Math.abs(Number(amount) || 1);

    if (state.direction === "down") {
      return subtract(delta);
    }

    return add(delta);
  }

  function reset() {
    var previous = state.value;

    state.value = initialValue();
    state.complete = computeComplete(state.value);
    state.runId++;

    var current = snapshot();

    resetListeners.emit({
      previousValue: previous,
      state: current
    });

    changeListeners.emit({
      previousValue: previous,
      value: current.value,
      delta: current.value - previous,
      reason: "reset",
      state: current
    });

    return current;
  }

  function restore(savedState) {
    var saved = savedState || {};

    state.direction = normalizeDirection(
      saved.direction === undefined
        ? state.direction
        : saved.direction
    );

    state.maxValue = Math.max(
      1,
      Math.floor(Number(saved.maxValue) || state.maxValue || 1)
    );

    state.value = clamp(
      saved.value === undefined
        ? initialValue()
        : saved.value,
      0,
      state.maxValue
    );

    state.runId = Math.max(
      0,
      Math.floor(Number(saved.runId) || 0)
    );

    state.complete = computeComplete(state.value);

    return snapshot();
  }

  state.value = initialValue();
  state.complete = computeComplete(state.value);

  return {
    configure: configure,
    setValue: setValue,
    add: add,
    subtract: subtract,
    step: step,
    reset: reset,
    restore: restore,
    getState: snapshot,

    onChange: changeListeners.add,
    onComplete: completeListeners.add,
    onReset: resetListeners.add
  };
}

export var barProgress = createReusableBarProgress({
  direction: "up",
  maxValue: 100
});
