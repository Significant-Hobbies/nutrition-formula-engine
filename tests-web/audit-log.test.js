import test from "node:test";
import assert from "node:assert/strict";

import { createAuditLog, sha256 } from "../public/audit-log.js";

test("records ordered audit events with stable session metadata", () => {
  let tick = 0;
  const audit = createAuditLog({
    sessionId: "session-test",
    now: () => `2026-09-20T00:00:0${tick++}.000Z`,
  });
  audit.record("ingestion_started", { input_kind: "image", bytes: 1024 });
  audit.record("ingestion_completed", { row_count: 14, duration_ms: 420 });

  const snapshot = audit.snapshot();
  assert.equal(snapshot.session_id, "session-test");
  assert.equal(snapshot.event_count, 2);
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(snapshot.events.map((event) => event.type), [
    "ingestion_started",
    "ingestion_completed",
  ]);
});

test("redacts raw formula fields from audit details", () => {
  const audit = createAuditLog({ sessionId: "privacy-test" });
  audit.record("unsafe_test", {
    contents: "FINISHED BATCH 1000 L",
    nested: { raw_text: "secret OCR", item: "Ferric ammonium citrate" },
    row_count: 2,
  });

  const details = audit.snapshot().events[0].details;
  assert.equal(details.contents, "[redacted]");
  assert.equal(details.nested.raw_text, "[redacted]");
  assert.equal(details.nested.item, "[redacted]");
  assert.equal(details.row_count, 2);
});

test("produces stable SHA-256 fingerprints without storing input text", async () => {
  assert.equal(await sha256("reviewed formula"), await sha256("reviewed formula"));
  assert.notEqual(await sha256("reviewed formula"), await sha256("changed formula"));
  assert.match(await sha256("reviewed formula"), /^[a-f0-9]{64}$/);
  assert.equal(await sha256(new TextEncoder().encode("reviewed formula")), await sha256("reviewed formula"));
});
