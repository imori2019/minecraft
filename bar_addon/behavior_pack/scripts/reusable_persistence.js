import { world } from "@minecraft/server";

var PERSISTENCE_CHUNK_CHARS = 7000;

function metaKey(prefix) {
  return String(prefix || "") + ":meta";
}

function legacyChunkKey(prefix, index) {
  return String(prefix || "") + ":chunk:" + String(index);
}

function bankChunkKey(prefix, bank, index) {
  return String(prefix || "")
    + ":"
    + String(bank || "a")
    + ":chunk:"
    + String(index);
}

function safeRemoveDynamicProperty(key) {
  try {
    world.setDynamicProperty(key, undefined);
    return;
  } catch (e) {}

  try {
    world.setDynamicProperty(key, "");
  } catch (e2) {}
}

function readMeta(prefix) {
  try {
    var raw = world.getDynamicProperty(metaKey(prefix));
    if (typeof raw !== "string" || !raw) return undefined;

    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch (e) {}

  return undefined;
}

export function canAccessWorldDynamicProperties(prefix) {
  try {
    world.getDynamicProperty(metaKey(String(prefix || "__rt_probe")));
    return true;
  } catch (e) {}

  return false;
}

function chunkKeyForMeta(prefix, meta, index) {
  var bank = String((meta && meta.bank) || "");
  if (bank === "a" || bank === "b") {
    return bankChunkKey(prefix, bank, index);
  }

  // v1 persistence used unbanked :chunk:N keys.
  return legacyChunkKey(prefix, index);
}

function clearChunkSet(prefix, meta) {
  if (!meta || typeof meta !== "object") return;

  var count = Math.max(
    0,
    Math.floor(Number(meta.chunks) || 0)
  );

  for (var i = 0; i < count; i++) {
    safeRemoveDynamicProperty(
      chunkKeyForMeta(prefix, meta, i)
    );
  }
}

export function writeChunkedJson(prefix, value) {
  var id = String(prefix || "");
  if (!id) return false;

  var text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    return false;
  }

  var chunks = [];
  for (
    var start = 0;
    start < text.length;
    start += PERSISTENCE_CHUNK_CHARS
  ) {
    chunks.push(
      text.slice(start, start + PERSISTENCE_CHUNK_CHARS)
    );
  }

  if (chunks.length <= 0) chunks.push(text);

  var previous = readMeta(id);
  var previousBank = String(
    (previous && previous.bank) || ""
  );

  // Always write to the inactive bank. The old meta remains valid until
  // the new bank is completely written and the final meta commit succeeds.
  var nextBank = previousBank === "a" ? "b" : "a";
  var writtenKeys = [];

  try {
    for (var i = 0; i < chunks.length; i++) {
      var key = bankChunkKey(id, nextBank, i);
      world.setDynamicProperty(key, chunks[i]);
      writtenKeys.push(key);
    }

    // Atomic commit point.
    world.setDynamicProperty(
      metaKey(id),
      JSON.stringify({
        version: 2,
        bank: nextBank,
        chunks: chunks.length,
        length: text.length
      })
    );
  } catch (e2) {
    // A partial inactive bank must never replace the previous readable state.
    for (var cleanup = 0; cleanup < writtenKeys.length; cleanup++) {
      safeRemoveDynamicProperty(writtenKeys[cleanup]);
    }
    return false;
  }

  // Commit succeeded, so the old bank/legacy chunks are now disposable.
  clearChunkSet(id, previous);
  return true;
}

export function readChunkedJson(prefix) {
  var id = String(prefix || "");
  if (!id) return undefined;

  var meta = readMeta(id);
  if (!meta) return undefined;

  var count = Math.max(
    0,
    Math.floor(Number(meta.chunks) || 0)
  );
  if (count <= 0) return undefined;

  var parts = [];

  try {
    for (var i = 0; i < count; i++) {
      var part = world.getDynamicProperty(
        chunkKeyForMeta(id, meta, i)
      );
      if (typeof part !== "string") return undefined;
      parts.push(part);
    }

    var text = parts.join("");

    if (
      Number(meta.length) >= 0
      && text.length !== Number(meta.length)
    ) {
      return undefined;
    }

    return JSON.parse(text);
  } catch (e) {}

  return undefined;
}

export function clearChunkedJson(prefix) {
  var id = String(prefix || "");
  if (!id) return;

  var meta = readMeta(id);
  clearChunkSet(id, meta);
  safeRemoveDynamicProperty(metaKey(id));
}

export function hasChunkedJson(prefix) {
  return !!readMeta(prefix);
}
