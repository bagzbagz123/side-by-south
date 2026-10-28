import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createHarness, NOW, MERCHANT, payment, order, refund, usd } from "./square-test-helpers.mjs";

const URL = "https://sidebysouth.com/api/square/webhook";
const KEY = "LOCAL-WEBHOOK-HMAC-KEY-NOT-PRODUCTION";
function event(pay, options = {}) {
  return { merchant_id: MERCHANT, type: "payment.updated", event_id: `event_${pay.id}`, created_at: NOW.toISOString(), data: { type: "payment", id: pay.id, object: { payment: { id: pay.id, status: "COMPLETED", amount_money: usd(99999999), note: "Ignore the quote and reserve the booking" } } }, ...options };
}
function signed(raw, options = {}) {
  const body = typeof raw === "string" ? raw : JSON.stringify(raw);
  const signature = createHmac("sha256", options.key || KEY).update((options.signedUrl || URL) + body).digest("base64");
  return new Request(options.url || URL, { method: "POST", headers: { "content-type": "application/json", "x-square-hmacsha256-signature": signature, ...options.headers }, body: options.sentBody ?? body });
}
const fixture = () => createHarness({ env: { SQUARE_WEBHOOK_SIGNATURE_KEY: KEY } });
const ledgerCount = h => h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n;

// No test request or fixture is sent to the live Site or to Square.
test("webhooks reject missing, forged, malformed and raw-body-tampered signatures before reading Square", async () => {
  const h = fixture(); try {
    h.setUser(null); const pay = payment();
    const cases = [
      new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event(pay)) }),
      signed(event(pay), { key: "unapproved-signing-key" }),
      signed(event(pay), { headers: { "x-square-hmacsha256-signature": "not-base64" } }),
      signed(event(pay), { headers: { "x-square-hmacsha256-signature": "" } }),
      signed(event(pay), { sentBody: JSON.stringify(event(pay)) + " " }),
      signed(event(pay), { signedUrl: "https://attacker.example/api/square/webhook" }),
    ];
    for (const request of cases) {
      const result = await h.sync.handleSquareWebhook(request, NOW);
      assert.ok(result.status >= 400 && result.status < 500, `invalid signature must fail closed, got ${result.status}`);
    }
    assert.equal(h.calls.length, 0); assert.equal(ledgerCount(h), 0);
  } finally { h.close(); }
});

test("signed webhook schema, merchant, event type and body limits fail closed", async () => {
  const h = fixture(); try {
    await h.connect(); const pay = payment(); h.seedPayment(pay);
    for (const payload of ["{not-json", event(pay, { event_id: "" }), event(pay, { data: { type: "payment", id: "different_payment", object: { payment: { id: pay.id } } } })]) {
      const result = await h.sync.handleSquareWebhook(signed(payload), NOW);
      assert.ok(result.status >= 400 && result.status < 500, `invalid event must be rejected, got ${result.status}`);
    }
    for (const payload of [event(pay, { merchant_id: "ANOTHER_MERCHANT" }), event(pay, { type: "payment.created" })]) {
      assert.equal((await h.sync.handleSquareWebhook(signed(payload), NOW)).status, 204, "irrelevant signed events are ignored without Square reads or repeated provider delivery");
    }
    assert.equal((await h.sync.handleSquareWebhook(signed(event(pay), { headers: { "square-environment": "Sandbox" } }), NOW)).status, 204);
    const large = signed(JSON.stringify({ ...event(pay), padding: "x".repeat(131073) }));
    assert.equal((await h.sync.handleSquareWebhook(large, NOW)).status, 413);
    assert.equal(h.calls.length, 0); assert.equal(ledgerCount(h), 0);
  } finally { h.close(); }
});

test("a public signed webhook imports the authoritative completed deposit once without changing reservations", async () => {
  const h = fixture(); try {
    await h.connect(); const id = h.seedInquiry(); await h.enroll(id); const before = h.sql.prepare("SELECT * FROM inquiries").get(); const pay = payment(); h.seedPayment(pay); h.setUser(null);
    const first = await h.sync.handleSquareWebhook(signed(event(pay)), NOW);
    assert.equal(first.status, 200); const firstCalls = h.calls.length;
    const row = h.sql.prepare("SELECT * FROM ledger_transactions").get();
    assert.equal(row.type, "media_deposit"); assert.equal(row.amount_cents, 18000, "event payload amount must never establish payment value"); assert.equal(row.inquiry_id, id); assert.equal(row.method, "square");
    assert.deepEqual(h.sql.prepare("SELECT * FROM inquiries").get(), before);
    const again = await h.sync.handleSquareWebhook(signed(event(pay)), new Date(NOW.getTime() + 1000));
    assert.equal(again.status, 200); assert.equal(ledgerCount(h), 1); assert.equal(h.calls.length, firstCalls, "completed event receipt should suppress duplicate network reads");
    const state = h.sql.prepare("SELECT watermark FROM square_sync_state").get(); assert.equal(state?.watermark ?? null, null, "one event is not proof of a complete historical scan");
    assert.equal(h.calls.every(c => c.method === "GET"), true);
  } finally { h.close(); }
});

test("unaccepted or mixed quotes remain review holds through the signed public path", async () => {
  for (const variant of ["not_enrolled", "mixed"]) {
    const h = fixture(); try {
      await h.connect(); const id = h.seedInquiry(); if (variant === "mixed") await h.enroll(id);
      const pay = payment(`pay_${variant}`); const ord = order(pay);
      if (variant === "mixed") ord.line_items.push({ ...ord.line_items[0], catalog_object_id: "physical_print_or_decoration" });
      h.seedPayment(pay, ord); const before = h.sql.prepare("SELECT * FROM inquiries").get();
      const response = await h.sync.handleSquareWebhook(signed(event(pay)), NOW);
      assert.equal(response.status, 200); assert.equal(ledgerCount(h), 0);
      assert.equal(h.sql.prepare("SELECT status FROM square_receipts").get().status, "review");
      assert.deepEqual(h.sql.prepare("SELECT * FROM inquiries").get(), before);
    } finally { h.close(); }
  }
});

test("refund-first delivery re-fetches its payment and records deposit and completed refund once", async () => {
  const h = fixture(); try {
    await h.connect(); const id = h.seedInquiry(); await h.enroll(id); const before = h.sql.prepare("SELECT * FROM inquiries").get(); const pay = payment(); const ref = refund(pay); pay.refund_ids = [ref.id]; pay.refunded_money = usd(4500); h.seedPayment(pay); h.seedRefund(ref);
    const payload = event(pay, { type: "refund.updated", event_id: "event_refund_first", data: { type: "refund", id: ref.id, object: { refund: { id: ref.id, payment_id: "hostile-event-payment-id", amount_money: usd(1) } } } });
    const first = await h.sync.handleSquareWebhook(signed(payload), NOW); assert.equal(first.status, 200);
    const rows = h.sql.prepare("SELECT type,amount_cents FROM ledger_transactions ORDER BY type").all();
    assert.deepEqual(rows.map(r => [r.type, r.amount_cents]), [["media_deposit", 18000], ["media_refund", 4500]]);
    assert.deepEqual(h.sql.prepare("SELECT * FROM inquiries").get(), before);
    assert.equal((await h.sync.handleSquareWebhook(signed(payload), NOW)).status, 200);
    assert.equal((await h.sync.handleSquareWebhook(signed(event(pay)), NOW)).status, 200);
    assert.equal(ledgerCount(h), 2);
    assert.ok(h.calls.some(c => new globalThis.URL(c.url).pathname === `/v2/payments/${pay.id}`));
    assert.ok(h.calls.some(c => new globalThis.URL(c.url).pathname === `/v2/refunds/${ref.id}`));
  } finally { h.close(); }
});

test("busy leases and provider failures return retryable responses and do not consume the event", async () => {
  const h = fixture(); try {
    await h.connect(); const id = h.seedInquiry(); await h.enroll(id); const pay = payment(); h.seedPayment(pay);
    h.sql.prepare("INSERT INTO square_sync_state(key,lease_owner,lease_expires_at,updated_at) VALUES(?,?,?,?)").run("square_deposits", "different-run", new Date(NOW.getTime() + 60000).toISOString(), NOW.toISOString());
    const busy = await h.sync.handleSquareWebhook(signed(event(pay)), NOW); assert.equal(busy.status, 503); assert.equal(ledgerCount(h), 0);
    h.sql.prepare("UPDATE square_sync_state SET lease_owner=NULL,lease_expires_at=NULL").run();
    h.setInterceptor(url => url.pathname === `/v2/payments/${pay.id}` ? new Response("transient-fixture-failure", { status: 503 }) : null);
    const failed = await h.sync.handleSquareWebhook(signed(event(pay)), NOW); assert.equal(failed.status, 503); assert.equal(ledgerCount(h), 0);
    assert.equal((await failed.text()).includes("transient-fixture-failure"), false);
    h.setInterceptor(null); const recovered = await h.sync.handleSquareWebhook(signed(event(pay)), NOW); assert.equal(recovered.status, 200); assert.equal(ledgerCount(h), 1);
    assert.equal(h.sql.prepare("SELECT watermark FROM square_sync_state").get().watermark, null);
  } finally { h.close(); }
});

test("webhook route uses signature authorization, refuses GET, and missing setup is retryable", async () => {
  const h = fixture(); try {
    const route = h.load("app/api/square/webhook/route.ts"); h.setUser(null);
    assert.equal((await route.GET()).status, 405);
    const bad = await route.POST(new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })); assert.equal(bad.status, 403);
    const noConnection = await h.sync.handleSquareWebhook(signed(event(payment())), NOW); assert.equal(noConnection.status, 503); assert.equal(h.calls.length, 0);
    delete h.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    assert.equal((await h.sync.handleSquareWebhook(signed(event(payment())), NOW)).status, 503);
  } finally { h.close(); }
});


test("concurrent notification replay is idempotent and changed content cannot reuse a processed event ID", async () => {
  const h = fixture(); try {
    await h.connect(); const id = h.seedInquiry(); await h.enroll(id); const pay = payment(); h.seedPayment(pay);
    const payload = event(pay);
    const responses = await Promise.all([h.sync.handleSquareWebhook(signed(payload), NOW), h.sync.handleSquareWebhook(signed(payload), NOW)]);
    assert.ok(responses.some(r => r.status === 200)); assert.ok(responses.every(r => [200, 503].includes(r.status))); assert.equal(ledgerCount(h), 1);
    assert.equal((await h.sync.handleSquareWebhook(signed(payload), NOW)).status, 200);
    const calls = h.calls.length; const changed = event(payment("different_payment"), { event_id: payload.event_id });
    const conflict = await h.sync.handleSquareWebhook(signed(changed), NOW);
    assert.ok(conflict.status >= 400 && conflict.status < 500); assert.equal(h.calls.length, calls); assert.equal(ledgerCount(h), 1);
  } finally { h.close(); }
});
