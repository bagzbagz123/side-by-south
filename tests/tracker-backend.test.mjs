import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sql = new DatabaseSync(":memory:");
let corruptSpendReadback = false;
sql.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync(resolve(root, "drizzle")).filter(name => name.endsWith(".sql")).sort()) sql.exec(readFileSync(resolve(root, "drizzle", file), "utf8"));
const d1 = {
  async batch(statements) {
    sql.exec("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec("COMMIT"); return result; }
    catch (error) { sql.exec("ROLLBACK"); throw error; }
  },
  prepare(query) {
    let values = [];
    const statement = {
      bind(...next) { values = next; return statement; },
      async first() { return sql.prepare(query).get(...values) ?? null; },
      async all() { const results = sql.prepare(query).all(...values); if (corruptSpendReadback && query.startsWith("SELECT date, amount_cents, verified_at, notes")) results[0].amount_cents += 1; return { results, success: true, meta: {} }; },
      async run() { const result = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  },
};
let user = null;
const workerEnv = { DB: d1 };
let graphCalls = [];
let graphFixture = async () => { throw new Error("Unexpected network request in a unit test"); };
const modules = new Map();
const development = { env: { DEV: false } };
function load(path) {
  if (modules.has(path)) return modules.get(path);
  const source = readFileSync(resolve(root, path), "utf8").replaceAll("import.meta", "__importMeta");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  modules.set(path, exports);
  const imports = {
    "cloudflare:workers": { env: workerEnv },
    "@/app/chatgpt-auth": { getChatGPTUser: async () => user },
    "@/lib/owner-access": () => load("lib/owner-access.ts"),
    "@/lib/tracker-store": () => load("lib/tracker-store.ts"),
    "@/lib/cloud-tracking": () => load("lib/cloud-tracking.ts"),
    "@/lib/tracker-metrics": () => load("lib/tracker-metrics.ts"),
    "@/lib/campaign-daily-summary": () => load("lib/campaign-daily-summary.ts"),
    "@/lib/square-sync": () => load("lib/square-sync.ts"),
    "@/lib/square-core": () => load("lib/square-core.ts"),
  };
  const context = vm.createContext({ exports, __importMeta: development, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Request, Response, URL, AbortController, setTimeout, clearTimeout, fetch: async (url, options) => { graphCalls.push({ url, options }); return graphFixture(url, options); }, console, require(name) { if (!(name in imports)) throw new Error(`Unexpected import: ${name}`); const value = imports[name]; return typeof value === "function" ? value() : value; } });
  new vm.Script(compiled, { filename: path }).runInContext(context);
  return exports;
}
const store = load("lib/tracker-store.ts");
const owner = load("lib/owner-access.ts");
const inquiryApi = load("app/api/inquiries/route.ts");
const trackerApi = load("app/api/tracker/route.ts");
const cloud = load("lib/cloud-tracking.ts");
const mcpApi = load("app/mcp/route.ts");
const makeRequest = (path, body, origin = "https://sidebysouth.com") => new Request(`https://sidebysouth.com${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
const inquiry = (overrides = {}) => ({ submissionId: webcrypto.randomUUID(), name: "QA fixture — local only", instagram: "qa_local_fixture", eventDate: "2026-10-30", flexibleDate: false, eventLocation: "Miami Beach", coverage: "both", notes: "Local test; never inserted into production", attribution: { campaign_id: store.CAMPAIGN_ID, ad_id: store.VIDEO_AD_ID, utm_source: "instagram", utm_medium: "paid_social" }, consent: true, company: "", ...overrides });
let inquiryId;

test("anonymous and non-owner visitors cannot access or change private financial records", async () => {
  user = null;
  assert.equal((await trackerApi.GET()).status, 401);
  assert.equal((await trackerApi.POST(makeRequest("/api/tracker", { action: "updateSettings", payload: { monthlySoftwareCents: 0 } }))).status, 401);
  user = { userId: "unrelated-user", email: "visitor@example.test", displayName: "Visitor", fullName: null };
  assert.equal(await owner.isOwner(user), false);
  assert.equal((await trackerApi.GET()).status, 403);
  assert.equal(await owner.isOwner({ userId: "local_seedy", email: "seedy@sites.test" }), false, "production must not accept preview identity");
  user = null;
});

test("public form rejects wrong origins, missing consent, invalid dates, oversized requests and test marking", async () => {
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry(), "https://attacker.example"))).status, 403);
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ consent: false })))).status, 400);
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ eventDate: "2026-02-30" })))).status, 400);
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ isTest: true })))).status, 400);
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ notes: "x".repeat(20000) })))).status, 413);
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ company: "bot" })))).status, 400);
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM inquiries").get().count, 0);
});

const packageAttribution = {
  utm_source: "instagram", utm_medium: "paid_social", utm_campaign: "sbs_proposals_20261026",
  utm_content: "package_1250_static", campaign_id: "120255494608980357",
  adset_id: "120255494608970357", ad_id: "120255499730570357",
};

test("package ad captures the original seven URL fields without changing financial or campaign settings", () => {
  const validated = store.validateInquiry(inquiry({ attribution: packageAttribution }));
  assert.equal(store.PACKAGE_AD_ID, packageAttribution.ad_id);
  assert.equal(validated.source, "captured_url");
  assert.equal(validated.sourceAdId, packageAttribution.ad_id);
  for (const [key, value] of Object.entries(packageAttribution)) assert.equal(validated.attribution[key], value);
  assert.equal("quotedMediaCents" in validated, false);
  assert.equal(store.BASE_SETTINGS.packageAdId, packageAttribution.ad_id);
  assert.equal(store.BASE_SETTINGS.budgetCents, 10000);
});

test("manual package attribution accepts only a known ad and retains client-reported confidence", () => {
  const validated = store.validateInquiry(inquiry({ source: "client_reported", sourceAdId: packageAttribution.ad_id, attribution: {} }), true);
  assert.equal(validated.source, "client_reported");
  assert.equal(validated.sourceAdId, packageAttribution.ad_id);
  assert.equal(validated.attribution.campaign_id, store.CAMPAIGN_ID);
  assert.equal(validated.attribution.ad_id, packageAttribution.ad_id);
  assert.throws(() => store.validateInquiry(inquiry({ source: "client_reported", sourceAdId: "unrelated-ad", attribution: {} }), true), /Choose one of this campaign's ads/);
});

test("package URL attribution fails closed for unrelated ad or campaign IDs and forged public confidence", () => {
  for (const attribution of [
    { ...packageAttribution, ad_id: "unrelated-ad" },
    { ...packageAttribution, campaign_id: "unrelated-campaign" },
  ]) {
    const validated = store.validateInquiry(inquiry({ attribution }));
    assert.equal(validated.source, "unknown");
    assert.equal(validated.sourceAdId, null);
    assert.equal(validated.attribution.ad_id, attribution.ad_id, "preserve raw evidence without assigning campaign confidence");
  }
  assert.throws(() => store.validateInquiry(inquiry({ attribution: packageAttribution, source: "captured_url" })), /public inquiry fields only/);
  for (const ad_id of [store.VIDEO_AD_ID, store.PHOTO_AD_ID]) assert.equal(store.validateInquiry(inquiry({ attribution: { ...packageAttribution, ad_id } })).source, "captured_url");
});

test("duplicate submission is idempotent and returns only reference and ID", async () => {
  const value = inquiry();
  const first = await inquiryApi.POST(makeRequest("/api/inquiries", value));
  assert.equal(first.status, 201);
  const result = await first.json();
  assert.deepEqual(Object.keys(result).sort(), ["id", "reference"]);
  assert.match(result.reference, /^SBS-[0-9A-F]{8}$/);
  const again = await inquiryApi.POST(makeRequest("/api/inquiries", value));
  assert.deepEqual(await again.json(), result);
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM inquiries").get().count, 1);
  inquiryId = result.id;
});

test("parameterized insertion treats SQL text as data and limits repeated handle submissions", async () => {
  for (let i = 0; i < 2; i++) {
    const result = await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ name: "Robert'); DROP TABLE inquiries;--" })));
    assert.equal(result.status, 201);
  }
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry()))).status, 429);
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM inquiries").get().count, 3);
});

test("authenticated local owner can read records; financial inserts reject duplicates and invalid cents", async () => {
  development.env.DEV = true;
  user = { userId: "local_seedy", email: "seedy@sites.test", displayName: "Seedy", fullName: null };
  assert.equal((await trackerApi.GET()).status, 200);
  const transaction = { id: webcrypto.randomUUID(), inquiryId, occurredOn: "2026-10-26", type: "media_deposit", amountCents: 20000, method: "zelle", referenceNote: "local-confirmation-001" };
  const add = payload => trackerApi.POST(makeRequest("/api/tracker", { action: "addTransaction", payload }));
  assert.equal((await add(transaction)).status, 200);
  assert.equal((await add(transaction)).status, 409);
  assert.equal((await add({ ...transaction, id: webcrypto.randomUUID() })).status, 409);
  assert.equal((await add({ ...transaction, id: webcrypto.randomUUID(), referenceNote: "other", amountCents: -100 })).status, 400);
  assert.equal((await add({ ...transaction, id: webcrypto.randomUUID(), referenceNote: "other", amountCents: 100.5 })).status, 400);
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM ledger_transactions").get().count, 1);
});

test("actual spend stays blank until verified and business settings cannot alter Meta budget", async () => {
  const read = await (await trackerApi.GET()).json();
  assert.equal(read.spend.length, 0);
  assert.equal(read.settings.budgetCents, 10000);
  assert.equal(read.settings.monthlySoftwareCents, 10000);
  assert.equal(read.settings.softwareBusinessUseShare, null);
  const post = (action, payload) => trackerApi.POST(makeRequest("/api/tracker", { action, payload }));
  assert.equal((await post("updateSettings", { budgetCents: 100000 })).status, 400);
  assert.equal((await post("saveSpend", { date: "2026-11-02", amountCents: 100, verifiedAt: new Date().toISOString(), notes: "test" })).status, 400);
  assert.equal((await post("saveSpend", { date: "2026-11-01", amountCents: 0, verifiedAt: new Date().toISOString(), notes: "Local test confirmed zero" })).status, 200);
  assert.equal((await (await trackerApi.GET()).json()).spend[0].amountCents, 0);
});

test("owner can mark QA records as tests; public GET exposes no inquiry data", async () => {
  const result = await trackerApi.POST(makeRequest("/api/tracker", { action: "updateInquiry", payload: { id: inquiryId, isTest: true, decorationSettled: true, actualCostsConfirmed: true } }));
  assert.equal(result.status, 200);
  const data = await (await trackerApi.GET()).json();
  const lead = data.inquiries.find(row => row.id === inquiryId);
  assert.equal(lead.isTest, true);
  assert.equal(lead.decorationSettled, true);
  assert.equal(lead.actualCostsConfirmed, true);
  const publicRead = await inquiryApi.GET();
  assert.equal(publicRead.status, 405);
  assert.equal((await publicRead.json()).inquiries, undefined);
});

test("void and restore retain original amounts with an immutable correction audit", async () => {
  const tx = sql.prepare("SELECT id FROM ledger_transactions LIMIT 1").get();
  const post = (action, payload) => trackerApi.POST(makeRequest("/api/tracker", { action, payload }));
  const before = sql.prepare("SELECT amount_cents, type, reference_note FROM ledger_transactions WHERE id = ?").get(tx.id);
  assert.equal((await post("voidTransaction", { id: tx.id, reason: "Entered twice by mistake" })).status, 200);
  assert.equal((await post("voidTransaction", { id: tx.id, reason: "Another click" })).status, 409);
  let row = (await (await trackerApi.GET()).json()).transactions.find(value => value.id === tx.id);
  assert.ok(row.voidedAt);
  assert.equal(row.auditEvents.length, 1);
  assert.equal((await post("restoreTransaction", { id: tx.id, reason: "Confirmed this was the original transfer" })).status, 200);
  row = (await (await trackerApi.GET()).json()).transactions.find(value => value.id === tx.id);
  assert.equal(row.voidedAt, null);
  assert.equal(row.auditEvents.length, 2);
  assert.deepEqual(sql.prepare("SELECT amount_cents, type, reference_note FROM ledger_transactions WHERE id = ?").get(tx.id), before);
  assert.equal((await post("restoreTransaction", { id: tx.id, reason: "Repeated request" })).status, 409);
});

test("restoration cannot reactivate a duplicate payment reference", async () => {
  const tx = sql.prepare("SELECT * FROM ledger_transactions LIMIT 1").get();
  const post = (action, payload) => trackerApi.POST(makeRequest("/api/tracker", { action, payload }));
  assert.equal((await post("voidTransaction", { id: tx.id, reason: "Replace with corrected record" })).status, 200);
  assert.equal((await post("addTransaction", { id: webcrypto.randomUUID(), inquiryId, occurredOn: tx.occurred_on, type: tx.type, amountCents: tx.amount_cents, method: tx.method, referenceNote: tx.reference_note })).status, 200);
  assert.equal((await post("restoreTransaction", { id: tx.id, reason: "Attempt conflicting restoration" })).status, 409);
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM transaction_audit WHERE transaction_id = ?").get(tx.id).count, 3, "failed restore must not append audit or change original state");
});

test("responses do not expose CORS access or permit injected campaign-budget settings", async () => {
  const publicRead = await inquiryApi.GET();
  assert.equal(publicRead.headers.get("access-control-allow-origin"), null);
  assert.equal(publicRead.headers.get("cache-control"), "no-store");
  const privateRead = await trackerApi.GET();
  assert.equal(privateRead.headers.get("access-control-allow-origin"), null);
  assert.equal(privateRead.headers.get("cache-control"), "private, no-store");
  assert.equal((await trackerApi.POST(makeRequest("/api/tracker", { action: "updateSettings", payload: { campaignId: "other", budgetCents: 100000 } }))).status, 400);
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ budgetCents: 1, stage: "completed" })))).status, 400);
});

test("expense and partner-ledger changes atomically clear stale cost confirmations", async () => {
  const post = (action, payload) => trackerApi.POST(makeRequest("/api/tracker", { action, payload }));
  const confirmed = () => post("updateInquiry", { id: inquiryId, actualCostsConfirmed: true, decorationSettled: true });
  await confirmed();
  const expenseId = webcrypto.randomUUID();
  assert.equal((await post("addTransaction", { id: expenseId, inquiryId, occurredOn: "2026-10-30", type: "direct_expense", amountCents: 5000, method: "cash", referenceNote: "Local cost fixture" })).status, 200);
  assert.equal(sql.prepare("SELECT actual_costs_confirmed FROM inquiries WHERE id = ?").get(inquiryId).actual_costs_confirmed, 0);
  await confirmed();
  assert.equal((await post("voidTransaction", { id: expenseId, reason: "Fix local cost test" })).status, 200);
  assert.equal(sql.prepare("SELECT actual_costs_confirmed FROM inquiries WHERE id = ?").get(inquiryId).actual_costs_confirmed, 0);
  await confirmed();
  assert.equal((await post("restoreTransaction", { id: expenseId, reason: "Recheck local cost test" })).status, 200);
  assert.equal(sql.prepare("SELECT actual_costs_confirmed FROM inquiries WHERE id = ?").get(inquiryId).actual_costs_confirmed, 0);
  const decorId = webcrypto.randomUUID();
  await confirmed();
  assert.equal((await post("addTransaction", { id: decorId, inquiryId, occurredOn: "2026-10-30", type: "partner_payout", amountCents: 60000, method: "bank_transfer", referenceNote: "Local partner fixture" })).status, 200);
  assert.equal(sql.prepare("SELECT decoration_settled FROM inquiries WHERE id = ?").get(inquiryId).decoration_settled, 0);
  await confirmed();
  assert.equal((await post("voidTransaction", { id: decorId, reason: "Fix local partner test" })).status, 200);
  assert.equal(sql.prepare("SELECT decoration_settled FROM inquiries WHERE id = ?").get(inquiryId).decoration_settled, 0);
});

const rpcRequest = (method, params) => new Request("https://sidebysouth.com/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const ownerFixture = () => { development.env.DEV = true; user = { userId: "local_seedy", email: "seedy@sites.test", displayName: "Seedy", fullName: null }; };
const dailyRow = (day, spend, overrides = {}) => ({ account_id: "2313142399498951", account_currency: "USD", campaign_id: "120255494608980357", date_start: day, date_stop: day, spend, ...overrides });
let insightFixture = { data: [] };
let dmInsightFixture = null;
function validGraphFixture() {
  graphCalls = [];
  dmInsightFixture = null;
  graphFixture = async url => {
    const path = new URL(url).pathname;
    if (path === "/v26.0/act_2313142399498951") return Response.json({ id: "act_2313142399498951", account_id: "2313142399498951", currency: "USD", timezone_name: "America/New_York", account_status: 1 });
    if (path === "/v26.0/120255494608980357") return Response.json({ id: "120255494608980357", account_id: "2313142399498951" });
    if (path === "/v26.0/120255493267260357") return Response.json({ id: "120255493267260357", account_id: "2313142399498951" });
    if (path === "/v26.0/120255493267260357/insights") {
      const fixture = dmInsightFixture || (typeof insightFixture === "function" ? insightFixture(new URL(url)) : insightFixture);
      return Response.json(dmInsightFixture ? fixture : { data: fixture.data.map(row => ({ ...row, campaign_id: "120255493267260357", spend: "0.00" })) });
    }
    if (path === "/v26.0/120255494608980357/insights") return Response.json(typeof insightFixture === "function" ? insightFixture(new URL(url)) : insightFixture);
    throw new Error("Unexpected Graph endpoint");
  };
}

test("MCP discovery is public metadata, while every tool call is owner-only and bounded", async () => {
  user = null;
  const list = await mcpApi.POST(rpcRequest("tools/list"));
  const data = await list.json();
  assert.deepEqual(data.result.tools.map(tool => tool.name).sort(), ["get_square_status", "sync_square_deposits", "get_tracking_status", "get_campaign_daily_summary", "verify_meta_connection", "sync_campaign_spend", "get_pending_inquiry_alerts", "acknowledge_inquiry_alerts"].sort());
  for (const name of ["get_square_status", "sync_square_deposits"]) assert.equal((await mcpApi.POST(rpcRequest("tools/call", { name, arguments: {} }))).status, 401);
  assert.equal(JSON.stringify(data).includes("qa_local_fixture"), false);
  assert.equal((await mcpApi.POST(rpcRequest("tools/call", { name: "get_tracking_status", arguments: {} }))).status, 401);
  assert.equal((await mcpApi.POST(rpcRequest("tools/call", { name: "get_campaign_daily_summary", arguments: {} }))).status, 401);
  assert.equal((await mcpApi.GET()).status, 405);
  ownerFixture();
  const summary = await (await mcpApi.POST(rpcRequest("tools/call", { name: "get_campaign_daily_summary", arguments: {} }))).json();
  assert.equal(summary.result.isError, false);
  assert.equal(summary.result.structuredContent.status, "ok");
  assert.equal(JSON.stringify(summary).includes("qa_local_fixture"), false);
  assert.equal(JSON.stringify(summary).includes("QA fixture"), false);
  const arbitraryDate = await (await mcpApi.POST(rpcRequest("tools/call", { name: "get_campaign_daily_summary", arguments: { date: "2099-01-01" } }))).json();
  assert.equal(arbitraryDate.result.structuredContent.code, "invalid_arguments");
  const invalid = await (await mcpApi.POST(rpcRequest("tools/call", { name: "sync_campaign_spend", arguments: { url: "https://attacker.example" } }))).json();
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent.code, "invalid_arguments");
  assert.equal((await mcpApi.POST(rpcRequest("tools/list"))).headers.get("access-control-allow-origin"), null);
});

test("native MCP protocol metadata is accepted without relaxing tool argument validation", async () => {
  ownerFixture();
  delete workerEnv.META_ADS_READ_TOKEN;
  const native = await (await mcpApi.POST(rpcRequest("tools/call", { name: "get_tracking_status", arguments: {}, _meta: { progressToken: "native-test-progress", "openai/toolInvocation": "fixture" } }))).json();
  assert.notEqual(native.result.structuredContent.code, "invalid_arguments");
  assert.equal(native.result.structuredContent.status, "setup_required");
  assert.equal(native.result.isError, false);
  assert.equal(typeof native.result.structuredContent.tokenConfigured, "boolean");
  assert.equal(JSON.stringify(native).includes("native-test-progress"), false);
  const injected = await (await mcpApi.POST(rpcRequest("tools/call", { name: "get_tracking_status", arguments: { _meta: {} }, _meta: { progressToken: "allowed-protocol-metadata" } }))).json();
  assert.equal(injected.result.structuredContent.code, "invalid_arguments");
  for (const name of ["verify_meta_connection", "sync_campaign_spend"]) {
    const missingCredential = await (await mcpApi.POST(rpcRequest("tools/call", { name, arguments: {}, _meta: {} }))).json();
    assert.equal(missingCredential.result.structuredContent.status, "setup_required");
    assert.equal(missingCredential.result.isError, true);
  }
  user = null;
  assert.equal((await mcpApi.POST(rpcRequest("tools/call", { name: "get_tracking_status", arguments: {}, _meta: {} }))).status, 401);
  ownerFixture();
});

test("missing Meta credential is setup_required and never fabricates zero spend", async () => {
  delete workerEnv.META_ADS_READ_TOKEN;
  const before = sql.prepare("SELECT COUNT(*) AS n FROM ad_spend").get().n;
  const result = await cloud.syncCampaignSpend(new Date("2026-10-27T15:00:00Z"));
  assert.equal(result.status, "setup_required");
  assert.equal(result.code, "missing_token");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ad_spend").get().n, before);
  assert.equal((await cloud.getCloudTrackingStatus()).tokenConfigured, false);
});

test("connection verifies exact identifiers before start; spend sync remains a no-op until October 25 at 8:10 AM EDT", async () => {
  workerEnv.META_ADS_READ_TOKEN = "unit-test-secret-not-real";
  validGraphFixture();
  const before = sql.prepare("SELECT COUNT(*) AS n FROM ad_spend").get().n;
  assert.equal((await cloud.verifyMetaConnection(new Date("2026-10-25T12:00:00Z"))).status, "verified");
  assert.equal(graphCalls.length, 3);
  assert.equal(new URL(graphCalls[0].url).searchParams.get("fields"), "id,account_id,currency,timezone_name");
  graphCalls = [];
  assert.equal((await cloud.syncCampaignSpend(new Date("2026-10-25T12:09:59Z"))).status, "not_started");
  assert.equal(graphCalls.length, 0);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ad_spend").get().n, before);
  assert.equal(cloud.decimalSpendCents("0.29"), 29);
  assert.throws(() => cloud.decimalSpendCents("0.291"));
});

test("Meta reads use Workers-compatible manual redirects and never follow a redirect with the credential", async () => {
  workerEnv.META_ADS_READ_TOKEN = "unit-test-secret-not-real";
  validGraphFixture();
  const verified = await cloud.verifyMetaConnection(new Date("2026-10-25T16:00:00Z"));
  assert.equal(verified.status, "verified");
  assert.equal(graphCalls.length, 3);
  assert.equal(graphCalls.every(call => call.options.redirect === "manual"), true);
  graphCalls = [];
  graphFixture = async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/private?fixture=never-follow" } });
  const redirected = await cloud.verifyMetaConnection(new Date("2026-10-25T17:00:00Z"));
  assert.equal(redirected.status, "error");
  assert.equal(redirected.code, "meta_redirect_blocked");
  assert.equal(graphCalls.length, 1);
  assert.equal(new URL(graphCalls[0].url).hostname, "graph.facebook.com");
  assert.equal(JSON.stringify(redirected).includes("attacker.example"), false);
  assert.equal(JSON.stringify(redirected).includes(workerEnv.META_ADS_READ_TOKEN), false);
  validGraphFixture();
});

test("Meta failures expose bounded diagnostics and distinguish actionable classes without provider text", async () => {
  workerEnv.META_ADS_READ_TOKEN = "unit-test-secret-not-real";
  const before = sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all();
  const cases = [
    { http: 400, code: 190, expected: "token_rejected" },
    { http: 400, code: 102, expected: "token_rejected" },
    { http: 401, code: 999, expected: "token_rejected" },
    { http: 400, code: 10, expected: "meta_access_denied" },
    { http: 400, code: 200, expected: "meta_access_denied" },
    { http: 400, code: 299, expected: "meta_access_denied" },
    { http: 403, code: 999, expected: "meta_access_denied" },
    ...[4, 17, 341].map(code => ({ http: 400, code, expected: "meta_rate_limited" })),
    { http: 429, code: 999, expected: "meta_rate_limited" },
    { http: 400, code: 100, expected: "meta_invalid_request" },
    { http: 400, code: 999, transient: true, expected: "meta_transient_failure" },
    { http: 503, code: 999, expected: "meta_transient_failure" },
    { http: 400, code: 777, expected: "meta_request_failed" },
    { http: 400, code: 613, expected: "meta_request_failed" },
    { http: 400, code: 80004, expected: "meta_request_failed" },
  ];
  for (const item of cases) {
    validGraphFixture();
    graphFixture = async () => Response.json({ error: { code: item.code, error_subcode: 33, is_transient: item.transient ?? false, message: "raw-provider-private unit-test-secret-not-real https://private.example", error_user_msg: "never-return-this", fbtrace_id: "private-trace", unexpected: { token: "unit-test-secret-not-real" } } }, { status: item.http });
    const result = await cloud.verifyMetaConnection(new Date("2026-10-26T19:00:00Z"));
    assert.equal(result.status, "error");
    assert.equal(result.code, item.expected);
    assert.equal(result.spendChanged, false);
    assert.equal(result.diagnostics.requestStage, "account_identity");
    assert.equal(result.diagnostics.httpStatus, item.http);
    assert.equal(result.diagnostics.graphCode, item.code);
    assert.equal(result.diagnostics.graphSubcode, 33);
    assert.equal(result.diagnostics.transient, item.transient ?? false);
    assert.equal(result.diagnostics.reason, null);
    assert.equal(Object.keys(result.diagnostics).sort().join(","), "graphCode,graphSubcode,httpStatus,reason,requestStage,transient");
    assert.equal(/raw-provider-private|unit-test-secret-not-real|private\.example|never-return-this|private-trace/.test(JSON.stringify(result)), false);
    assert.equal(/raw-provider-private|unit-test-secret-not-real|private\.example|never-return-this|private-trace/.test(JSON.stringify(sql.prepare("SELECT * FROM tracking_cloud_state WHERE key = 'meta_spend'").get())), false);
  }
  assert.deepEqual(sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all(), before);
  validGraphFixture();
});

test("Meta diagnostics identify each fixed request stage and never turn an Insights failure into spend", async () => {
  const cases = [
    ["/v26.0/120255494608980357", "website_campaign_identity", false],
    ["/v26.0/120255493267260357", "dm_campaign_identity", false],
    ["/v26.0/120255494608980357/insights", "website_insights", true],
    ["/v26.0/120255493267260357/insights", "dm_insights", true],
  ];
  for (const [path, stage, sync] of cases) {
    validGraphFixture();
    insightFixture = { data: [dailyRow("2026-10-25", "12.34")] };
    const original = graphFixture;
    graphFixture = async (url, options) => new URL(url).pathname === path ? Response.json({ error: { code: 100, error_subcode: 33, message: "Unsupported get request. Object with ID private-object cannot be loaded." } }, { status: 400 }) : original(url, options);
    const before = sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all();
    const result = sync ? await cloud.syncCampaignSpend(new Date("2026-10-26T20:00:00Z")) : await cloud.verifyMetaConnection(new Date("2026-10-26T20:00:00Z"));
    assert.equal(result.code, "meta_invalid_request");
    assert.equal(result.diagnostics.requestStage, stage);
    assert.equal(result.diagnostics.reason, "unsupported_get_request");
    assert.equal(JSON.stringify(result).includes("private-object"), false);
    assert.deepEqual(sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all(), before);
  }
  validGraphFixture();
});

test("Meta reason hints stay in an allowlist and malformed diagnostic scalars remain unknown", async () => {
  for (const [message, reason] of [
    ["Tried accessing nonexisting field (private_field) on node type (private_type)", "nonexisting_field"],
    ["API calls from the server require an appsecret_proof argument; private-detail", "appsecretproof_required"],
    ["The appsecret_proof parameter is required. private-detail", "appsecretproof_required"],
    ["Ad account owner has NOT grant ads_management or ads_read permission. private-detail", "missing_ads_permission"],
    ["This endpoint requires ads_read permission. private-detail", "missing_ads_permission"],
    ["The ads_read permission is not granted. private-detail", "missing_ads_permission"],
    ["This endpoint requires business_management permission. private-detail", "missing_business_permission"],
    ["This endpoint does not require ads_management permission. private-detail", null],
    ["unrecognized private-detail", null],
  ]) {
    graphFixture = async () => Response.json({ error: { code: "190", error_subcode: 2147483648, is_transient: "true", message } }, { status: 400 });
    const result = await cloud.verifyMetaConnection(new Date("2026-10-26T21:00:00Z"));
    assert.equal(result.code, "meta_request_failed");
    assert.equal(result.diagnostics.graphCode, null);
    assert.equal(result.diagnostics.graphSubcode, null);
    assert.equal(result.diagnostics.transient, null);
    assert.equal(result.diagnostics.reason, reason);
    assert.equal(/private-detail|private_field|private_type|unrecognized/.test(JSON.stringify(result)), false);
  }
  graphFixture = async () => Response.json({ error: { code: { private: "provider-secret-canary" }, error_subcode: [33], is_transient: { private: "provider-secret-canary" }, message: { private: "provider-secret-canary" } } }, { status: 400 });
  const malformed = await cloud.verifyMetaConnection(new Date("2026-10-26T21:30:00Z"));
  assert.equal(malformed.code, "meta_request_failed");
  assert.equal(malformed.diagnostics.graphCode, null);
  assert.equal(malformed.diagnostics.graphSubcode, null);
  assert.equal(malformed.diagnostics.transient, null);
  assert.equal(malformed.diagnostics.reason, null);
  assert.equal(JSON.stringify(malformed).includes("provider-secret-canary"), false);
  validGraphFixture();
});

test("owner verification after Graph 200 exposes only the saved reporting-user match and ads_read status", async () => {
  const before = sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all();
  for (const [id, entries, expectedMatch, expectedStatus] of [
    ["61596021804025", [{ permission: "ads_read", status: "granted" }], true, "granted"],
    ["123456789", [{ permission: "ads_read", status: "declined" }], false, "declined"],
    ["61596021804025", [{ permission: "private_other_permission", status: "granted" }], true, "absent"],
    ["private-malformed-id", [{ permission: "ads_read", status: "expired" }], null, "unknown"],
  ]) {
    validGraphFixture();
    graphFixture = async url => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me") { assert.equal(parsed.searchParams.get("fields"), "id"); return Response.json({ id, private_extra: "provider-secret-canary" }); }
      if (parsed.pathname === "/v26.0/me/permissions") { assert.equal(parsed.searchParams.get("limit"), "100"); return Response.json({ data: entries, private_extra: "provider-secret-canary" }); }
      assert.equal(parsed.pathname, "/v26.0/act_2313142399498951");
      return Response.json({ error: { code: 200, message: "Ad account owner has NOT grant ads_management or ads_read permission. provider-secret-canary" } }, { status: 400 });
    };
    const result = await cloud.verifyMetaConnection(new Date("2026-10-26T22:00:00Z"));
    assert.equal(result.code, "meta_access_denied");
    assert.equal(result.diagnostics.graphCode, 200);
    assert.equal(result.diagnostics.requestStage, "account_identity");
    assert.equal(result.diagnostics.reason, "missing_ads_permission");
    assert.equal(result.credentialChecks.matchesReportingUser, expectedMatch);
    assert.equal(result.credentialChecks.adsReadStatus, expectedStatus);
    assert.equal(Object.keys(result.credentialChecks).sort().join(","), "adsReadStatus,matchesReportingUser");
    assert.equal(graphCalls.length, 3);
    assert.equal(/61596021804025|123456789|private-malformed-id|private_other_permission|provider-secret-canary/.test(JSON.stringify(result)), false);
    assert.equal(/provider-secret-canary|private_other_permission/.test(JSON.stringify(sql.prepare("SELECT * FROM tracking_cloud_state WHERE key = 'meta_spend'").get())), false);
  }
  assert.deepEqual(sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all(), before);
  validGraphFixture();
});

test("failed or incomplete credential checks preserve the original permission error and never follow paging", async () => {
  for (const mode of ["failed", "paged", "oversized", "duplicate"]) {
    validGraphFixture();
    graphFixture = async url => {
      const path = new URL(url).pathname;
      if (path === "/v26.0/act_2313142399498951") return Response.json({ error: { code: 200, error_subcode: 7, message: "original-provider-secret-canary" } }, { status: 400 });
      if (path === "/v26.0/me") return Response.json({ error: { code: 190, message: "fallback-provider-secret-canary" } }, { status: 401 });
      assert.equal(path, "/v26.0/me/permissions");
      if (mode === "failed") return Response.json({ error: { code: 100, message: "fallback-provider-secret-canary" } }, { status: 400 });
      if (mode === "paged") return Response.json({ data: [{ permission: "ads_read", status: "granted" }], paging: { next: "https://never-follow.example/private" } });
      if (mode === "oversized") return Response.json({ data: Array(101).fill({ permission: "ads_read", status: "granted" }) });
      return Response.json({ data: [{ permission: "ads_read", status: "granted" }, { permission: "ads_read", status: "declined" }] });
    };
    const before = sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all();
    const result = await cloud.verifyMetaConnection(new Date("2026-10-26T22:30:00Z"));
    assert.equal(result.code, "meta_access_denied");
    assert.equal(result.diagnostics.graphCode, 200);
    assert.equal(result.diagnostics.graphSubcode, 7);
    assert.equal(result.diagnostics.requestStage, "account_identity");
    assert.equal(result.credentialChecks.matchesReportingUser, null);
    assert.equal(result.credentialChecks.adsReadStatus, "unknown");
    assert.equal(graphCalls.length, 3);
    assert.equal(graphCalls.every(call => new URL(call.url).hostname === "graph.facebook.com" && call.options.method === "GET" && !call.url.includes("access_token")), true);
    assert.equal(/provider-secret-canary|never-follow\.example/.test(JSON.stringify(result)), false);
    assert.deepEqual(sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all(), before);
  }
  validGraphFixture();
});

test("credential fallback is absent from normal spend sync and non-200 verification errors", async () => {
  validGraphFixture();
  graphFixture = async () => Response.json({ error: { code: 200 } }, { status: 400 });
  const before = sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all();
  const sync = await cloud.syncCampaignSpend(new Date("2026-10-26T23:00:00Z"));
  assert.equal(sync.diagnostics.graphCode, 200);
  assert.equal(sync.credentialChecks, undefined);
  assert.equal(graphCalls.length, 1);
  for (const code of [190, 10, 100, 299]) {
    graphCalls = [];
    graphFixture = async () => Response.json({ error: { code } }, { status: 400 });
    const verify = await cloud.verifyMetaConnection(new Date("2026-10-26T23:00:00Z"));
    assert.equal(verify.credentialChecks, undefined);
    assert.equal(graphCalls.length, 1);
  }
  assert.deepEqual(sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all(), before);
  validGraphFixture();
});

test("daily Meta sync replaces explicit rows idempotently and confirms persisted amounts before success", async () => {
  validGraphFixture();
  insightFixture = { data: [dailyRow("2026-10-25", "0.00"), dailyRow("2026-10-26", "12.34"), dailyRow("2026-10-27", "0.00")] };
  const when = new Date("2026-10-27T15:00:00Z");
  const first = await cloud.syncCampaignSpend(when);
  assert.equal(first.status, "synced");
  assert.equal(first.importedDayCount, 3);
  const row = sql.prepare("SELECT * FROM ad_spend WHERE date = ?").get("2026-10-26");
  assert.equal(row.amount_cents, 1234);
  assert.match(row.notes, /past day as reported/);
  assert.match(sql.prepare("SELECT notes FROM ad_spend WHERE date = ?").get("2026-10-27").notes, /current day provisional/);
  assert.equal((await cloud.syncCampaignSpend(when)).status, "synced");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ad_spend WHERE date = '2026-10-26'").get().n, 2);
  for (const call of graphCalls) { assert.equal(new URL(call.url).origin, "https://graph.facebook.com"); assert.equal(call.options.method, "GET"); assert.equal(call.options.redirect, "manual"); assert.equal(call.url.includes(workerEnv.META_ADS_READ_TOKEN), false); assert.equal(call.options.headers.Authorization, `Bearer ${workerEnv.META_ADS_READ_TOKEN}`); }
});

test("newer manual observations and readback mismatches cannot produce fake sync success", async () => {
  validGraphFixture();
  insightFixture = { data: [dailyRow("2026-10-26", "99.99"), dailyRow("2026-10-27", "0.00")] };
  sql.prepare("UPDATE ad_spend SET amount_cents = 1500, verified_at = '2026-10-27T17:00:00.000Z', notes = 'Later manual verification' WHERE date = '2026-10-26'").run();
  const priorSuccess = sql.prepare("SELECT last_success_at FROM tracking_cloud_state WHERE key = 'meta_spend'").get().last_success_at;
  const conflict = await cloud.syncCampaignSpend(new Date("2026-10-27T16:00:00Z"));
  assert.equal(conflict.status, "error");
  assert.equal(conflict.code, "spend_observation_conflict");
  assert.equal(sql.prepare("SELECT amount_cents FROM ad_spend WHERE date = '2026-10-26'").get().amount_cents, 1500);
  assert.equal(sql.prepare("SELECT last_success_at FROM tracking_cloud_state WHERE key = 'meta_spend'").get().last_success_at, priorSuccess);
  corruptSpendReadback = true;
  const mismatch = await cloud.syncCampaignSpend(new Date("2026-10-27T18:00:00Z"));
  corruptSpendReadback = false;
  assert.equal(mismatch.status, "error");
  assert.equal(mismatch.code, "spend_readback_mismatch");
  const state = sql.prepare("SELECT * FROM tracking_cloud_state WHERE key = 'meta_spend'").get();
  assert.equal(state.last_success_at, priorSuccess);
  assert.equal(state.last_imported_days, 0);
  assert.equal(state.lease_owner, null);
});

test("empty Meta data preserves known observations; hostile pagination and wrong account are rejected", async () => {
  validGraphFixture();
  insightFixture = { data: [] };
  const before = sql.prepare("SELECT date,amount_cents,verified_at,notes FROM ad_spend ORDER BY date").all();
  const empty = await cloud.syncCampaignSpend(new Date("2026-10-28T15:00:00Z"));
  assert.equal(empty.status, "incomplete");
  assert.equal(empty.code, "empty_report");
  assert.deepEqual(sql.prepare("SELECT date,amount_cents,verified_at,notes FROM ad_spend ORDER BY date").all(), before);
  insightFixture = { data: [dailyRow("2026-10-26", "1.00")], paging: { next: "https://attacker.example/steal", cursors: { after: "opaque" } } };
  const hostile = await cloud.syncCampaignSpend(new Date("2026-10-28T16:00:00Z"));
  assert.equal(hostile.code, "unsafe_pagination");
  assert.deepEqual(sql.prepare("SELECT date,amount_cents,verified_at,notes FROM ad_spend ORDER BY date").all(), before);
  insightFixture = { data: [dailyRow("2026-10-26", "1.00", { account_id: "other" })] };
  assert.equal((await cloud.syncCampaignSpend(new Date("2026-10-28T17:00:00Z"))).code, "invalid_meta_report");
});

test("sync lease prevents concurrent reads and pagination reconstructs only the fixed endpoint", async () => {
  validGraphFixture();
  sql.prepare("UPDATE tracking_cloud_state SET lease_owner = 'other', lease_expires_at = '2026-10-29T16:00:00.000Z' WHERE key = 'meta_spend'").run();
  assert.equal((await cloud.syncCampaignSpend(new Date("2026-10-29T15:00:00Z"))).code, "lease_active");
  assert.equal(graphCalls.length, 0);
  sql.prepare("UPDATE tracking_cloud_state SET lease_owner = NULL, lease_expires_at = NULL WHERE key = 'meta_spend'").run();
  insightFixture = url => url.searchParams.has("after") ? { data: [dailyRow("2026-10-27", "2.00")] } : { data: [dailyRow("2026-10-26", "1.00")], paging: { next: "https://graph.facebook.com/v26.0/120255494608980357/insights?access_token=provider-token&after=opaque", cursors: { after: "opaque" } } };
  const paged = await cloud.syncCampaignSpend(new Date("2026-10-29T17:00:00Z"));
  assert.equal(paged.status, "incomplete");
  assert.equal(paged.importedDayCount, 2);
  assert.equal(graphCalls.some(call => call.url.includes("access_token")), false);
  assert.equal(graphCalls.some(call => call.url.includes("after=opaque")), true);
});

test("a successful empty inquiry scan records a private durable receipt without changing Meta state", async () => {
  sql.prepare("UPDATE inquiries SET is_test = 1").run();
  const beforeMeta = sql.prepare("SELECT * FROM tracking_cloud_state WHERE key = 'meta_spend'").get();
  const when = new Date("2026-10-25T08:20:00.000Z");
  const empty = await cloud.getPendingInquiryAlerts(10, when);
  assert.equal(empty.checkedAt, when.toISOString());
  assert.equal(empty.alerts.length, 0);
  assert.equal(empty.claimId, null);
  const receipt = sql.prepare("SELECT * FROM tracking_cloud_state WHERE key = 'inquiry_alerts'").get();
  assert.equal(receipt.last_attempt_at, when.toISOString());
  assert.equal(receipt.last_status, "scanned");
  assert.equal(receipt.last_result_code, "empty");
  assert.equal(receipt.last_imported_days, 0);
  assert.deepEqual(sql.prepare("SELECT * FROM tracking_cloud_state WHERE key = 'meta_spend'").get(), beforeMeta);
  assert.equal((await cloud.getCloudTrackingStatus(when)).lastInquiryScanAt, when.toISOString());
  user = null;
  assert.equal((await mcpApi.POST(rpcRequest("tools/call", { name: "get_pending_inquiry_alerts", arguments: {} }))).status, 401);
  assert.equal(sql.prepare("SELECT last_attempt_at FROM tracking_cloud_state WHERE key = 'inquiry_alerts'").get().last_attempt_at, when.toISOString());
  ownerFixture();
});

test("inquiry alerts are minimal, lease-deduplicated, and acknowledgments only accept claimed real IDs", async () => {
  sql.prepare("UPDATE inquiries SET is_test = 1").run();
  const insert = sql.prepare("INSERT INTO inquiries (id,submission_id,reference,created_at,updated_at,name,instagram,event_date,event_location,coverage,is_test) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const realId = webcrypto.randomUUID();
  const testId = webcrypto.randomUUID();
  const oldId = webcrypto.randomUUID();
  for (const [id, created, isTest] of [[realId, "2026-10-25T08:10:00.000Z", 0], [testId, "2026-10-25T08:10:01.000Z", 1], [oldId, "2026-10-25T07:00:00.000Z", 0]]) insert.run(id, id, `SBS-${id.slice(0,8)}`, created, created, "Private fixture name", "private_fixture_handle", "2026-10-30", "Private fixture location", "both", isTest);
  const when = new Date("2026-10-25T08:30:00.000Z");
  const first = await cloud.getPendingInquiryAlerts(10, when);
  assert.equal(first.checkedAt, when.toISOString());
  assert.equal(first.alerts.length, 1);
  assert.equal(sql.prepare("SELECT last_result_code FROM tracking_cloud_state WHERE key = 'inquiry_alerts'").get().last_result_code, "pending");
  assert.equal(first.alerts[0].id, realId);
  assert.equal(JSON.stringify(first).includes("Private fixture name"), false);
  assert.equal(JSON.stringify(first).includes("private_fixture_handle"), false);
  assert.equal((await cloud.getPendingInquiryAlerts(10, when)).alerts.length, 0);
  await assert.rejects(cloud.acknowledgeInquiryAlerts(first.claimId, [testId], when));
  assert.equal((await cloud.acknowledgeInquiryAlerts(first.claimId, [realId], when)).status, "acknowledged");
  assert.equal((await cloud.acknowledgeInquiryAlerts(first.claimId, [realId], when)).status, "acknowledged");
  assert.equal((await cloud.getPendingInquiryAlerts(10, new Date("2026-10-25T09:00:00Z"))).alerts.length, 0);
  assert.equal((await cloud.getCloudTrackingStatus(when)).lastInquiryAlertReportedAt, when.toISOString());
});

test("only an owner can opt a persisted test inquiry into one labeled, deduplicated cloud alert", async () => {
  sql.prepare("UPDATE inquiries SET is_test = 1").run();
  const fixture = inquiry({ isTest: true, alertTest: true });
  user = null;
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", fixture))).status, 403);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE submission_id = ?").get(fixture.submissionId).n, 0);
  ownerFixture();
  for (const malformed of [{ isTest: false, alertTest: true }, { isTest: "true", alertTest: true }, { isTest: true, alertTest: "true" }, { isTest: true, alertTest: 1 }, { isTest: true, alertTest: null }]) {
    assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", inquiry(malformed)))).status, 400);
  }
  user = { userId: "not-the-owner", email: "visitor@example.test", displayName: "Visitor", fullName: null };
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", fixture))).status, 403);
  ownerFixture();
  const realFixture = inquiry();
  const real = await (await inquiryApi.POST(makeRequest("/api/inquiries", realFixture))).json();
  const priorRealRetry = await inquiryApi.POST(makeRequest("/api/inquiries", { ...realFixture, isTest: true, alertTest: true }));
  assert.equal(priorRealRetry.status, 400);
  assert.equal(sql.prepare("SELECT is_test FROM inquiries WHERE id = ?").get(real.id).is_test, 0);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM inquiry_alerts WHERE inquiry_id = ?").get(real.id).n, 0);
  sql.prepare("UPDATE inquiries SET is_test = 1 WHERE id = ?").run(real.id);
  const ordinary = await (await inquiryApi.POST(makeRequest("/api/inquiries", inquiry({ isTest: true })))).json();
  const firstResponse = await inquiryApi.POST(makeRequest("/api/inquiries", fixture));
  assert.equal(firstResponse.status, 201);
  const saved = await firstResponse.json();
  const retry = await (await inquiryApi.POST(makeRequest("/api/inquiries", fixture))).json();
  assert.equal(retry.id, saved.id);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM inquiry_alerts WHERE inquiry_id = ? AND is_test_alert = 1").get(saved.id).n, 1);
  assert.equal(sql.prepare("SELECT is_test FROM inquiries WHERE id = ?").get(saved.id).is_test, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM inquiry_alerts WHERE inquiry_id = ?").get(ordinary.id).n, 0);
  sql.prepare("UPDATE inquiries SET created_at = '2026-10-25T10:00:00.000Z' WHERE id IN (?,?)").run(saved.id, ordinary.id);
  const when = new Date("2026-10-25T12:00:00.000Z");
  const realCountBefore = (await cloud.getCloudTrackingStatus(when)).pendingInquiryAlerts;
  const ledgerBefore = sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n;
  const alert = await cloud.getPendingInquiryAlerts(25, when);
  assert.equal(alert.alerts.length, 1);
  assert.equal(alert.alerts[0].id, saved.id);
  assert.equal(alert.alerts[0].isTest, true);
  assert.equal(alert.alerts[0].testAlert, true);
  assert.equal(JSON.stringify(alert).includes(fixture.name), false);
  assert.equal(JSON.stringify(alert).includes(fixture.instagram), false);
  assert.equal((await cloud.getPendingInquiryAlerts(25, when)).alerts.length, 0);
  await assert.rejects(cloud.acknowledgeInquiryAlerts(alert.claimId, [ordinary.id], when));
  assert.equal((await cloud.acknowledgeInquiryAlerts(alert.claimId, [saved.id], when)).status, "acknowledged");
  assert.equal((await cloud.acknowledgeInquiryAlerts(alert.claimId, [saved.id], when)).status, "acknowledged");
  assert.equal((await inquiryApi.POST(makeRequest("/api/inquiries", fixture))).status, 201);
  assert.equal((await cloud.getPendingInquiryAlerts(25, new Date("2026-10-25T13:00:00Z"))).alerts.length, 0);
  assert.equal((await cloud.getCloudTrackingStatus(when)).pendingInquiryAlerts, realCountBefore);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n, ledgerBefore);
  assert.equal(sql.prepare("SELECT is_test FROM inquiries WHERE id = ?").get(saved.id).is_test, 1);
});

test("campaign status totals only eligible fixed-campaign rows and distinguishes unknown from confirmed zero", async () => {
  sql.exec("BEGIN");
  try {
    sql.prepare("DELETE FROM ad_spend").run();
    const now = new Date("2026-11-03T15:00:00.000Z");
    const none = await cloud.getCloudTrackingStatus(now);
    assert.equal(none.reportingDates.length, 8);
    assert.equal(none.reportingDates[0], "2026-10-25");
    assert.equal(none.reportingDates[7], "2026-11-01");
    assert.equal(none.confirmedSpendDates.length, 0);
    assert.equal(none.reportedSpendTotalCents, null);
    assert.equal(none.completeCampaignReporting, false);
    const insert = sql.prepare("INSERT INTO ad_spend (id,campaign_id,date,amount_cents,verified_at,notes) VALUES (?,?,?,?,?,?) ON CONFLICT(campaign_id,date) DO UPDATE SET amount_cents=excluded.amount_cents, verified_at=excluded.verified_at");
    const write = (campaign, day, amount, verified = now.toISOString()) => insert.run(`${campaign}:${day}`, campaign, day, amount, verified, "Local summary fixture");
    write("other-campaign", "2026-10-26", 99999);
    write("120255494608980357", "2026-10-24", 99999);
    write("120255494608980357", "2026-11-02", 99999);
    assert.equal((await cloud.getCloudTrackingStatus(now)).reportedSpendTotalCents, null);
    write("120255494608980357", "2026-10-26", 0);
    const zero = await cloud.getCloudTrackingStatus(now);
    assert.equal(zero.reportedSpendTotalCents, 0);
    assert.equal(zero.observedSpendDates.join(","), "2026-10-26");
    assert.equal(zero.confirmedSpendDates.length, 0, "the missing DM observation cannot become a confirmed zero");
    sql.prepare("UPDATE tracking_cloud_state SET last_status = 'synced', lease_owner = NULL, lease_expires_at = NULL WHERE key = 'meta_spend'").run();
    assert.equal((await cloud.getCloudTrackingStatus(now)).status, "incomplete", "an old website-only success does not verify the new combined coverage");
    write("120255494608980357", "2026-10-27", 1234);
    write("120255494608980357", "2026-10-28", 99999, "2026-11-05T15:00:00.000Z");
    const partial = await cloud.getCloudTrackingStatus(now);
    assert.equal(partial.reportedSpendTotalCents, 1234);
    assert.equal(partial.observedSpendDates.length, 2);
    assert.equal(partial.confirmedSpendDates.length, 0);
    assert.equal(partial.completeCampaignReporting, false);
    for (const day of none.reportingDates) { write("120255494608980357", day, 100); write("120255493267260357", day, 0); }
    const complete = await cloud.getCloudTrackingStatus(now);
    assert.equal(complete.reportedSpendTotalCents, 800);
    assert.equal(complete.completeCampaignReporting, true);
    assert.equal(complete.confirmedSpendDates.join(","), complete.reportingDates.join(","));
    assert.equal((await cloud.getCloudTrackingStatus(new Date("2026-10-25T15:00:00Z"))).reportedSpendTotalCents, null);
  } finally { sql.exec("ROLLBACK"); }
});

test("DM attribution and manual spend retain their campaign without rewriting website history", async () => {
  const dmAd = "120255493267280357";
  const dmCampaign = "120255493267260357";
  const validated = store.validateInquiry(inquiry({ attribution: { campaign_id: dmCampaign, ad_id: dmAd } }));
  assert.equal(validated.source, "captured_url");
  assert.equal(validated.attribution.campaign_id, dmCampaign);
  assert.equal(store.validateInquiry(inquiry({ attribution: { campaign_id: store.CAMPAIGN_ID, ad_id: dmAd } })).source, "unknown");
  assert.throws(() => store.validateInquiry(inquiry({ source: "client_reported", sourceCampaignId: store.CAMPAIGN_ID, sourceAdId: dmAd }), true));
  const manual = store.validateInquiry(inquiry({ source: "client_reported", sourceCampaignId: dmCampaign, sourceAdId: dmAd, attribution: {} }), true);
  assert.equal(manual.attribution.campaign_id, dmCampaign);
  assert.equal(store.DM_PACKAGE_AD_ID, "120255515766120357");
  for (const id of [dmAd, "120255493337370357", store.DM_PACKAGE_AD_ID]) {
    assert.equal(store.validateInquiry(inquiry({ attribution: { campaign_id: dmCampaign, ad_id: id } })).source, "captured_url");
    assert.equal(store.validateInquiry(inquiry({ source: "client_reported", sourceCampaignId: dmCampaign, sourceAdId: id, attribution: {} }), true).attribution.ad_id, id);
    assert.equal(store.validateInquiry(inquiry({ attribution: { campaign_id: store.CAMPAIGN_ID, ad_id: id } })).source, "unknown");
  }
  const before = sql.prepare("SELECT * FROM ad_spend WHERE campaign_id = ? ORDER BY date").all(store.CAMPAIGN_ID);
  const response = await trackerApi.POST(makeRequest("/api/tracker", { action: "saveSpend", payload: { campaignId: dmCampaign, date: "2026-10-26", amountCents: 123, verifiedAt: "2026-10-26T20:00:00.000Z", notes: "Explicit DM daily fixture" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(sql.prepare("SELECT * FROM ad_spend WHERE campaign_id = ? ORDER BY date").all(store.CAMPAIGN_ID), before);
  const read = await (await trackerApi.GET()).json();
  assert.equal(read.settings.budgetCents, 10000);
  assert.equal(read.settings.campaignIds.join(","), `${store.CAMPAIGN_ID},${dmCampaign}`);
  assert.equal(read.settings.adOptions.find(ad => ad.id === store.DM_PACKAGE_AD_ID)?.campaignId, dmCampaign);
  assert.equal(read.settings.adOptions.find(ad => ad.id === store.PACKAGE_AD_ID)?.campaignId, store.CAMPAIGN_ID);
  assert.equal(read.spend.some(row => row.campaignId === dmCampaign && row.amountCents === 123), true);
  assert.equal((await trackerApi.POST(makeRequest("/api/tracker", { action: "saveSpend", payload: { campaignId: "other", date: "2026-10-26", amountCents: 1, verifiedAt: "2026-10-26T20:00:00.000Z" } }))).status, 400);
});

test("a failed DM report preserves both campaigns and a missing row stays incomplete", async () => {
  validGraphFixture();
  insightFixture = { data: [dailyRow("2026-10-25", "1.00"), dailyRow("2026-10-26", "2.00")] };
  dmInsightFixture = { data: [] };
  const partial = await cloud.syncCampaignSpend(new Date("2026-10-30T23:00:00Z"));
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.missingCampaignDates.some(row => row.campaignId === "120255493267260357" && row.date === "2026-10-26"), true);
  const before = sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all();
  const priorFixture = graphFixture;
  graphFixture = async (url, options) => new URL(url).pathname.endsWith("120255493267260357/insights") ? Response.json({ error: { code: 190 } }, { status: 401 }) : priorFixture(url, options);
  assert.equal((await cloud.syncCampaignSpend(new Date("2026-10-31T01:00:00Z"))).code, "token_rejected");
  assert.deepEqual(sql.prepare("SELECT * FROM ad_spend ORDER BY campaign_id,date").all(), before);
});

test("record-view limit fails closed rather than reporting truncated financial totals", async () => {
  const insert = sql.prepare("INSERT INTO inquiries (id,submission_id,reference,created_at,updated_at,name,instagram,event_location,coverage,stage,source,planned_cost_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  sql.exec("BEGIN");
  for (let index = 0; index < 5000; index++) insert.run(`cap-${index}`, `cap-${index}`, `cap-${index}`, "2026-10-25T00:00:00Z", "2026-10-25T00:00:00Z", "Local capacity fixture", "qa_cap", "Miami", "both", "new", "unknown", 0);
  sql.exec("COMMIT");
  const result = await trackerApi.GET();
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.match(body.error, /record-view limit/);
  assert.equal(body.inquiries, undefined);
  const summary = await (await mcpApi.POST(rpcRequest("tools/call", { name: "get_campaign_daily_summary", arguments: {} }))).json();
  assert.equal(summary.result.isError, true);
  assert.equal(summary.result.structuredContent.daily, undefined);
});
