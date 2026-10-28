import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { APP_ID, LOCATION, MERCHANT, NOW, SCOPES, order, payment } from "./square-test-helpers.mjs";

test("Square OAuth encryption and deposit scan work in the actual Workers/D1 runtime", async () => {
  const root=resolve(import.meta.dirname,"..");
  const bundle=await build({stdin:{contents:`import { beginSquareConnect, completeSquareConnect, squareTrackerAction, syncSquareDeposits } from "./lib/square-sync.ts"; export default { async fetch(request) { const url=new URL(request.url); const now=new Date("2026-10-27T16:00:00.000Z"); if(url.pathname==="/connect")return beginSquareConnect(request,"worker-fixture-owner",now);if(url.pathname==="/api/square/callback")return completeSquareConnect(request,"worker-fixture-owner",now);if(url.pathname==="/enroll")return Response.json(await squareTrackerAction({action:"enrollQuote",payload:{inquiryId:"00000000-0000-4000-8000-000000000001",offerKey:"current_both",acceptedQuoteReference:"WORKER-QUOTE-1",digitalOnly:true}},"worker-fixture-owner",now));return Response.json(await syncSquareDeposits(now));} };`,resolveDir:root},bundle:true,write:false,format:"esm",platform:"neutral",external:["cloudflare:workers"]});
  const pay=payment();const ord=order(pay);const calls=[];let deny=false;
  const runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-22",cf:false,d1Databases:["DB"],bindings:{SQUARE_APPLICATION_ID:APP_ID,SQUARE_APPLICATION_SECRET:"LOCAL-WORKER-FIXTURE-SECRET-NOT-PRODUCTION"},outboundService:async request=>{
    const url=new URL(request.url);calls.push({path:url.pathname,method:request.method,authorization:request.headers.get("authorization")});assert.equal(url.origin,"https://connect.squareup.com");assert.equal(url.searchParams.has("access_token"),false);
    if(deny)return new Response(null,{status:302,headers:{location:"https://never-follow.example/credential-trap"}});
    if(url.pathname==="/oauth2/token")return Response.json({access_token:"worker-local-access",refresh_token:"worker-local-refresh",merchant_id:MERCHANT,token_type:"bearer",expires_at:"2027-01-01T00:00:00Z"});
    if(url.pathname==="/oauth2/token/status")return Response.json({client_id:APP_ID,merchant_id:MERCHANT,scopes:SCOPES});
    if(url.pathname===`/v2/merchants/${MERCHANT}`)return Response.json({merchant:{id:MERCHANT,status:"ACTIVE",currency:"USD"}});
    if(url.pathname==="/v2/locations")return Response.json({locations:[{id:LOCATION,merchant_id:MERCHANT,name:"Photo",status:"ACTIVE",currency:"USD"}]});
    if(url.pathname==="/v2/payments")return Response.json({payments:[pay]});
    if(url.pathname===`/v2/payments/${pay.id}`)return Response.json({payment:pay});
    if(url.pathname===`/v2/orders/${ord.id}`)return Response.json({order:ord});
    if(url.pathname==="/v2/catalog/object/variation_current_both")return Response.json({object:{id:"variation_current_both",type:"ITEM_VARIATION",item_variation_data:{item_id:"4N6654CHAAB4SYVNCJAEP36E"}}});
    if(url.pathname==="/v2/refunds")return Response.json({refunds:[]});
    throw new Error("Unexpected fixture endpoint");
  }});
  try{
    const db=await runtime.getD1Database("DB");
    for(const filename of readdirSync(resolve(root,"drizzle")).filter(f=>f.endsWith(".sql")).sort())for(const statement of readFileSync(resolve(root,"drizzle",filename),"utf8").split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    await db.prepare("INSERT INTO inquiries(id,submission_id,reference,created_at,updated_at,name,instagram,event_location,coverage,stage,quoted_media_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind("00000000-0000-4000-8000-000000000001","worker-local-submission","SBS-AABBCCDD",NOW.toISOString(),NOW.toISOString(),"Local fixture","local_fixture","Miami Beach","both","quoted",60000).run();
    const initial=await runtime.dispatchFetch("https://sidebysouth.com/connect", {redirect:"manual"});assert.equal(initial.status,302);const state=new URL(initial.headers.get("location")).searchParams.get("state");
    const connected=await runtime.dispatchFetch(`https://sidebysouth.com/api/square/callback?state=${state}&code=worker-test-code`,{redirect:"manual",headers:{cookie:`sbs_square_oauth_state=${state}`}});assert.match(connected.headers.get("location"),/square=connected/);
    const conn=await db.prepare("SELECT encrypted_tokens FROM square_connections").first();assert.ok(conn);assert.equal(conn.encrypted_tokens.includes("worker-local-access"),false);assert.equal(conn.encrypted_tokens.includes("worker-local-refresh"),false);
    assert.equal((await (await runtime.dispatchFetch("https://sidebysouth.com/enroll")).json()).ok,true);
    const synced=await (await runtime.dispatchFetch("https://sidebysouth.com/sync")).json();assert.equal(synced.status,"synced");assert.equal(synced.imported,1);assert.equal(synced.reservationConfirmations,"manual");assert.equal(synced.decorationPayments,"held");
    const ledger=await db.prepare("SELECT type,amount_cents,method FROM ledger_transactions").all();assert.deepEqual(ledger.results.map(r=>[r.type,r.amount_cents,r.method]),[["media_deposit",18000,"square"]]);assert.equal((await db.prepare("SELECT stage FROM inquiries").first()).stage,"quoted");
    const count=calls.length;deny=true;const blocked=await (await runtime.dispatchFetch("https://sidebysouth.com/sync")).json();assert.equal(blocked.status,"error");assert.equal(blocked.code,"provider_error");assert.equal(calls.length,count+1);assert.equal(JSON.stringify(blocked).includes("worker-local-access"),false);assert.equal(calls.every(c=>c.method==="GET"||c.path.startsWith("/oauth2/")),true);
  }finally{await runtime.dispose();}
});
