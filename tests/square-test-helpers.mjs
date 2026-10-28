import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
export const NOW = new Date("2026-10-27T16:00:00.000Z");
export const MERCHANT = "MLHDWJZHXQRMK";
export const LOCATION = "LOCAL_PHOTO_LOCATION";
export const OWNER = "local_seedy";
export const APP_ID = "sq0idp-local-square-test-fixture";
export const SCOPES = ["PAYMENTS_READ", "ORDERS_READ", "ITEMS_READ", "MERCHANT_PROFILE_READ"];
export const usd = amount => ({ amount, currency: "USD" });
export const copy = value => JSON.parse(JSON.stringify(value));
export function payment(id = "pay_valid", options = {}) {
  return { id, order_id: `order_${id}`, location_id: LOCATION, status: "COMPLETED", source_type: "CARD", created_at: "2026-10-27T14:00:00Z", updated_at: "2026-10-27T14:01:00Z", amount_money: usd(18000), total_money: usd(18000), tip_money: usd(0), refunded_money: usd(0), refund_ids: [], ...options };
}
export function order(pay, reference = "SBS-AABBCCDD", options = {}) {
  return { id: pay.order_id, location_id: LOCATION, state: "OPEN", total_money: usd(18000), total_tax_money: usd(0), total_discount_money: usd(0), total_service_charge_money: usd(0), total_tip_money: usd(0), line_items: [{ catalog_object_id: "variation_current_both", catalog_version: 12345, quantity: "1", base_price_money: usd(18000), total_money: usd(18000) }], fulfillments: [{ type: "DIGITAL", delivery_details: { note: `Booking or quote reference: ${reference}\nClient name: Local fixture` } }], ...options };
}
export function refund(pay, id = "refund_valid", options = {}) {
  return { id, payment_id: pay.id, location_id: LOCATION, status: "COMPLETED", amount_money: usd(4500), created_at: "2026-10-27T15:00:00Z", updated_at: "2026-10-27T15:01:00Z", ...options };
}
export function createHarness(options = {}) {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(resolve(root, "drizzle")).filter(n => n.endsWith(".sql")).sort()) sql.exec(readFileSync(resolve(root, "drizzle", file), "utf8"));
  const d1 = { async batch(statements) { sql.exec("BEGIN"); try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec("COMMIT"); return result; } catch (e) { sql.exec("ROLLBACK"); throw e; } }, prepare(query) { let values=[]; const statement = { bind(...next) {values=next;return statement;}, async first(){return sql.prepare(query).get(...values) ?? null;}, async all(){return {results:sql.prepare(query).all(...values),success:true,meta:{}};}, async run(){const r=sql.prepare(query).run(...values);return {success:true,meta:{changes:Number(r.changes)}};} }; return statement; } };
  const env = { DB: d1, SQUARE_APPLICATION_ID: APP_ID, SQUARE_APPLICATION_SECRET: "LOCAL-NON-PRODUCTION-FIXTURE-SECRET-ONLY", ...options.env };
  const fixtures = { payments: [], refunds: [], orders: new Map(), paymentById: new Map(), refundById: new Map(), parents: { variation_current_both: "4N6654CHAAB4SYVNCJAEP36E" }, scopes: [...SCOPES], merchant: MERCHANT, location: LOCATION, ...options.fixtures };
  const calls = [];
  let user = { userId: OWNER, email: "seedy@sites.test", displayName: "Local fixture", fullName: null };
  let interceptor = null;
  const network = async (urlValue, request = {}) => {
    const url = new URL(urlValue); calls.push({ url: url.toString(), method: request.method || "GET", headers: request.headers, body: request.body });
    if (url.origin !== "https://connect.squareup.com") throw new Error("Unexpected fixture host");
    if (interceptor) { const result = await interceptor(url, request); if (result) return result; }
    const path = url.pathname;
    if (path === "/oauth2/token/status") return Response.json({ client_id: APP_ID, merchant_id: fixtures.merchant, scopes: fixtures.scopes, expires_at: "2027-01-01T00:00:00Z" });
    if (path === "/oauth2/token") return Response.json({ access_token: "local-access-fixture", refresh_token: "local-refresh-fixture", merchant_id: fixtures.merchant, token_type: "bearer", expires_at: "2027-01-01T00:00:00Z" });
    if (path === `/v2/merchants/${MERCHANT}`) return Response.json({ merchant: { id: fixtures.merchant, status: "ACTIVE", currency: "USD" } });
    if (path === "/v2/locations") return Response.json({ locations: [{ id: fixtures.location, merchant_id: MERCHANT, name: "Photo", status: "ACTIVE", currency: "USD" }] });
    if (path === "/v2/payments" || path === "/v2/refunds") {
      const key = path.endsWith("payments") ? "payments" : "refunds";
      const rows = fixtures[key]; const cursor = Number(url.searchParams.get("cursor") || 0); const limit = Number(url.searchParams.get("limit") || 20);
      return Response.json({ [key]: rows.slice(cursor, cursor+limit), ...(cursor+limit < rows.length ? {cursor:String(cursor+limit)} : {}) });
    }
    if (path.startsWith("/v2/payments/")) return Response.json({ payment: fixtures.paymentById.get(path.split("/").at(-1)) });
    if (path.startsWith("/v2/refunds/")) return Response.json({ refund: fixtures.refundById.get(path.split("/").at(-1)) });
    if (path.startsWith("/v2/orders/")) return Response.json({ order: fixtures.orders.get(path.split("/").at(-1)) });
    if (path.startsWith("/v2/catalog/object/")) { const id=path.split("/").at(-1); return Response.json({ object: { id, type:"ITEM_VARIATION", item_variation_data:{item_id:fixtures.parents[id] || "unrelated_parent"} } }); }
    throw new Error(`Unexpected local Square fixture endpoint ${path}`);
  };
  const modules = new Map();
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const code = ts.transpileModule(readFileSync(resolve(root,path),"utf8").replaceAll("import.meta", "__importMeta"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};modules.set(path,exports);
    const context=vm.createContext({exports, __importMeta:{env:{DEV:true}}, crypto:webcrypto, TextEncoder,TextDecoder,Uint8Array, Request,Response,Headers,URL,AbortController,atob,btoa,setTimeout,clearTimeout,console,fetch:network,require(name){if(name==="cloudflare:workers")return {env};if(name==="@/app/chatgpt-auth")return {getChatGPTUser:async()=>user};if(name.startsWith("@/"))return load(`${name.slice(2)}.ts`);throw new Error(`Unexpected import ${name}`);}});
    new vm.Script(code,{filename:path}).runInContext(context);return exports;
  }
  const core=load("lib/square-core.ts"); const sync=load("lib/square-sync.ts");
  function seedInquiry({reference="SBS-AABBCCDD",coverage="both",quote=60000,stage="quoted",isTest=0,...extra}={}) {
    const id=webcrypto.randomUUID();
    sql.prepare("INSERT INTO inquiries(id,submission_id,reference,created_at,updated_at,name,instagram,event_location,coverage,stage,quoted_media_cents,is_test) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,webcrypto.randomUUID(),reference,"2026-10-27T12:00:00Z","2026-10-27T12:00:00Z","Local fixture","qa_fixture","Miami Beach",coverage,stage,quote,isTest);
    for(const [key,value] of Object.entries(extra)) {if(!["decoration_settled","actual_costs_confirmed","booking_date","completed_date"].includes(key))throw new Error("Unsupported fixture field");sql.prepare(`UPDATE inquiries SET ${key}=? WHERE id=?`).run(value,id);}
    return id;
  }
  async function connect(now=NOW) {
    const cipher=await sync.encryptSquareTokens({accessToken:"local-access-fixture",refreshToken:"local-refresh-fixture"},OWNER);
    sql.prepare("INSERT OR REPLACE INTO square_connections(key,owner_id,merchant_id,location_id,encrypted_tokens,expires_at,refreshed_at,scopes_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("square_deposits",OWNER,MERCHANT,LOCATION,cipher,"2027-01-01T00:00:00.000Z",now.toISOString(),JSON.stringify(SCOPES),now.toISOString());
  }
  const enroll=(id,offerKey="current_both",now=NOW)=>sync.squareTrackerAction({action:"enrollQuote",payload:{inquiryId:id,offerKey,acceptedQuoteReference:"QUOTE-LOCAL-1",digitalOnly:true}},OWNER,now);
  function seedPayment(pay,ord=order(pay)) {fixtures.payments.push(pay);fixtures.paymentById.set(pay.id,pay);fixtures.orders.set(ord.id,ord);return pay;}
  function seedRefund(ref) {fixtures.refunds.push(ref);fixtures.refundById.set(ref.id,ref);return ref;}
  return {sql,env,fixtures,calls,load,core,sync,seedInquiry,connect,enroll,seedPayment,seedRefund,setUser(value){user=value;},setInterceptor(value){interceptor=value;},close(){sql.close();}};
}
