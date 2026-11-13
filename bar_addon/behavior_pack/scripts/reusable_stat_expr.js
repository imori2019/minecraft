// Calculation for named stats (/rt:stat).
//
// Numbers only, in the spirit of Excel. A formula is read and calculated
// strictly from left to right, like a pocket calculator (no operator
// precedence). ( ) groups a part first. Functions are written like in Excel:
// NAME(value, value, ...). Every value inside is a formula of its own.
//
//   kills.zombie + killed_by.zombie * 2         =  (kills + killed_by) * 2
//   IF(kills.zombie > 10, 100, 0)               =  100 once kills are over 10
//   ROUND(kills.zombie / 3, 1)                  =  rounded to 1 decimal
//   SUM(kills.zombie, killed_by.zombie, deaths)
//
// Equal signs are not used: write  ge  le  eq  ne  (or <>) instead.
//
// No game imports on purpose: stats are checked by a callback.

var OP_CHARS = "+-*/%^<>";
var BINARY_WORDS = ["min", "max", "every", "ge", "le", "eq", "ne", "and", "or"];
var UNARY_WORDS = ["abs", "floor", "ceil", "round", "sqrt", "sign", "not"];

export var STAT_EXPR_MAX_LENGTH = 600;
export var STAT_EXPR_MAX_STATS = 32;
export var STAT_EXPR_MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// numeric helpers
// ---------------------------------------------------------------------------
function finite(value) {
  return isFinite(value) ? value : 0;
}

function yes(flag) {
  return flag ? 1 : 0;
}

function same(a, b) {
  return Math.abs(a - b) < 1e-9;
}

// Half away from zero, like Excel (2.5 -> 3, -2.5 -> -3, 2.345 -> 2.35 at 2).
function scaled(value, digits, mode) {
  var n = Math.max(-15, Math.min(15, Math.floor(digits) || 0));
  var abs = Math.abs(value);
  var shifted = Number(abs + "e" + n);
  var out;

  if (!isFinite(shifted)) return value;

  if (mode === "up") out = Math.ceil(shifted - 1e-9);
  else if (mode === "down") out = Math.floor(shifted + 1e-9);
  else out = Math.round(shifted);

  out = Number(out + "e" + (-n));
  if (!isFinite(out)) return value;
  return value < 0 ? -out : out;
}

function excelRound(value, digits) { return scaled(value, digits, "round"); }
function excelRoundUp(value, digits) { return scaled(value, digits, "up"); }
function excelRoundDown(value, digits) { return scaled(value, digits, "down"); }

function factorial(n) {
  var k = Math.floor(n);
  if (k < 0 || k > 170) return 0;
  var out = 1;
  for (var i = 2; i <= k; i++) out *= i;
  return finite(out);
}

function gcd2(a, b) {
  var x = Math.abs(Math.floor(a));
  var y = Math.abs(Math.floor(b));
  while (y > 0) {
    var t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function sumOf(list) {
  var total = 0;
  for (var i = 0; i < list.length; i++) total += list[i];
  return total;
}

function varianceOf(list, sample) {
  var n = list.length;
  if (n < 1 || (sample && n < 2)) return 0;
  var mean = sumOf(list) / n;
  var squares = 0;
  for (var i = 0; i < n; i++) squares += (list[i] - mean) * (list[i] - mean);
  return squares / (sample ? n - 1 : n);
}

function medianOf(list) {
  var sorted = list.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function evenOdd(value, wantEven) {
  var away = value < 0 ? -Math.ceil(Math.abs(value)) : Math.ceil(value);
  var isEven = Math.abs(away) % 2 === 0;
  if (wantEven === isEven) return away;
  return away + (value < 0 ? -1 : 1);
}

// ---------------------------------------------------------------------------
// Excel-style functions: name -> [minArgs, maxArgs, fn(args)]
// ---------------------------------------------------------------------------
var MANY = 32;

var FUNCTIONS = {
  // sign, roots, powers, logs
  ABS: [1, 1, function (a) { return Math.abs(a[0]); }],
  SIGN: [1, 1, function (a) { return a[0] > 0 ? 1 : (a[0] < 0 ? -1 : 0); }],
  SQRT: [1, 1, function (a) { return a[0] < 0 ? 0 : Math.sqrt(a[0]); }],
  EXP: [1, 1, function (a) { return Math.exp(a[0]); }],
  LN: [1, 1, function (a) { return a[0] > 0 ? Math.log(a[0]) : 0; }],
  LOG10: [1, 1, function (a) { return a[0] > 0 ? Math.log(a[0]) / Math.LN10 : 0; }],
  LOG: [1, 2, function (a) {
    var base = a.length > 1 ? a[1] : 10;
    if (a[0] <= 0 || base <= 0 || base === 1) return 0;
    return Math.log(a[0]) / Math.log(base);
  }],
  POWER: [2, 2, function (a) { return Math.pow(a[0], a[1]); }],

  // remainder, division
  MOD: [2, 2, function (a) { return a[1] === 0 ? 0 : a[0] - a[1] * Math.floor(a[0] / a[1]); }],
  QUOTIENT: [2, 2, function (a) { return a[1] === 0 ? 0 : Math.trunc(a[0] / a[1]); }],

  // rounding
  INT: [1, 1, function (a) { return Math.floor(a[0]); }],
  TRUNC: [1, 2, function (a) { return excelRoundDown(a[0], a.length > 1 ? a[1] : 0); }],
  ROUND: [1, 2, function (a) { return excelRound(a[0], a.length > 1 ? a[1] : 0); }],
  ROUNDUP: [1, 2, function (a) { return excelRoundUp(a[0], a.length > 1 ? a[1] : 0); }],
  ROUNDDOWN: [1, 2, function (a) { return excelRoundDown(a[0], a.length > 1 ? a[1] : 0); }],
  CEILING: [1, 2, function (a) {
    var sig = a.length > 1 ? a[1] : 1;
    return sig === 0 ? 0 : Math.ceil(a[0] / sig - 1e-9) * sig;
  }],
  FLOOR: [1, 2, function (a) {
    var sig = a.length > 1 ? a[1] : 1;
    return sig === 0 ? 0 : Math.floor(a[0] / sig + 1e-9) * sig;
  }],
  MROUND: [2, 2, function (a) { return a[1] === 0 ? 0 : excelRound(a[0] / a[1], 0) * a[1]; }],
  EVEN: [1, 1, function (a) { return evenOdd(a[0], true); }],
  ODD: [1, 1, function (a) { return evenOdd(a[0], false); }],

  // counting
  FACT: [1, 1, function (a) { return factorial(a[0]); }],
  COMBIN: [2, 2, function (a) {
    var n = Math.floor(a[0]);
    var k = Math.floor(a[1]);
    if (n < 0 || k < 0 || k > n || n > 170) return 0;
    return Math.round(factorial(n) / (factorial(k) * factorial(n - k)));
  }],
  PERMUT: [2, 2, function (a) {
    var n = Math.floor(a[0]);
    var k = Math.floor(a[1]);
    if (n < 0 || k < 0 || k > n || n > 170) return 0;
    return Math.round(factorial(n) / factorial(n - k));
  }],
  GCD: [1, MANY, function (a) {
    var out = 0;
    for (var i = 0; i < a.length; i++) out = gcd2(out, a[i]);
    return out;
  }],
  LCM: [1, MANY, function (a) {
    var out = 1;
    for (var i = 0; i < a.length; i++) {
      var v = Math.abs(Math.floor(a[i]));
      if (v === 0) return 0;
      out = out / gcd2(out, v) * v;
    }
    return out;
  }],

  // angles
  PI: [0, 0, function () { return Math.PI; }],
  RADIANS: [1, 1, function (a) { return a[0] * Math.PI / 180; }],
  DEGREES: [1, 1, function (a) { return a[0] * 180 / Math.PI; }],
  SIN: [1, 1, function (a) { return Math.sin(a[0]); }],
  COS: [1, 1, function (a) { return Math.cos(a[0]); }],
  TAN: [1, 1, function (a) { return Math.tan(a[0]); }],
  ASIN: [1, 1, function (a) { return Math.abs(a[0]) > 1 ? 0 : Math.asin(a[0]); }],
  ACOS: [1, 1, function (a) { return Math.abs(a[0]) > 1 ? 0 : Math.acos(a[0]); }],
  ATAN: [1, 1, function (a) { return Math.atan(a[0]); }],
  ATAN2: [2, 2, function (a) { return Math.atan2(a[1], a[0]); }],
  SINH: [1, 1, function (a) { return Math.sinh(a[0]); }],
  COSH: [1, 1, function (a) { return Math.cosh(a[0]); }],
  TANH: [1, 1, function (a) { return Math.tanh(a[0]); }],

  // several values
  SUM: [1, MANY, function (a) { return sumOf(a); }],
  PRODUCT: [1, MANY, function (a) {
    var out = 1;
    for (var i = 0; i < a.length; i++) out *= a[i];
    return out;
  }],
  SUMSQ: [1, MANY, function (a) {
    var out = 0;
    for (var i = 0; i < a.length; i++) out += a[i] * a[i];
    return out;
  }],
  AVERAGE: [1, MANY, function (a) { return sumOf(a) / a.length; }],
  MEDIAN: [1, MANY, function (a) { return medianOf(a); }],
  MAX: [1, MANY, function (a) { return Math.max.apply(null, a); }],
  MIN: [1, MANY, function (a) { return Math.min.apply(null, a); }],
  STDEV: [1, MANY, function (a) { return Math.sqrt(varianceOf(a, true)); }],
  STDEVP: [1, MANY, function (a) { return Math.sqrt(varianceOf(a, false)); }],
  VAR: [1, MANY, function (a) { return varianceOf(a, true); }],
  VARP: [1, MANY, function (a) { return varianceOf(a, false); }],

  // logic and choosing
  IF: [2, 3, function (a) { return a[0] !== 0 ? a[1] : (a.length > 2 ? a[2] : 0); }],
  IFS: [2, MANY, function (a) {
    for (var i = 0; i + 1 < a.length; i += 2) {
      if (a[i] !== 0) return a[i + 1];
    }
    return 0;
  }],
  SWITCH: [3, MANY, function (a) {
    // SWITCH(value, case1, result1, case2, result2, ... [, other])
    var n = a.length;
    var hasOther = (n - 1) % 2 === 1;
    var last = hasOther ? n - 2 : n - 1;

    for (var i = 1; i + 1 <= last; i += 2) {
      if (same(a[0], a[i])) return a[i + 1];
    }
    return hasOther ? a[n - 1] : 0;
  }],
  CHOOSE: [2, MANY, function (a) {
    var index = Math.floor(a[0]);
    return index >= 1 && index < a.length ? a[index] : 0;
  }],
  AND: [1, MANY, function (a) {
    for (var i = 0; i < a.length; i++) if (a[i] === 0) return 0;
    return 1;
  }],
  OR: [1, MANY, function (a) {
    for (var i = 0; i < a.length; i++) if (a[i] !== 0) return 1;
    return 0;
  }],
  XOR: [1, MANY, function (a) {
    var count = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== 0) count++;
    return count % 2;
  }],
  NOT: [1, 1, function (a) { return yes(a[0] === 0); }],
  TRUE: [0, 0, function () { return 1; }],
  FALSE: [0, 0, function () { return 0; }],
  ISEVEN: [1, 1, function (a) { return yes(Math.floor(Math.abs(a[0])) % 2 === 0); }],
  ISODD: [1, 1, function (a) { return yes(Math.floor(Math.abs(a[0])) % 2 === 1); }]
};

export function statExpressionFunctionNames() {
  return Object.keys(FUNCTIONS);
}

function lookupFunction(name) {
  var id = String(name || "").toUpperCase();
  return Object.prototype.hasOwnProperty.call(FUNCTIONS, id) ? id : "";
}

// ---------------------------------------------------------------------------
// reading the formula
// ---------------------------------------------------------------------------
function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\u3000";
}

function numberAt(text, start) {
  var match = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(start));
  return match ? match[1] : "";
}

function fail(message) {
  return { ok: false, items: [], error: message };
}

// Turns the text into items:
//   { k: "stat", key } { k: "num", n } { k: "group", items }
//   { k: "call", fn, args: [items, ...] } { k: "op", op } { k: "fn", fn }
// resolveStat(spec) -> { ok, key, error }
export function compileStatExpression(text, resolveStat) {
  var s = String(text === undefined || text === null ? "" : text).trim();

  if (!s) return fail("Formula is empty");
  if (s.length > STAT_EXPR_MAX_LENGTH) {
    return fail("Formula is too long (" + STAT_EXPR_MAX_LENGTH + " characters at most)");
  }

  var pos = 0;
  var statCount = 0;

  function skipSpaces() {
    while (pos < s.length && isSpace(s.charAt(pos))) pos++;
  }

  function readWord() {
    var start = pos;
    while (
      pos < s.length
      && !isSpace(s.charAt(pos))
      && OP_CHARS.indexOf(s.charAt(pos)) < 0
      && s.charAt(pos) !== "("
      && s.charAt(pos) !== ")"
      && s.charAt(pos) !== ","
    ) {
      pos++;
    }
    return s.slice(start, pos);
  }

  function isReservedWord(lower) {
    return lower === "then" || lower === "else"
      || BINARY_WORDS.indexOf(lower) >= 0 || UNARY_WORDS.indexOf(lower) >= 0;
  }

  // One value: a number, a stat, ( ... ), a function call, or -value.
  function readTerm(depth) {
    skipSpaces();
    if (pos >= s.length) return fail("The formula ends with an operator");

    var ch = s.charAt(pos);

    if (ch === "(") {
      if (depth + 1 > STAT_EXPR_MAX_DEPTH) {
        return fail("Too many nested ( ) (" + STAT_EXPR_MAX_DEPTH + " levels at most)");
      }
      pos++;
      var inner = parseSequence(depth + 1, false);
      if (!inner.ok) return inner;
      return { ok: true, term: { k: "group", items: inner.items } };
    }

    if (ch === "-" || ch === "+") {
      pos++;
      skipSpaces();
      var digits = numberAt(s, pos);
      if (digits) {
        pos += digits.length;
        return { ok: true, term: { k: "num", n: ch === "-" ? -Number(digits) : Number(digits) } };
      }
      var next = readTerm(depth);
      if (!next.ok) return next;
      if (ch === "+") return next;
      return {
        ok: true,
        term: {
          k: "group",
          items: [{ k: "num", n: 0 }, { k: "op", op: "-" }, next.term]
        }
      };
    }

    if (ch === ")" || ch === ",") {
      return fail("A value is missing before '" + ch + "'");
    }

    if (OP_CHARS.indexOf(ch) >= 0) {
      return fail("Unexpected '" + ch + "' (a value is needed before it)");
    }

    var digitsHere = numberAt(s, pos);
    if (digitsHere && (pos + digitsHere.length >= s.length
      || isSpace(s.charAt(pos + digitsHere.length))
      || OP_CHARS.indexOf(s.charAt(pos + digitsHere.length)) >= 0
      || ")(,".indexOf(s.charAt(pos + digitsHere.length)) >= 0)) {
      pos += digitsHere.length;
      return { ok: true, term: { k: "num", n: Number(digitsHere) } };
    }

    var word = readWord();
    var lower = word.toLowerCase();

    if (word.charAt(0) === "=" || word.charAt(0) === "!") {
      return fail("'" + word + "' cannot be used. Use ge, le, eq, ne (or <>) instead of = symbols");
    }

    // NAME( ... )
    var look = pos;
    while (look < s.length && isSpace(s.charAt(look))) look++;
    if (s.charAt(look) === "(" && word) {
      var fn = lookupFunction(word);
      if (!fn) {
        var asStat = resolveStat(word);
        if (asStat && asStat.ok) {
          return fail("An operator is missing before '('");
        }
        return fail("Unknown function '" + word + "'. Examples: IF, ROUND, SUM, MAX, MIN, AVERAGE, MOD");
      }
      if (depth + 1 > STAT_EXPR_MAX_DEPTH) {
        return fail("Too many nested ( ) (" + STAT_EXPR_MAX_DEPTH + " levels at most)");
      }
      pos = look + 1;

      var args = [];
      while (true) {
        var part = parseSequence(depth + 1, true);
        if (!part.ok) return part;

        if (part.items.length === 0) {
          if (args.length === 0 && part.end === ")") break;
          return fail("A value is missing in " + fn + "( )");
        }
        args.push(part.items);
        if (part.end === ")") break;
      }

      var spec = FUNCTIONS[fn];
      if (args.length < spec[0] || args.length > spec[1]) {
        var range = spec[0] === spec[1] ? String(spec[0]) : (spec[0] + " to " + (spec[1] >= MANY ? "many" : spec[1]));
        return fail(fn + " needs " + range + " value(s), but " + args.length + " were given");
      }
      if (fn === "IFS" && args.length % 2 !== 0) {
        return fail("IFS needs pairs: IFS(condition, value, condition, value ...)");
      }
      if (fn === "SWITCH" && args.length < 3) {
        return fail("SWITCH needs: SWITCH(value, case, result, ... [, other])");
      }
      return { ok: true, term: { k: "call", fn: fn, args: args } };
    }

    if (!word) return fail("Unexpected '" + ch + "'");

    if (lower === "true") return { ok: true, term: { k: "num", n: 1 } };
    if (lower === "false") return { ok: true, term: { k: "num", n: 0 } };
    if (lower === "pi") return { ok: true, term: { k: "num", n: Math.PI } };

    if (isReservedWord(lower)) {
      return fail("'" + word + "' needs a value before it");
    }

    var member = resolveStat(word);
    if (!member || !member.ok) {
      return fail((member && member.error) || ("Unknown stat '" + word + "'"));
    }
    statCount++;
    if (statCount > STAT_EXPR_MAX_STATS) {
      return fail("Too many stats (" + STAT_EXPR_MAX_STATS + " at most)");
    }
    return { ok: true, term: { k: "stat", key: member.key } };
  }

  // value (operator value | function)* ... until the end, ")" or ","
  function parseSequence(depth, inCall) {
    var items = [];
    var thenOpen = false;      // a "then" is waiting for its "else"

    while (true) {
      skipSpaces();

      var expectValue = items.length === 0
        || items[items.length - 1].k === "op";

      if (pos >= s.length) {
        if (depth > 0) return fail("A ')' is missing");
        if (expectValue && items.length > 0) return fail("The formula ends with an operator");
        return { ok: true, items: items, end: "" };
      }

      var ch = s.charAt(pos);

      if (expectValue) {
        // an empty ( ) of a function with no values, e.g. PI()
        if (ch === ")" && inCall && items.length === 0) {
          pos++;
          return { ok: true, items: items, end: ")" };
        }
        var term = readTerm(depth);
        if (!term.ok) return term;
        items.push(term.term);
        continue;
      }

      if (ch === ")") {
        if (depth === 0) return fail("There is a ')' without a '('");
        pos++;
        return { ok: true, items: items, end: ")" };
      }

      if (ch === ",") {
        if (!inCall) return fail("',' can only be used between the values of a function, e.g. SUM(a, b)");
        pos++;
        return { ok: true, items: items, end: "," };
      }

      if (ch === "(") {
        return fail("An operator is missing before '('");
      }

      if (OP_CHARS.indexOf(ch) >= 0) {
        if (ch === "<" && s.charAt(pos + 1) === ">") {
          items.push({ k: "op", op: "ne" });
          pos += 2;
        } else {
          items.push({ k: "op", op: ch });
          pos++;
        }
        continue;
      }

      var word = readWord();
      var lower = word.toLowerCase();

      if (word.charAt(0) === "=" || word.charAt(0) === "!") {
        return fail("'" + word + "' cannot be used. Use ge, le, eq, ne (or <>) instead of = symbols");
      }

      if (lower === "then") {
        if (thenOpen) return fail("'then' is used twice without 'else'");
        items.push({ k: "op", op: "then" });
        thenOpen = true;
        continue;
      }

      if (lower === "else") {
        if (!thenOpen) return fail("'else' needs a 'then' before it");
        items.push({ k: "op", op: "else" });
        thenOpen = false;
        continue;
      }

      if (BINARY_WORDS.indexOf(lower) >= 0) {
        items.push({ k: "op", op: lower });
        continue;
      }

      if (UNARY_WORDS.indexOf(lower) >= 0) {
        items.push({ k: "fn", fn: lower });
        continue;
      }

      return fail("An operator is missing before '" + word + "'");
    }
  }

  var result = parseSequence(0, false);
  if (!result.ok) return fail(result.error);
  if (result.items.length === 0) return fail("Formula is empty");

  if (statCount <= 0) return fail("Use at least one stat in the formula");
  return { ok: true, items: result.items, error: "" };
}

// ---------------------------------------------------------------------------
// calculating
// ---------------------------------------------------------------------------
function applyBinary(op, a, b) {
  switch (op) {
    case "+": return finite(a + b);
    case "-": return finite(a - b);
    case "*": return finite(a * b);
    case "/": return b === 0 ? 0 : finite(a / b);
    case "%": return b === 0 ? 0 : finite(a % b);
    case "^": return finite(Math.pow(a, b));
    case "min": return Math.min(a, b);
    case "max": return Math.max(a, b);
    case "every": return b === 0 ? 0 : Math.floor(a / b);
    case ">": return yes(a > b);
    case "<": return yes(a < b);
    case "ge": return yes(a >= b || same(a, b));
    case "le": return yes(a <= b || same(a, b));
    case "eq": return yes(same(a, b));
    case "ne": return yes(!same(a, b));
    case "and": return yes(a !== 0 && b !== 0);
    case "or": return yes(a !== 0 || b !== 0);
  }
  return a;
}

function applyFunction(fn, a) {
  switch (fn) {
    case "abs": return Math.abs(a);
    case "floor": return Math.floor(a);
    case "ceil": return Math.ceil(a);
    case "round": return excelRound(a, 0);
    case "sqrt": return a < 0 ? 0 : Math.sqrt(a);
    case "sign": return a > 0 ? 1 : (a < 0 ? -1 : 0);
    case "not": return yes(a === 0);
  }
  return a;
}

// valueOf(key) -> number
export function evaluateStatExpression(items, valueOf) {
  var list = Array.isArray(items) ? items : [];
  var acc = 0;
  var started = false;
  var pending = "";
  var condition = false;       // result of the last "then"

  for (var i = 0; i < list.length; i++) {
    var item = list[i];

    if (item.k === "stat" || item.k === "num" || item.k === "group" || item.k === "call") {
      var value;
      if (item.k === "stat") {
        value = Number(valueOf(item.key)) || 0;
      } else if (item.k === "num") {
        value = Number(item.n) || 0;
      } else if (item.k === "group") {
        value = evaluateStatExpression(item.items, valueOf);
      } else {
        var spec = FUNCTIONS[item.fn];
        var args = [];
        for (var a = 0; a < item.args.length; a++) {
          args.push(evaluateStatExpression(item.args[a], valueOf));
        }
        value = spec ? finite(Number(spec[2](args))) : 0;
      }

      if (!started) {
        acc = value;
        started = true;
      } else if (pending === "then") {
        condition = acc !== 0;
        acc = condition ? value : 0;
      } else if (pending === "else") {
        acc = condition ? acc : value;
      } else {
        acc = applyBinary(pending, acc, value);
      }
      pending = "";
    } else if (item.k === "op") {
      pending = item.op;
    } else if (item.k === "fn") {
      acc = applyFunction(item.fn, acc);
    }
  }

  return finite(acc);
}

export function statExpressionKeys(items) {
  var keys = [];

  function walk(list) {
    var source = Array.isArray(list) ? list : [];
    for (var i = 0; i < source.length; i++) {
      var item = source[i];
      if (item.k === "stat") {
        if (keys.indexOf(item.key) < 0) keys.push(item.key);
      } else if (item.k === "group") {
        walk(item.items);
      } else if (item.k === "call") {
        for (var a = 0; a < item.args.length; a++) walk(item.args[a]);
      }
    }
  }

  walk(items);
  return keys;
}

export function describeStatExpression(items) {
  var list = Array.isArray(items) ? items : [];
  var parts = [];

  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item.k === "stat") parts.push(item.key);
    else if (item.k === "num") parts.push(String(Math.round(item.n * 1e9) / 1e9));
    else if (item.k === "op") parts.push(item.op);
    else if (item.k === "fn") parts.push(item.fn);
    else if (item.k === "group") parts.push("(" + describeStatExpression(item.items) + ")");
    else if (item.k === "call") {
      parts.push(item.fn + "(" + item.args.map(describeStatExpression).join(", ") + ")");
    }
  }
  return parts.join(" ");
}

// Checks items read back from the world (they may be damaged or old).
// Returns a clean copy, or [] when anything is wrong.
export function cleanStatExpressionItems(raw, depth) {
  var level = depth || 0;
  if (!Array.isArray(raw) || raw.length <= 0 || level > STAT_EXPR_MAX_DEPTH) return [];

  var items = [];
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    if (!item || typeof item !== "object") return [];

    if (item.k === "stat" && typeof item.key === "string" && item.key) {
      items.push({ k: "stat", key: item.key });
    } else if (item.k === "num" && isFinite(Number(item.n))) {
      items.push({ k: "num", n: Number(item.n) });
    } else if (item.k === "op" && typeof item.op === "string") {
      items.push({ k: "op", op: item.op });
    } else if (item.k === "fn" && typeof item.fn === "string") {
      items.push({ k: "fn", fn: item.fn });
    } else if (item.k === "group") {
      var inner = cleanStatExpressionItems(item.items, level + 1);
      if (inner.length <= 0) return [];
      items.push({ k: "group", items: inner });
    } else if (item.k === "call" && lookupFunction(item.fn) && Array.isArray(item.args)) {
      var args = [];
      for (var a = 0; a < item.args.length; a++) {
        var cleaned = cleanStatExpressionItems(item.args[a], level + 1);
        if (cleaned.length <= 0) return [];
        args.push(cleaned);
      }
      items.push({ k: "call", fn: lookupFunction(item.fn), args: args });
    } else {
      return [];
    }
  }
  return items;
}

// Older worlds stored a plain list of keys that were added up.
export function itemsFromLegacyKeys(keys) {
  var items = [];
  for (var i = 0; i < keys.length; i++) {
    if (i > 0) items.push({ k: "op", op: "+" });
    items.push({ k: "stat", key: String(keys[i]) });
  }
  return items;
}
