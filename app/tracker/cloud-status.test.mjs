import test from "node:test";
import assert from "node:assert/strict";
import { cloudStatusSummary, easternTimestamp, hasConfirmedSync } from "./cloud-status.ts";

const status = {
  tokenConfigured: true, spendSource: "Meta Marketing API; fixed campaign/day rows", status: "ready",
  setupReason: null, lastAttemptAt: null, lastSuccessfulSyncAt: null, lastResultCode: null,
  importedDayCount: 0, monitorState: "unverified", pendingInquiryAlerts: 0,
  reportedInquiryAlerts: 0, alertDeliverySemantics: "reported_intent_not_delivery_confirmation",
};

test("a missing Meta token is setup required, never reported as working", () => {
  const summary = cloudStatusSummary({ ...status, tokenConfigured: false, setupReason: "missing_token", status: "setup_required" });
  assert.equal(summary.headline, "Setup required");
  assert.equal(summary.needsAttention, true);
});
test("configured connection alone does not confirm a successful cloud import", () => {
  assert.equal(hasConfirmedSync(status), false);
  assert.equal(cloudStatusSummary(status).headline, "Awaiting a confirmed spend import");
  assert.equal(cloudStatusSummary({ ...status, status: "synced" }).headline, "Awaiting a confirmed spend import");
});
test("only a valid success timestamp supports the recorded-import status", () => {
  const confirmed = { ...status, status: "synced", lastSuccessfulSyncAt: "2026-10-26T14:00:00Z" };
  assert.equal(hasConfirmedSync(confirmed), true);
  assert.equal(cloudStatusSummary(confirmed).headline, "Spend import recorded");
  assert.match(cloudStatusSummary(confirmed).detail, /does not by itself verify a recurring schedule or notification delivery/);
  assert.equal(hasConfirmedSync({ ...confirmed, lastSuccessfulSyncAt: "invalid" }), false);
});
test("an incomplete or failed latest attempt stays visible despite an earlier success", () => {
  assert.equal(cloudStatusSummary({ ...status, status: "incomplete", lastSuccessfulSyncAt: "2026-10-26T14:00:00Z" }).needsAttention, true);
  assert.equal(cloudStatusSummary({ ...status, status: "error" }).headline, "Spend import needs attention");
});
test("unavailable evidence and invalid timestamps stay unconfirmed", () => {
  assert.equal(cloudStatusSummary().headline, "Cloud status unavailable");
  assert.equal(easternTimestamp(null), "Not confirmed");
  assert.equal(easternTimestamp("invalid"), "Not confirmed");
  assert.match(easternTimestamp("2026-11-02T13:00:00Z"), /8:00.*EST/);
});

test("a recorded inquiry check does not become proof of spend import or recurring execution", () => {
  const scanned = { ...status, lastInquiryScanAt: "2026-10-25T08:39:24.253Z", lastInquiryScanStatus: "success", lastInquiryScanResultCode: "ok", lastInquiryScanAlertCount: 0 };
  assert.match(easternTimestamp(scanned.lastInquiryScanAt), /4:39.*EDT/);
  assert.equal(hasConfirmedSync(scanned), false);
  assert.equal(cloudStatusSummary(scanned).headline, "Awaiting a confirmed spend import");
  assert.equal(scanned.monitorState, "unverified");
});
