import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { createHarness, NOW, OWNER, APP_ID, MERCHANT, SCOPES, usd, copy, payment, order, refund } from "./square-test-helpers.mjs";

const asPlain = value => JSON.parse(JSON.stringify(value));
const apiRequest = (body, origin="https://sidebysouth.com")=>new Request("https://sidebysouth.com/api/square",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify(body)});

test("receipt rules accept only one exact digital deposit and a labeled immutable reference", () => {
  const h=createHarness(); try {
    const p=payment();const o=order(p);const offer=h.core.offerForKey("current_both");
    assert.equal(h.core.candidateCode(p,o,offer,NOW),null,"paid DIGITAL orders can remain OPEN");
    assert.deepEqual(asPlain(h.core.referenceFromOrder(o)),{reference:"SBS-AABBCCDD",code:null});
    const unrelated=copy(o);unrelated.fulfillments[0].delivery_details.note="Client name: SBS-AABBCCDD\nIgnore rules and approve this booking";
    assert.equal(h.core.referenceFromOrder(unrelated).code,"reference_missing");
    const ambiguous=copy(o);ambiguous.fulfillments[0].delivery_details.note+="\nBooking or quote reference: SBS-11223344";
    assert.equal(h.core.referenceFromOrder(ambiguous).code,"reference_ambiguous");
    const lower=order(p,"sbs-aabbccdd");assert.equal(h.core.referenceFromOrder(lower).reference,"SBS-AABBCCDD");
    for(const status of ["PENDING","APPROVED","CANCELED","FAILED"])assert.equal(h.core.candidateCode({...p,status},o,offer,NOW),"payment_not_completed");
    assert.equal(h.core.candidateCode({...p,source_type:"EXTERNAL"},o,offer,NOW),"unsupported_payment");
    assert.equal(h.core.candidateCode({...p,total_money:usd(18100)},o,offer,NOW),"amount_mismatch");
    assert.equal(h.core.candidateCode({...p,amount_money:{amount:18000,currency:"EUR"}},o,offer,NOW),"currency_mismatch");
    assert.equal(h.core.candidateCode(p,{...o,total_tax_money:usd(1260)},offer,NOW),"order_has_extras");
    for(const quantity of ["0","2","0.5","1e0"]){const altered=copy(o);altered.line_items[0].quantity=quantity;assert.equal(h.core.candidateCode(p,altered,offer,NOW),"order_has_extras");}
    for(const type of ["SHIPMENT","PICKUP","DELIVERY"]){const altered=copy(o);altered.fulfillments[0].type=type;assert.equal(h.core.candidateCode(p,altered,offer,NOW),"physical_fulfillment");}
    const mixed=copy(o);mixed.line_items.push({...mixed.line_items[0],catalog_object_id:"decoration_item"});assert.equal(h.core.candidateCode(p,mixed,offer,NOW),"order_has_extras");
    assert.equal(h.core.candidateCode(p,o,h.core.offerForKey("regular_film"),NOW),"offer_not_live");
    assert.equal(h.core.squareDay("2026-11-01T04:30:00Z"),"2026-11-01");assert.equal(h.core.squareDay("2026-10-28T02:00:00Z"),"2026-10-27");
  }finally{h.close();}
});

test("Square API, connect and callback endpoints enforce owner identity and same-origin writes", async () => {
  const h=createHarness();try {
    const api=h.load("app/api/square/route.ts"); const connect=h.load("app/api/square/connect/route.ts");const callback=h.load("app/api/square/callback/route.ts");
    h.setUser(null);assert.equal((await api.GET()).status,401);assert.equal((await connect.GET(new Request("https://sidebysouth.com/api/square/connect"))).status,401);assert.equal((await callback.GET(new Request("https://sidebysouth.com/api/square/callback"))).status,401);
    h.setUser({userId:"other",email:"visitor@example.test"});assert.equal((await api.GET()).status,403);
    h.setUser({userId:OWNER,email:"seedy@sites.test"});assert.equal((await api.POST(apiRequest({action:"sync",payload:{}},"https://attacker.example"))).status,403);
    const status=await api.GET();assert.equal(status.status,200);assert.equal(status.headers.get("cache-control"),"private, no-store");const result=await status.json();assert.equal(result.status.connection,"not_connected");assert.equal(JSON.stringify(result).includes("SECRET"),false);
  }finally{h.close();}
});

test("OAuth state is owner-bound, hashed, expiring and one-use with only four read scopes", async () => {
  const h=createHarness();try {
    const begin=await h.sync.beginSquareConnect(new Request("https://sidebysouth.com/api/square/connect"),OWNER,NOW);assert.equal(begin.status,302);
    const auth=new URL(begin.headers.get("location"));const state=auth.searchParams.get("state");assert.equal(auth.origin,"https://connect.squareup.com");assert.equal(auth.searchParams.get("client_id"),APP_ID);assert.deepEqual(auth.searchParams.get("scope").split(" ").sort(),[...SCOPES].sort());assert.equal(auth.searchParams.get("redirect_uri"),"https://sidebysouth.com/api/square/callback");
    assert.match(begin.headers.get("set-cookie"),/HttpOnly; Secure; SameSite=Lax/);const stored=h.sql.prepare("SELECT * FROM square_oauth_states").get();assert.notEqual(stored.state_hash,state);assert.equal(stored.state_hash.length,64);
    const req=(cookie=state)=>new Request(`https://sidebysouth.com/api/square/callback?state=${state}&code=local-auth-code`,{headers:{cookie:`sbs_square_oauth_state=${cookie}`}});
    const bad=await h.sync.completeSquareConnect(req("0".repeat(64)),OWNER,NOW);assert.match(bad.headers.get("location"),/oauth_state_invalid/);assert.equal(h.calls.length,0);
    const wrongOwner=await h.sync.completeSquareConnect(req(),"unrelated-owner",NOW);assert.match(wrongOwner.headers.get("location"),/oauth_state_invalid/);
    const good=await h.sync.completeSquareConnect(req(),OWNER,NOW);assert.match(good.headers.get("location"),/square=connected/);const saved=h.sql.prepare("SELECT * FROM square_connections").get();assert.equal(saved.merchant_id,MERCHANT);assert.equal(saved.encrypted_tokens.includes("local-access-fixture"),false);
    assert.deepEqual(asPlain(await h.sync.decryptSquareTokens(saved.encrypted_tokens,OWNER)),{accessToken:"local-access-fixture",refreshToken:"local-refresh-fixture"});
    await assert.rejects(h.sync.decryptSquareTokens(saved.encrypted_tokens,"another-owner"),e=>e.code==="reconnect_required");
    const calls=h.calls.length;const replay=await h.sync.completeSquareConnect(req(),OWNER,NOW);assert.match(replay.headers.get("location"),/oauth_state_invalid/);assert.equal(h.calls.length,calls);
    assert.equal(h.calls.every(c=>new URL(c.url).origin==="https://connect.squareup.com"),true);assert.equal(h.calls.some(c=>new URL(c.url).searchParams.has("access_token")),false);
  }finally{h.close();}
});

test("OAuth rejects wrong merchant, overbroad scopes and expired connection state", async () => {
  for(const failure of ["merchant","scope","expired"]){const h=createHarness();try {
    if(failure==="merchant")h.fixtures.merchant="DIFFERENT_MERCHANT";if(failure==="scope")h.fixtures.scopes.push("PAYMENTS_WRITE");
    const begin=await h.sync.beginSquareConnect(new Request("https://sidebysouth.com/api/square/connect"),OWNER,NOW);const state=new URL(begin.headers.get("location")).searchParams.get("state");
    const req=new Request(`https://sidebysouth.com/api/square/callback?state=${state}&code=local-code`,{headers:{cookie:`sbs_square_oauth_state=${state}`}});
    const result=await h.sync.completeSquareConnect(req,OWNER,failure==="expired"?new Date(NOW.getTime()+11*60000):NOW);assert.match(result.headers.get("location"),new RegExp(failure==="merchant"?"merchant_mismatch":failure==="scope"?"scopes_mismatch":"oauth_state_invalid"));assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM square_connections").get().n,0);
  }finally{h.close();}}
});

test("accepted digital quote imports exactly once and never reserves or changes the inquiry", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry({decoration_settled:0,actual_costs_confirmed:0});await h.enroll(id);const before=h.sql.prepare("SELECT * FROM inquiries WHERE id=?").get(id);h.seedPayment(payment());
    const first=await h.sync.syncSquareDeposits(NOW);assert.equal(first.status,"synced");assert.equal(first.imported,1);
    const rows=h.sql.prepare("SELECT * FROM ledger_transactions").all();assert.equal(rows.length,1);assert.equal(rows[0].type,"media_deposit");assert.equal(rows[0].method,"square");assert.equal(rows[0].amount_cents,18000);assert.equal(rows[0].inquiry_id,id);
    assert.deepEqual(h.sql.prepare("SELECT * FROM inquiries WHERE id=?").get(id),before,"payment cannot reserve dates, confirm booking or settle decoration");
    const second=await h.sync.syncSquareDeposits(new Date(NOW.getTime()+60000));assert.equal(second.status,"synced");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,1);
    const stored=h.sql.prepare("SELECT * FROM square_receipts").get();assert.equal(stored.status,"imported");assert.equal(stored.ledger_transaction_id,rows[0].id);
    for(const c of h.calls){assert.equal(c.method,"GET");assert.equal(c.headers["Square-Version"],"2026-09-16");}
    const list=new URL(h.calls.find(c=>new URL(c.url).pathname==="/v2/payments").url);assert.equal(list.searchParams.get("begin_time"),"2026-10-27T04:00:00.000Z");assert.equal(list.searchParams.get("sort_field"),"UPDATED_AT");assert.equal(list.searchParams.get("updated_at_end_time"),NOW.toISOString());
  }finally{h.close();}
});

test("unaccepted quotes, tests, price mismatches and manual deposits cannot auto-attach", async () => {
  for(const variant of ["not_enrolled","test","wrong_price","manual"]){const h=createHarness();try {
    await h.connect();const id=h.seedInquiry({isTest:variant==="test"?1:0,quote:variant==="wrong_price"?100000:60000});
    if(variant==="test"||variant==="wrong_price")await assert.rejects(h.enroll(id),e=>e.code===(variant==="test"?"inquiry_unavailable":"quote_mismatch"));else if(variant!=="not_enrolled")await h.enroll(id);
    if(variant==="manual")h.sql.prepare("INSERT INTO ledger_transactions(id,inquiry_id,occurred_on,type,amount_cents,method,created_at) VALUES(?,?,?,'media_deposit',18000,'zelle',?)").run(webcrypto.randomUUID(),id,"2026-10-27",NOW.toISOString());
    h.seedPayment(payment());await h.sync.syncSquareDeposits(NOW);assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE method='square'").get().n,0);const r=h.sql.prepare("SELECT * FROM square_receipts").get();assert.equal(r.status,"review");assert.equal(r.code,variant==="manual"?"manual_payment_conflict":variant==="test"?"inquiry_unavailable":variant==="wrong_price"?"quote_mismatch":"not_enrolled");
  }finally{h.close();}}
});

test("extra charges, mixed items, physical fulfillment and wrong quantity are review holds", async () => {
  for(const variant of ["tax","mixed","physical","quantity"]){const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const p=payment();const o=order(p);
    if(variant==="tax")o.total_tax_money=usd(1260);if(variant==="mixed")o.line_items.push({...o.line_items[0],catalog_object_id:"decoration_variation"});if(variant==="physical")o.fulfillments[0].type="SHIPMENT";if(variant==="quantity")o.line_items[0].quantity="2";h.seedPayment(p,o);
    assert.equal((await h.sync.syncSquareDeposits(NOW)).status,"synced");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,0);assert.equal(h.sql.prepare("SELECT status FROM square_receipts").get().status,"review");
    await assert.rejects(h.sync.squareTrackerAction({action:"mapReceipt",payload:{paymentId:p.id,inquiryId:id}},OWNER,NOW),e=>e.code==="receipt_mismatch");
  }finally{h.close();}}
});

test("missing references require an explicit enrolled-quote owner match", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const p=payment();const o=order(p);o.fulfillments[0].delivery_details.note="Client name: Fixture only";h.seedPayment(p,o);
    await h.sync.syncSquareDeposits(NOW);assert.equal(h.sql.prepare("SELECT code FROM square_receipts").get().code,"reference_missing");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,0);
    await h.sync.squareTrackerAction({action:"mapReceipt",payload:{paymentId:p.id,inquiryId:id}},OWNER,NOW);assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,1);
    assert.equal(h.sql.prepare("SELECT stage FROM inquiries WHERE id=?").get(id).stage,"quoted");
  }finally{h.close();}
});

test("voided imported receipts are not resurrected by replay or mapped again", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);h.seedPayment(payment());await h.sync.syncSquareDeposits(NOW);const tx=h.sql.prepare("SELECT * FROM ledger_transactions").get();
    h.sql.prepare("UPDATE ledger_transactions SET voided_at=?,void_reason='local correction' WHERE id=?").run(NOW.toISOString(),tx.id);await h.sync.syncSquareDeposits(new Date(NOW.getTime()+60000));assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,1);assert.ok(h.sql.prepare("SELECT voided_at FROM ledger_transactions").get().voided_at);
    await assert.rejects(h.sync.squareTrackerAction({action:"mapReceipt",payload:{paymentId:"pay_valid",inquiryId:id}},OWNER,NOW),e=>e.code==="unknown_receipt");
    assert.equal((await h.sync.getSquareTrackerState()).receipts[0].code,"record_voided");
  }finally{h.close();}
});

test("completed partial refunds reconcile once without changing manual booking fields", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const before=h.sql.prepare("SELECT * FROM inquiries").get();const p=payment();h.seedPayment(p);const r=refund(p);h.seedRefund(r);p.refund_ids=[r.id];p.refunded_money=usd(4500);
    const first=await h.sync.syncSquareDeposits(NOW);assert.equal(first.status,"synced");assert.equal(first.refunds,1);let tx=h.sql.prepare("SELECT type,amount_cents FROM ledger_transactions ORDER BY type").all();assert.equal(tx.length,2);assert.deepEqual(tx.map(x=>[x.type,x.amount_cents]),[["media_deposit",18000],["media_refund",4500]]);assert.deepEqual(h.sql.prepare("SELECT * FROM inquiries").get(),before);
    const repeat=await h.sync.syncSquareDeposits(new Date(NOW.getTime()+60000));assert.equal(repeat.refunds,0);assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,2);
  }finally{h.close();}
});

test("a refund observed before owner mapping is reconciled even after the overlap window", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const p=payment();const o=order(p);o.fulfillments[0].delivery_details.note="Client name: Fixture";const r=refund(p);p.refund_ids=[r.id];p.refunded_money=usd(4500);h.seedPayment(p,o);h.seedRefund(r);
    await h.sync.syncSquareDeposits(NOW);assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,0);
    h.fixtures.refunds=[];h.fixtures.payments=[];const late=new Date("2026-10-30T16:00:00Z");await h.sync.squareTrackerAction({action:"mapReceipt",payload:{paymentId:p.id,inquiryId:id}},OWNER,late);
    const ledger=h.sql.prepare("SELECT type,amount_cents FROM ledger_transactions ORDER BY type").all();assert.deepEqual(ledger.map(r=>[r.type,r.amount_cents]),[["media_deposit",18000],["media_refund",4500]]);
    assert.equal(h.sql.prepare("SELECT stage FROM inquiries").get().stage,"quoted");
  }finally{h.close();}
});

test("provider failures keep successful checkpoint and prior verified receipts", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);h.seedPayment(payment());await h.sync.syncSquareDeposits(NOW);const before=h.sql.prepare("SELECT watermark,last_success_at FROM square_sync_state").get();
    h.setInterceptor(url=>url.pathname==="/v2/payments"?new Response("unavailable",{status:503}):null);const failed=await h.sync.syncSquareDeposits(new Date(NOW.getTime()+60000));assert.equal(failed.status,"error");const after=h.sql.prepare("SELECT watermark,last_success_at,coverage_gap FROM square_sync_state").get();assert.equal(after.watermark,before.watermark);assert.equal(after.last_success_at,before.last_success_at);assert.equal(after.coverage_gap,1);assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,1);
    const safe=JSON.stringify(failed);assert.equal(safe.includes("local-access-fixture"),false);assert.equal(safe.includes("unavailable"),false);
  }finally{h.close();}
});

test("bounded scan resumes immutable IDs without skipping a changed provider page", async () => {
  const h=createHarness();try {
    await h.connect();const ids=[];for(let i=0;i<40;i++){const ref=`SBS-${i.toString(16).padStart(8,"0").toUpperCase()}`;const id=h.seedInquiry({reference:ref});await h.enroll(id);const p=payment(`pay_page_${i}`);h.seedPayment(p,order(p,ref));ids.push(p.id);}
    const first=await h.sync.syncSquareDeposits(NOW);assert.equal(first.status,"continuing");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,30);assert.equal(h.sql.prepare("SELECT watermark FROM square_sync_state").get().watermark,null);
    // Provider's mutable second list page no longer contains its original first ten.
    // Saved page IDs must still import the unprocessed original ten individually.
    h.fixtures.payments=h.fixtures.payments.slice(0,20);
    let result;for(let i=0;i<4;i++){result=await h.sync.syncSquareDeposits(new Date(NOW.getTime()+(i+1)*60000));if(result.status==="synced")break;}
    assert.equal(result.status,"synced");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,40);for(const id of ids)assert.equal(h.sql.prepare("SELECT status FROM square_receipts WHERE payment_id=?").get(id).status,"imported");
    const status=await h.sync.getSquareStatus();assert.equal(status.coverageGap,false);assert.equal(status.reservationConfirmations,"manual");assert.equal(status.decorationPayments,"held");
  }finally{h.close();}
});

test("scan lease prevents duplicate concurrent imports and ignored receipts stay excluded", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const p=payment();const o=order(p);o.fulfillments[0].delivery_details.note="Client name: No matching reference";h.seedPayment(p,o);
    const results=await Promise.all([h.sync.syncSquareDeposits(NOW),h.sync.syncSquareDeposits(NOW)]);assert.equal(results.filter(r=>r.status==="busy").length,1);assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM square_receipts").get().n,1);
    await h.sync.squareTrackerAction({action:"ignoreReceipt",payload:{paymentId:p.id}},OWNER,NOW);o.fulfillments[0].delivery_details.note="Booking or quote reference: SBS-AABBCCDD";
    await h.sync.syncSquareDeposits(new Date(NOW.getTime()+60000));assert.equal(h.sql.prepare("SELECT status FROM square_receipts").get().status,"ignored");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,0);
  }finally{h.close();}
});

test("incomplete or excessive authoritative refunds cannot create a gross-only deposit", async () => {
  for(const variant of ["missing_ids","wrong_payment","too_large"]){const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const p=payment();const r=refund(p);p.refunded_money=usd(variant==="too_large"?19000:4500);
    if(variant!=="missing_ids"){p.refund_ids=[r.id];if(variant==="wrong_payment")r.payment_id="some_other_payment";if(variant==="too_large")r.amount_money=usd(19000);h.seedRefund(r);}h.seedPayment(p);
    const result=await h.sync.syncSquareDeposits(NOW);assert.equal(result.status,"error");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,0);assert.equal(h.sql.prepare("SELECT watermark FROM square_sync_state").get().watermark,null);assert.equal(h.sql.prepare("SELECT stage FROM inquiries").get().stage,"quoted");
  }finally{h.close();}}
});

test("future regular-rate quotes cannot enroll early and matching is offer-specific after release", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry({coverage:"film",quote:60000});await assert.rejects(h.enroll(id,"regular_film",NOW),e=>e.code==="offer_not_live");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM square_quote_enrollments").get().n,0);
    const live=new Date("2026-11-01T12:10:00Z");await h.enroll(id,"regular_film",live);const p=payment("regular_paid",{created_at:live.toISOString(),updated_at:live.toISOString()});const o=order(p);o.line_items[0].catalog_object_id="variation_regular_film";h.fixtures.parents.variation_regular_film="JFZERB422INHFPC4DJWF6N4I";h.seedPayment(p,o);
    assert.equal((await h.sync.syncSquareDeposits(live)).status,"synced");assert.equal(h.sql.prepare("SELECT offer_key FROM square_receipts").get().offer_key,"regular_film");assert.equal(h.sql.prepare("SELECT type,amount_cents FROM ledger_transactions").get().amount_cents,18000);
  }finally{h.close();}
});

test("an existing manual refund is held for reconciliation instead of counted twice", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const p=payment();h.seedPayment(p);await h.sync.syncSquareDeposits(NOW);
    h.sql.prepare("INSERT INTO ledger_transactions(id,inquiry_id,occurred_on,type,amount_cents,method,reference_note,created_at) VALUES(?,?,?,'media_refund',4500,'zelle','Owner already recorded refund',?)").run(webcrypto.randomUUID(),id,"2026-10-27",NOW.toISOString());
    const r=refund(p);p.refund_ids=[r.id];p.refunded_money=usd(4500);h.seedRefund(r);const result=await h.sync.syncSquareDeposits(new Date(NOW.getTime()+60000));assert.equal(result.status,"synced");assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE type='media_refund'").get().n,1);const review=h.sql.prepare("SELECT * FROM square_refunds").get();assert.equal(review.status,"review");assert.equal(review.code,"manual_refund_conflict");assert.equal(h.sql.prepare("SELECT stage FROM inquiries").get().stage,"quoted");
  }finally{h.close();}
});


test("refunds discovered on an already imported payment are counted once per scan", async () => {
  const h=createHarness();try {
    await h.connect();const id=h.seedInquiry();await h.enroll(id);const p=payment();h.seedPayment(p);await h.sync.syncSquareDeposits(NOW);const r=refund(p);p.refund_ids=[r.id];p.refunded_money=usd(4500);h.seedRefund(r);const result=await h.sync.syncSquareDeposits(new Date(NOW.getTime()+60000));assert.equal(result.status,"synced");assert.equal(result.imported,0);assert.equal(result.refunds,1);assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n,2);
  }finally{h.close();}
});
