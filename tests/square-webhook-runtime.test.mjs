import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { APP_ID, LOCATION, MERCHANT, NOW, SCOPES, order, payment, refund, usd } from "./square-test-helpers.mjs";

const KEY="LOCAL-WORKERS-WEBHOOK-SIGNATURE-KEY";
const URL="https://sidebysouth.com/api/square/webhook";

test("signed Square notifications update D1 without owner browser auth in the actual Workers runtime", async () => {
  const root=resolve(import.meta.dirname,"..");
  const bundle=await build({stdin:{contents:`import { encryptSquareTokens, squareTrackerAction, handleSquareWebhook } from "./lib/square-sync.ts"; export default { async fetch(request) { const url=new URL(request.url); const now=new Date("2026-10-27T16:00:00.000Z"); if(url.pathname==="/fixture/cipher")return Response.json({cipher:await encryptSquareTokens({accessToken:"worker-local-access",refreshToken:"worker-local-refresh"},"worker-fixture-owner")});if(url.pathname==="/fixture/enroll")return Response.json(await squareTrackerAction({action:"enrollQuote",payload:{inquiryId:"00000000-0000-4000-8000-000000000001",offerKey:"current_both",acceptedQuoteReference:"WORKER-QUOTE-1",digitalOnly:true}},"worker-fixture-owner",now)); return handleSquareWebhook(request,now);} };`,resolveDir:root},bundle:true,write:false,format:"esm",platform:"neutral",external:["cloudflare:workers"]});
  const pay=payment();const ord=order(pay);const ref=refund(pay);const calls=[];let failRead=false;
  const runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-22",cf:false,d1Databases:["DB"],bindings:{SQUARE_APPLICATION_ID:APP_ID,SQUARE_APPLICATION_SECRET:"LOCAL-WORKER-FIXTURE-SECRET-NOT-PRODUCTION",SQUARE_WEBHOOK_SIGNATURE_KEY:KEY},outboundService:async request=>{
    const url=new globalThis.URL(request.url);calls.push({path:url.pathname,method:request.method});assert.equal(url.origin,"https://connect.squareup.com");assert.equal(request.method,"GET");assert.equal(url.searchParams.has("access_token"),false);
    if(failRead)return new Response("provider text must not leak",{status:503});
    if(url.pathname===`/v2/payments/${pay.id}`)return Response.json({payment:pay});
    if(url.pathname===`/v2/orders/${ord.id}`)return Response.json({order:ord});
    if(url.pathname===`/v2/refunds/${ref.id}`)return Response.json({refund:ref});
    if(url.pathname==="/v2/catalog/object/variation_current_both")return Response.json({object:{id:"variation_current_both",type:"ITEM_VARIATION",item_variation_data:{item_id:"4N6654CHAAB4SYVNCJAEP36E"}}});
    throw new Error("Unexpected runtime fixture endpoint");
  }});
  const notification=(type,id,eventId)=>({merchant_id:MERCHANT,event_id:eventId,type,created_at:NOW.toISOString(),data:{type:type.startsWith("refund")?"refund":"payment",id,object:type.startsWith("refund")?{refund:{id,payment_id:pay.id}}:{payment:{id,status:"COMPLETED",amount_money:usd(999999)}}}});
  const send=async (payload,bad=false)=>{const body=JSON.stringify(payload);const signature=createHmac("sha256",KEY).update(URL+body).digest("base64");return runtime.dispatchFetch(URL,{method:"POST",headers:{"content-type":"application/json","x-square-hmacsha256-signature":bad?"invalid":signature},body});};
  try{
    const db=await runtime.getD1Database("DB");
    for(const filename of readdirSync(resolve(root,"drizzle")).filter(f=>f.endsWith(".sql")).sort())for(const statement of readFileSync(resolve(root,"drizzle",filename),"utf8").split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    await db.prepare("INSERT INTO inquiries(id,submission_id,reference,created_at,updated_at,name,instagram,event_location,coverage,stage,quoted_media_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind("00000000-0000-4000-8000-000000000001","webhook-fixture-submission","SBS-AABBCCDD",NOW.toISOString(),NOW.toISOString(),"Local fixture","local_fixture","Miami Beach","both","quoted",60000).run();
    const {cipher}=await (await runtime.dispatchFetch("https://sidebysouth.com/fixture/cipher")).json();
    await db.prepare("INSERT INTO square_connections(key,owner_id,merchant_id,location_id,encrypted_tokens,expires_at,refreshed_at,scopes_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind("square_deposits","worker-fixture-owner",MERCHANT,LOCATION,cipher,"2027-01-01T00:00:00.000Z",NOW.toISOString(),JSON.stringify(SCOPES),NOW.toISOString()).run();
    assert.equal((await (await runtime.dispatchFetch("https://sidebysouth.com/fixture/enroll")).json()).ok,true);
    const payload=notification("payment.updated",pay.id,"event_worker_payment");
    assert.equal((await send(payload,true)).status,403);assert.equal(calls.length,0);
    assert.equal((await send(payload)).status,200);const firstCalls=calls.length;
    let rows=await db.prepare("SELECT type,amount_cents,method FROM ledger_transactions").all();assert.deepEqual(rows.results.map(r=>[r.type,r.amount_cents,r.method]),[["media_deposit",18000,"square"]]);
    assert.equal((await db.prepare("SELECT stage,booking_date,decoration_settled FROM inquiries").first()).stage,"quoted");
    assert.equal((await send(payload)).status,200);assert.equal(calls.length,firstCalls);
    pay.refund_ids=[ref.id];pay.refunded_money=usd(4500);
    const refundPayload=notification("refund.updated",ref.id,"event_worker_refund");
    failRead=true;const failed=await send(refundPayload);assert.equal(failed.status,503);assert.equal((await failed.text()).includes("provider text"),false);
    failRead=false;assert.equal((await send(refundPayload)).status,200);assert.equal((await send(refundPayload)).status,200);
    rows=await db.prepare("SELECT type,amount_cents FROM ledger_transactions ORDER BY type").all();assert.deepEqual(rows.results.map(r=>[r.type,r.amount_cents]),[["media_deposit",18000],["media_refund",4500]]);
    assert.equal((await db.prepare("SELECT stage FROM inquiries").first()).stage,"quoted");assert.equal((await db.prepare("SELECT watermark FROM square_sync_state").first()).watermark,null);
  } finally {await runtime.dispose();}
});
