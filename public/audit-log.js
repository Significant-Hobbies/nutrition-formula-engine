const SENSITIVE_KEYS = /^(contents?|raw_?text|formula|ingredients?|item|material|name|markdown|report)$/i;
const MAX_EVENTS = 500;

function sanitize(value, key = "") {
  if (SENSITIVE_KEYS.test(key)) return "[redacted]";
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitize(childValue, childKey),
    ]));
  }
  return String(value);
}

export async function sha256(value) {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createAuditLog({
  sessionId = crypto.randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  const events = [];
  let sequence = 0;

  function record(type, details = {}) {
    sequence += 1;
    events.push({
      sequence,
      timestamp: now(),
      type,
      details: sanitize(details),
    });
    if (events.length > MAX_EVENTS) events.shift();
    return events.at(-1);
  }

  function snapshot() {
    return {
      schema_version: 1,
      session_id: sessionId,
      exported_at: now(),
      privacy: "Raw formula text, OCR text, ingredient names, and report contents are excluded.",
      event_count: events.length,
      events: structuredClone(events),
    };
  }

  return { record, snapshot, sessionId };
}
