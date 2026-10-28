import { env } from "cloudflare:workers";
import { SQUARE_FIRST_PAYMENT, SQUARE_MERCHANT_ID, SQUARE_OFFERS, SQUARE_REDIRECT_URI, SQUARE_SCOPES, SQUARE_SITE_ORIGIN, SquareSyncError, candidateCode, moneyAmount, moneyIsUsd, offerForKey, offerForParent, referenceFromOrder, squareDay, squareId, squareMessage, squareObject, squareTimestamp, type SquareObject, type SquareOffer } from "@/lib/square-core";
export { SquareSyncError } from "@/lib/square-core";

const ORIGIN = "https://connect.squareup.com";
const VERSION = "2026-09-16";
const KEY = "square_deposits";
const COOKIE = "sbs_square_oauth_state";
const DAY = 86400000;
const LEASE_MS = 10 * 60_000;
const PAGE_SIZE = 20;
const MAX_PAGES_PER_RUN = 4;
const MAX_RECORDS_PER_RUN = 30;
const MAX_SCAN_PAGES = 2000;
type Row = Record<string, string | number | null>;
type TokenBundle = { accessToken: string; refreshToken: string };
function database(): D1Database { if (!env.DB) throw new SquareSyncError(503, "storage_unavailable"); return env.DB; }
function configuration() {
  const vars = env as unknown as { SQUARE_APPLICATION_ID?: string; SQUARE_APPLICATION_SECRET?: string };
  const id = vars.SQUARE_APPLICATION_ID?.trim(); const secret = vars.SQUARE_APPLICATION_SECRET?.trim();
  if (!id || !secret) throw new SquareSyncError(503, "setup_required");
  if (!/^sq0idp-[A-Za-z0-9_-]{5,200}$/.test(id) || secret.length < 20 || secret.length > 4096) throw new SquareSyncError(503, "invalid_app_config");
  return { id, secret };
}
function hex(bytes: ArrayBuffer | Uint8Array) { return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join(""); }
function unhex(value: string) { if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error("invalid ciphertext"); return new Uint8Array(value.match(/../g)!.map(x => parseInt(x, 16))); }
async function digest(value: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function encryptionKey() {
  const config = configuration();
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(`side-by-south:square:${config.id}`), info: new TextEncoder().encode("side-by-south:square-oauth:encrypted-tokens:v1") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function tokenAad(ownerId: string) { return new TextEncoder().encode(`sbs:square:tokens:v1|${configuration().id}|${SQUARE_MERCHANT_ID}|${ownerId}`); }
export async function encryptSquareTokens(value: TokenBundle, ownerId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: tokenAad(ownerId) }, await encryptionKey(), new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: hex(iv), body: hex(body) });
}
export async function decryptSquareTokens(value: string, ownerId: string): Promise<TokenBundle> {
  try {
    const blob = JSON.parse(value);
    if (blob.v !== 1 || typeof blob.iv !== "string" || blob.iv.length !== 24 || typeof blob.body !== "string" || blob.body.length > 40000) throw new Error("invalid ciphertext");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(blob.iv), additionalData: tokenAad(ownerId) }, await encryptionKey(), unhex(blob.body));
    const result = squareObject(JSON.parse(new TextDecoder().decode(plain)));
    if (typeof result.accessToken !== "string" || typeof result.refreshToken !== "string" || !result.accessToken || !result.refreshToken) throw new Error("invalid token");
    return { accessToken: result.accessToken, refreshToken: result.refreshToken };
  } catch { throw new SquareSyncError(503, "reconnect_required"); }
}

// All network destinations and paths are built locally. Credentials are only in
// headers or OAuth POST bodies; redirects are never followed and payloads never logged.
async function squareRequest(path: string, token: string | null, params: Record<string, string> = {}, body?: SquareObject, method: "GET" | "POST" = "GET"): Promise<SquareObject> {
  if (!/^\/(?:v2\/(?:payments|refunds|orders|catalog\/object|locations|merchants)(?:\/[A-Za-z0-9_:-]+)?|oauth2\/token(?:\/status)?)$/.test(path)) throw new SquareSyncError(500, "invalid_input");
  const url = new URL(path, ORIGIN); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const result = await fetch(url.toString(), { method, headers: { Accept: "application/json", "Content-Type": "application/json", "Square-Version": VERSION, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: abort.signal });
    if (result.status >= 300 && result.status < 400) throw new SquareSyncError(502, "provider_error");
    if (result.status === 401 || result.status === 403) throw new SquareSyncError(503, "reconnect_required");
    if (!result.ok) throw new SquareSyncError(502, "provider_error");
    const reader = result.body?.getReader(); if (!reader) throw new SquareSyncError(502, "response_invalid");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1048576) { await reader.cancel(); throw new SquareSyncError(502, "response_invalid"); } chunks.push(part.value); }
    const joined = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    let data: SquareObject;
    try { data = squareObject(JSON.parse(new TextDecoder().decode(joined))); } catch { throw new SquareSyncError(502, "response_invalid"); }
    if (data.errors != null && (!Array.isArray(data.errors) || data.errors.length)) throw new SquareSyncError(502, "provider_error");
    return data;
  } catch (error) { if (error instanceof SquareSyncError) throw error; throw new SquareSyncError(502, "network_error"); }
  finally { clearTimeout(timer); }
}
async function connection() { return database().prepare("SELECT * FROM square_connections WHERE key = ?").bind(KEY).first<Row>(); }
async function ensureState(now: Date) { await database().prepare("INSERT INTO square_sync_state (key, updated_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(KEY, now.toISOString()).run(); }
async function readState() { return database().prepare("SELECT * FROM square_sync_state WHERE key = ?").bind(KEY).first<Row>(); }
async function verifyToken(accessToken: string) {
  const config = configuration();
  const status = await squareRequest("/oauth2/token/status", accessToken, {}, undefined, "POST");
  if (status.merchant_id !== SQUARE_MERCHANT_ID || status.client_id !== config.id) throw new SquareSyncError(403, "merchant_mismatch");
  const scopes = status.scopes;
  if (!Array.isArray(scopes) || scopes.length !== SQUARE_SCOPES.length || SQUARE_SCOPES.some(scope => !scopes.includes(scope)) || scopes.some(scope => typeof scope !== "string" || !(SQUARE_SCOPES as readonly string[]).includes(scope))) throw new SquareSyncError(403, "scopes_mismatch");
  const merchant = squareObject((await squareRequest(`/v2/merchants/${SQUARE_MERCHANT_ID}`, accessToken)).merchant);
  if (merchant.id !== SQUARE_MERCHANT_ID || merchant.currency !== "USD" || merchant.status !== "ACTIVE") throw new SquareSyncError(403, "merchant_mismatch");
  const result = await squareRequest("/v2/locations", accessToken);
  if (!Array.isArray(result.locations)) throw new SquareSyncError(502, "response_invalid");
  const locations = result.locations.map(squareObject).filter(location => location.name === "Photo" && location.status === "ACTIVE" && location.currency === "USD" && location.merchant_id === SQUARE_MERCHANT_ID);
  if (locations.length !== 1) throw new SquareSyncError(403, "location_mismatch");
  return { locationId: squareId(locations[0].id), scopes: scopes as string[] };
}
function tokenResponse(raw: SquareObject, now: Date) {
  if (raw.merchant_id !== SQUARE_MERCHANT_ID || raw.token_type !== "bearer" && raw.token_type !== "Bearer") throw new SquareSyncError(403, "merchant_mismatch");
  if (typeof raw.access_token !== "string" || !raw.access_token || raw.access_token.length > 4096 || typeof raw.refresh_token !== "string" || !raw.refresh_token || raw.refresh_token.length > 4096) throw new SquareSyncError(502, "token_invalid");
  const expiresAt = squareTimestamp(raw.expires_at); if (Date.parse(expiresAt) <= now.getTime()) throw new SquareSyncError(502, "token_invalid");
  return { tokens: { accessToken: raw.access_token, refreshToken: raw.refresh_token }, expiresAt };
}
async function persistConnection(ownerId: string, raw: SquareObject, now: Date) {
  const parsed = tokenResponse(raw, now); const verified = await verifyToken(parsed.tokens.accessToken);
  const cipher = await encryptSquareTokens(parsed.tokens, ownerId);
  await database().prepare("INSERT INTO square_connections (key,owner_id,merchant_id,location_id,encrypted_tokens,expires_at,refreshed_at,scopes_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET owner_id=excluded.owner_id,merchant_id=excluded.merchant_id,location_id=excluded.location_id,encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at,refreshed_at=excluded.refreshed_at,scopes_json=excluded.scopes_json,updated_at=excluded.updated_at").bind(KEY, ownerId, SQUARE_MERCHANT_ID, verified.locationId, cipher, parsed.expiresAt, now.toISOString(), JSON.stringify(verified.scopes), now.toISOString()).run();
  return { accessToken: parsed.tokens.accessToken, locationId: verified.locationId };
}
function stateCookie(request: Request) {
  const match = (request.headers.get("cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`));
  return match?.slice(COOKIE.length + 1) || "";
}
const cookieHeader = (state: string, age: number) => `${COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/square; Max-Age=${age}`;
export async function beginSquareConnect(request: Request, ownerId: string, now = new Date()) {
  if (new URL(request.url).origin !== SQUARE_SITE_ORIGIN) throw new SquareSyncError(403, "invalid_input");
  const config = configuration(); const state = hex(crypto.getRandomValues(new Uint8Array(32)));
  await database().prepare("INSERT INTO square_oauth_states (state_hash,owner_id,created_at,expires_at) VALUES (?,?,?,?)").bind(await digest(state), ownerId, now.toISOString(), new Date(now.getTime() + 10 * 60_000).toISOString()).run();
  const url = new URL("/oauth2/authorize", ORIGIN);
  url.searchParams.set("client_id", config.id); url.searchParams.set("scope", SQUARE_SCOPES.join(" ")); url.searchParams.set("state", state); url.searchParams.set("session", "false"); url.searchParams.set("redirect_uri", SQUARE_REDIRECT_URI);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Set-Cookie": cookieHeader(state, 600), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
export async function completeSquareConnect(request: Request, ownerId: string, now = new Date()) {
  const url = new URL(request.url); const state = url.searchParams.get("state") || "";
  const fail = (code: string) => new Response(null, { status: 302, headers: { Location: `${SQUARE_SITE_ORIGIN}/tracker?square=${code}`, "Set-Cookie": cookieHeader("", 0), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  if (url.origin !== SQUARE_SITE_ORIGIN || !/^[0-9a-f]{64}$/.test(state) || state !== stateCookie(request)) return fail("oauth_state_invalid");
  const result = await database().prepare("UPDATE square_oauth_states SET consumed_at = ? WHERE state_hash = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at > ?").bind(now.toISOString(), await digest(state), ownerId, now.toISOString()).run();
  if (!result.meta.changes) return fail("oauth_state_invalid");
  if (url.searchParams.has("error")) return fail("oauth_denied");
  const code = url.searchParams.get("code"); if (!code || code.length > 4096) return fail("oauth_state_invalid");
  try {
    const config = configuration();
    const raw = await squareRequest("/oauth2/token", null, {}, { client_id: config.id, client_secret: config.secret, code, grant_type: "authorization_code", redirect_uri: SQUARE_REDIRECT_URI }, "POST");
    await persistConnection(ownerId, raw, now); await ensureState(now);
    await database().prepare("UPDATE square_sync_state SET last_status='connected', last_code=NULL, updated_at=? WHERE key=?").bind(now.toISOString(), KEY).run();
    return fail("connected");
  } catch (error) { return fail(error instanceof SquareSyncError ? error.code : "provider_error"); }
}
async function accessForSync(now: Date) {
  const saved = await connection(); if (!saved) throw new SquareSyncError(503, "not_connected");
  if (saved.merchant_id !== SQUARE_MERCHANT_ID) throw new SquareSyncError(403, "merchant_mismatch");
  const tokens = await decryptSquareTokens(String(saved.encrypted_tokens), String(saved.owner_id));
  if (now.getTime() - Date.parse(String(saved.refreshed_at)) >= 6 * DAY || Date.parse(String(saved.expires_at)) - now.getTime() <= 7 * DAY) {
    const config = configuration();
    const raw = await squareRequest("/oauth2/token", null, {}, { client_id: config.id, client_secret: config.secret, refresh_token: tokens.refreshToken, grant_type: "refresh_token", scopes: [...SQUARE_SCOPES] }, "POST");
    return persistConnection(String(saved.owner_id), raw, now);
  }
  return { accessToken: tokens.accessToken, locationId: String(saved.location_id) };
}
function cleanInput(raw: unknown, allowed: string[]) { const input = squareObject(raw); if (Object.keys(input).some(key => !allowed.includes(key))) throw new SquareSyncError(400, "invalid_input"); return input; }
function inputUuid(value: unknown) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new SquareSyncError(400, "invalid_input"); return value.toLowerCase(); }
function quoteText(value: unknown) { if (typeof value !== "string" || !value.trim() || value.trim().length > 160 || /[\x00-\x1f]/.test(value)) throw new SquareSyncError(400, "invalid_input"); return value.trim(); }
async function eligibleInquiry(inquiryId: string, offer: SquareOffer, now: Date, requireEnrollment = true) {
  const inquiry = await database().prepare("SELECT id,reference,coverage,quoted_media_cents,is_test,stage FROM inquiries WHERE id=?").bind(inquiryId).first<Row>();
  if (!inquiry || Number(inquiry.is_test) || ["lost", "cancelled"].includes(String(inquiry.stage))) throw new SquareSyncError(409, "inquiry_unavailable");
  if (Number(inquiry.quoted_media_cents) !== offer.mediaCents || inquiry.coverage !== offer.coverage && inquiry.coverage !== "unsure") throw new SquareSyncError(409, "quote_mismatch");
  if (now.getTime() < Date.parse(offer.availableFrom)) throw new SquareSyncError(409, "offer_not_live");
  if (requireEnrollment) {
    const enrollment = await database().prepare("SELECT * FROM square_quote_enrollments WHERE inquiry_id=?").bind(inquiryId).first<Row>();
    if (!enrollment || !Number(enrollment.enabled) || !Number(enrollment.digital_only) || !String(enrollment.accepted_quote_reference || "")) throw new SquareSyncError(409, "not_enrolled");
    if (enrollment.offer_key !== offer.key) throw new SquareSyncError(409, "offer_mismatch");
  }
  return inquiry;
}
async function acquireLease(now: Date) {
  await ensureState(now); const lease = crypto.randomUUID();
  const result = await database().prepare("UPDATE square_sync_state SET lease_owner=?,lease_expires_at=?,last_attempt_at=?,updated_at=? WHERE key=? AND (lease_owner IS NULL OR lease_expires_at <= ?)").bind(lease, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(), now.toISOString(), KEY, now.toISOString()).run();
  return result.meta.changes ? lease : null;
}
async function releaseLease(lease: string) { await database().prepare("UPDATE square_sync_state SET lease_owner=NULL,lease_expires_at=NULL WHERE key=? AND lease_owner=?").bind(KEY, lease).run(); }
async function catalogParent(token: string, line: SquareObject, cache: Map<string, string | null>) {
  if (!line.catalog_object_id) return null;
  const variationId = squareId(line.catalog_object_id); const version = line.catalog_version;
  if (version != null && (!Number.isSafeInteger(version) || Number(version) < 0)) throw new SquareSyncError(502, "response_invalid");
  const cacheKey = `${variationId}:${version ?? "current"}`; if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  const result = await squareRequest(`/v2/catalog/object/${variationId}`, token, version == null ? {} : { catalog_version: String(version) });
  const item = squareObject(result.object);
  if (item.id !== variationId || item.type !== "ITEM_VARIATION") { cache.set(cacheKey, null); return null; }
  const detail = squareObject(item.item_variation_data); const parent = squareId(detail.item_id); cache.set(cacheKey, parent); return parent;
}
type Candidate = { paymentId: string; orderId: string; updatedAt: string; amountCents: number; currency: string; occurredOn: string; offer: SquareOffer; reference: string | null; code: string | null };
async function paymentCandidate(payment: SquareObject, token: string, locationId: string, now: Date, cache: Map<string, string | null>): Promise<Candidate | null> {
  const paymentId = squareId(payment.id);
  const createdAt = squareTimestamp(payment.created_at); const updatedAt = squareTimestamp(payment.updated_at);
  if (Date.parse(createdAt) < Date.parse(SQUARE_FIRST_PAYMENT) || payment.location_id !== locationId || !payment.order_id) return null;
  const orderId = squareId(payment.order_id); const order = squareObject((await squareRequest(`/v2/orders/${orderId}`, token)).order);
  if (order.id !== orderId || order.location_id !== locationId || !Array.isArray(order.line_items)) throw new SquareSyncError(502, "response_invalid");
  const parents = await Promise.all(order.line_items.map(async raw => { const line = squareObject(raw); return catalogParent(token, line, cache); }));
  const approved = parents.map(offerForParent).filter((offer): offer is SquareOffer => !!offer);
  if (!approved.length) return null;
  const offer = approved[0]; const ref = referenceFromOrder(order);
  let capturedAt = createdAt;
  const details = payment.card_details as SquareObject | undefined; const timeline = details?.card_payment_timeline as SquareObject | undefined;
  if (timeline?.captured_at) capturedAt = squareTimestamp(timeline.captured_at);
  return { paymentId, orderId, updatedAt, amountCents: moneyAmount(payment.amount_money) ?? 0, currency: moneyIsUsd(payment.amount_money) ? "USD" : "OTHER", occurredOn: squareDay(capturedAt), offer, reference: ref.reference, code: candidateCode(payment, order, offer, now) || (approved.length !== 1 ? "order_has_extras" : null) || ref.code };
}
async function saveReview(candidate: Candidate, code: string, now: Date) {
  const old = await database().prepare("SELECT * FROM square_receipts WHERE payment_id=?").bind(candidate.paymentId).first<Row>();
  if (old?.ledger_transaction_id || old?.status === "ignored") return old;
  if (old && Date.parse(String(old.provider_updated_at)) > Date.parse(candidate.updatedAt)) return old;
  await database().prepare("INSERT INTO square_receipts (payment_id,merchant_id,order_id,provider_updated_at,amount_cents,currency,occurred_on,offer_key,reference,status,code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'review',?,?,?) ON CONFLICT(payment_id) DO UPDATE SET provider_updated_at=excluded.provider_updated_at,amount_cents=excluded.amount_cents,currency=excluded.currency,occurred_on=excluded.occurred_on,offer_key=excluded.offer_key,reference=excluded.reference,code=excluded.code,updated_at=excluded.updated_at WHERE square_receipts.ledger_transaction_id IS NULL AND square_receipts.status <> 'ignored' AND square_receipts.provider_updated_at <= excluded.provider_updated_at").bind(candidate.paymentId, SQUARE_MERCHANT_ID, candidate.orderId, candidate.updatedAt, candidate.amountCents, candidate.currency, candidate.occurredOn, candidate.offer.key, candidate.reference, code, now.toISOString(), now.toISOString()).run();
  return database().prepare("SELECT * FROM square_receipts WHERE payment_id=?").bind(candidate.paymentId).first<Row>();
}
async function importCandidate(candidate: Candidate, inquiryId: string, now: Date) {
  const old = await database().prepare("SELECT * FROM square_receipts WHERE payment_id=?").bind(candidate.paymentId).first<Row>();
  if (old?.ledger_transaction_id || old?.status === "ignored") return false;
  await eligibleInquiry(inquiryId, candidate.offer, now);
  const existing = await database().prepare("SELECT id FROM ledger_transactions WHERE inquiry_id=? AND type='media_deposit' AND voided_at IS NULL LIMIT 1").bind(inquiryId).first<Row>();
  if (existing) throw new SquareSyncError(409, "manual_payment_conflict");
  await saveReview(candidate, "reference_missing", now);
  const txId = crypto.randomUUID(); const nowIso = now.toISOString(); const key = `square:${SQUARE_MERCHANT_ID}:${candidate.paymentId}`;
  const statements = [
    database().prepare("INSERT INTO ledger_transactions (id,inquiry_id,occurred_on,type,amount_cents,method,reference_note,reference_key,created_at) SELECT ?,?,?,'media_deposit',?,'square',?,?,? WHERE EXISTS (SELECT 1 FROM square_receipts WHERE payment_id=? AND ledger_transaction_id IS NULL AND status='review') AND NOT EXISTS (SELECT 1 FROM ledger_transactions WHERE inquiry_id=? AND type='media_deposit' AND voided_at IS NULL) AND EXISTS (SELECT 1 FROM square_quote_enrollments e JOIN inquiries i ON i.id=e.inquiry_id WHERE e.inquiry_id=? AND e.enabled=1 AND e.digital_only=1 AND e.offer_key=? AND e.accepted_quote_reference<>'' AND i.is_test=0 AND i.stage NOT IN ('lost','cancelled') AND i.quoted_media_cents=? AND (i.coverage=? OR i.coverage='unsure'))").bind(txId, inquiryId, candidate.occurredOn, candidate.amountCents, `Square ${candidate.paymentId}`, key, nowIso, candidate.paymentId, inquiryId, inquiryId, candidate.offer.key, candidate.offer.mediaCents, candidate.offer.coverage),
    database().prepare("UPDATE square_receipts SET status='imported',code='imported',inquiry_id=?,ledger_transaction_id=?,updated_at=? WHERE payment_id=? AND ledger_transaction_id IS NULL AND EXISTS (SELECT 1 FROM ledger_transactions WHERE id=? AND reference_key=?)").bind(inquiryId, txId, nowIso, candidate.paymentId, txId, key),
  ];
  await database().batch(statements);
  const saved = await database().prepare("SELECT inquiry_id,ledger_transaction_id FROM square_receipts WHERE payment_id=?").bind(candidate.paymentId).first<Row>();
  if (!saved?.ledger_transaction_id) { await eligibleInquiry(inquiryId, candidate.offer, now); throw new SquareSyncError(409, "manual_payment_conflict"); }
  return saved.ledger_transaction_id === txId;
}
// Read every refund named by the authoritative payment before recognizing a
// newly matched deposit. This also covers refunds older than the scan watermark
// when an owner maps an initially unmatched receipt days later.
async function refundsForPayment(payment: SquareObject, token: string, locationId: string) {
  const ids = payment.refund_ids ?? [];
  if (!Array.isArray(ids)) throw new SquareSyncError(502, "response_invalid");
  if (ids.length > 20) throw new SquareSyncError(503, "scan_limit");
  const unique = new Set(ids.map(squareId));
  if (unique.size !== ids.length) throw new SquareSyncError(502, "response_invalid");
  const expected = payment.refunded_money == null ? 0 : moneyIsUsd(payment.refunded_money) ? moneyAmount(payment.refunded_money) : null;
  if (expected == null) throw new SquareSyncError(502, "refund_mismatch");
  const refunds: SquareObject[] = [];
  let completed = 0;
  for (const id of unique) {
    const refund = squareObject((await squareRequest(`/v2/refunds/${id}`, token)).refund);
    if (refund.id !== id || refund.payment_id !== payment.id || refund.location_id !== locationId) throw new SquareSyncError(502, "response_invalid");
    if (refund.status === "COMPLETED") {
      const amount = moneyAmount(refund.amount_money);
      if (!moneyIsUsd(refund.amount_money) || amount == null || amount <= 0) throw new SquareSyncError(502, "refund_mismatch");
      completed += amount;
    }
    refunds.push(refund);
  }
  if (completed !== expected || completed > (moneyAmount(payment.amount_money) ?? 0)) throw new SquareSyncError(502, "refund_mismatch");
  return refunds;
}
async function reconcilePaymentRefunds(payment: SquareObject, token: string, locationId: string, now: Date) {
  const refunds = await refundsForPayment(payment, token, locationId);
  let imported = 0;
  for (const refund of refunds) if (await processRefund(refund, now)) imported++;
  return imported;
}
async function processPayment(payment: SquareObject, token: string, locationId: string, now: Date, cache: Map<string, string | null>) {
  const candidate = await paymentCandidate(payment, token, locationId, now, cache); if (!candidate) return { imported: false, refunds: 0 };
  const old = await database().prepare("SELECT ledger_transaction_id,status FROM square_receipts WHERE payment_id=?").bind(candidate.paymentId).first<Row>();
  if (old?.status === "ignored") return { imported: false, refunds: 0 };
  if (old?.ledger_transaction_id) return { imported: false, refunds: await reconcilePaymentRefunds(payment, token, locationId, now) };
  if (candidate.code) { await saveReview(candidate, candidate.code, now); return { imported: false, refunds: 0 }; }
  const inquiry = await database().prepare("SELECT id FROM inquiries WHERE reference=?").bind(candidate.reference).first<Row>();
  if (!inquiry) { await saveReview(candidate, "reference_unknown", now); return { imported: false, refunds: 0 }; }
  try {
    await eligibleInquiry(String(inquiry.id), candidate.offer, now);
    const refunds = await refundsForPayment(payment, token, locationId);
    await saveReview(candidate, "reference_missing", now);
    // Persist refund identities before the deposit import. A storage failure
    // afterwards is recoverable by both the frozen page and pending-refund scan.
    for (const refund of refunds) await processRefund(refund, now);
    const imported = await importCandidate(candidate, String(inquiry.id), now);
    let importedRefunds = 0;
    for (const refund of refunds) if (await processRefund(refund, now)) importedRefunds++;
    return { imported, refunds: importedRefunds };
  } catch (error) { if (error instanceof SquareSyncError && error.status === 409) { await saveReview(candidate, error.code, now); return { imported: false, refunds: 0 }; } throw error; }
}
async function processRefund(raw: SquareObject, now: Date) {
  const refundId = squareId(raw.id); if (!raw.payment_id) return false;
  const paymentId = squareId(raw.payment_id); const receipt = await database().prepare("SELECT * FROM square_receipts WHERE payment_id=?").bind(paymentId).first<Row>();
  if (!receipt) return false;
  const old = await database().prepare("SELECT * FROM square_refunds WHERE refund_id=?").bind(refundId).first<Row>();
  if (old?.ledger_transaction_id) return false;
  if (old && old.payment_id !== paymentId) throw new SquareSyncError(502, "response_invalid");
  const updated = squareTimestamp(raw.updated_at); if (old && Date.parse(String(old.provider_updated_at)) > Date.parse(updated)) return false;
  const occurredOn = squareDay(squareTimestamp(raw.created_at)); const amount = moneyAmount(raw.amount_money) ?? 0;
  let code = raw.status !== "COMPLETED" ? "refund_not_completed" : !receipt.ledger_transaction_id ? "refund_payment_pending" : !moneyIsUsd(raw.amount_money) || amount <= 0 ? "refund_mismatch" : "refund_imported";
  const prior = await database().prepare("SELECT COALESCE(SUM(amount_cents),0) AS amount FROM square_refunds WHERE payment_id=? AND ledger_transaction_id IS NOT NULL AND refund_id<>?").bind(paymentId, refundId).first<Row>();
  if (amount + Number(prior?.amount || 0) > Number(receipt.amount_cents)) code = "refund_mismatch";
  if (receipt.inquiry_id && code === "refund_imported") {
    const manualRefund = await database().prepare("SELECT l.id FROM ledger_transactions l WHERE l.inquiry_id=? AND l.type='media_refund' AND l.voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM square_refunds r WHERE r.ledger_transaction_id=l.id) LIMIT 1").bind(receipt.inquiry_id).first<Row>();
    if (manualRefund) code = "manual_refund_conflict";
  }
  await database().prepare("INSERT INTO square_refunds (refund_id,payment_id,provider_updated_at,amount_cents,occurred_on,status,code,created_at,updated_at) VALUES (?,?,?,?,?,'review',?,?,?) ON CONFLICT(refund_id) DO UPDATE SET provider_updated_at=excluded.provider_updated_at,amount_cents=excluded.amount_cents,occurred_on=excluded.occurred_on,code=excluded.code,updated_at=excluded.updated_at WHERE square_refunds.ledger_transaction_id IS NULL AND square_refunds.provider_updated_at <= excluded.provider_updated_at").bind(refundId, paymentId, updated, amount, occurredOn, code, now.toISOString(), now.toISOString()).run();
  if (code !== "refund_imported") return false;
  const deposit = await database().prepare("SELECT voided_at FROM ledger_transactions WHERE id=?").bind(receipt.ledger_transaction_id).first<Row>();
  if (!deposit || deposit.voided_at) { await database().prepare("UPDATE square_refunds SET code='refund_mismatch' WHERE refund_id=? AND ledger_transaction_id IS NULL").bind(refundId).run(); return false; }
  const txId = crypto.randomUUID(); const refKey = `square-refund:${SQUARE_MERCHANT_ID}:${refundId}`;
  await database().batch([
    database().prepare("INSERT INTO ledger_transactions (id,inquiry_id,occurred_on,type,amount_cents,method,reference_note,reference_key,created_at) SELECT ?,?,?,'media_refund',?,'square',?,?,? WHERE EXISTS (SELECT 1 FROM square_refunds WHERE refund_id=? AND ledger_transaction_id IS NULL) AND NOT EXISTS (SELECT 1 FROM ledger_transactions l WHERE l.inquiry_id=? AND l.type='media_refund' AND l.voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM square_refunds r WHERE r.ledger_transaction_id=l.id)) AND (? + COALESCE((SELECT SUM(amount_cents) FROM square_refunds WHERE payment_id=? AND ledger_transaction_id IS NOT NULL),0)) <= ?").bind(txId, receipt.inquiry_id, occurredOn, amount, `Square refund ${refundId}`, refKey, now.toISOString(), refundId, receipt.inquiry_id, amount, paymentId, receipt.amount_cents),
    database().prepare("UPDATE square_refunds SET status='imported',code='refund_imported',ledger_transaction_id=?,updated_at=? WHERE refund_id=? AND ledger_transaction_id IS NULL AND EXISTS (SELECT 1 FROM ledger_transactions WHERE id=? AND reference_key=?)").bind(txId, now.toISOString(), refundId, txId, refKey),
  ]);
  return !!(await database().prepare("SELECT ledger_transaction_id FROM square_refunds WHERE refund_id=?").bind(refundId).first<Row>())?.ledger_transaction_id;
}
async function scanPage(phase: string, token: string, locationId: string, begin: string, upper: string, cursor: string | null) {
  // Pending refund identities are reconciled independently of updated_at. An
  // owner can match the corresponding deposit after the provider scan advanced.
  if (phase === "pending_refunds") {
    const result = await database().prepare("SELECT r.refund_id FROM square_refunds r JOIN square_receipts p ON p.payment_id=r.payment_id WHERE r.ledger_transaction_id IS NULL AND p.ledger_transaction_id IS NOT NULL AND r.refund_id > ? ORDER BY r.refund_id LIMIT ?").bind(cursor || "", PAGE_SIZE + 1).all<Row>();
    const rows = result.results.slice(0, PAGE_SIZE);
    return { ids: rows.map(row => squareId(row.refund_id)), cursor: result.results.length > PAGE_SIZE ? squareId(rows[rows.length - 1].refund_id) : null };
  }
  const params: Record<string, string> = { begin_time: SQUARE_FIRST_PAYMENT, updated_at_begin_time: begin, updated_at_end_time: upper, sort_field: "UPDATED_AT", sort_order: "ASC", location_id: locationId, limit: String(PAGE_SIZE) };
  if (cursor) params.cursor = cursor;
  const value = await squareRequest(phase === "payments" ? "/v2/payments" : "/v2/refunds", token, params);
  const raw = value[phase === "payments" ? "payments" : "refunds"] ?? [];
  if (!Array.isArray(raw) || raw.length > PAGE_SIZE) throw new SquareSyncError(502, "response_invalid");
  const next = value.cursor == null || value.cursor === "" ? null : typeof value.cursor === "string" && value.cursor.length <= 4096 ? value.cursor : undefined;
  if (next === undefined || next && next === cursor) throw new SquareSyncError(502, "response_invalid");
  const ids = raw.map(row => squareId(squareObject(row).id));
  if (new Set(ids).size !== ids.length) throw new SquareSyncError(502, "response_invalid");
  return { ids, cursor: next };
}
function savedPageIds(raw: Row["page_ids_json"]): string[] | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed) || parsed.length > PAGE_SIZE) throw new Error("invalid page");
    const ids = parsed.map(squareId);
    if (new Set(ids).size !== ids.length) throw new Error("invalid page");
    return ids;
  } catch { throw new SquareSyncError(502, "response_invalid"); }
}
export async function syncSquareDeposits(now = new Date()) {
  let lease: string | null = null; let imported = 0; let refunds = 0;
  try {
    configuration(); lease = await acquireLease(now); if (!lease) return { status: "busy", code: "busy", message: squareMessage("busy") };
    const access = await accessForSync(now); const saved = (await readState())!;
    let phase = String(saved.scan_phase || "payments");
    const upper = saved.scan_upper ? String(saved.scan_upper) : now.toISOString();
    const begin = saved.scan_begin ? String(saved.scan_begin) : new Date(Math.max(Date.parse(SQUARE_FIRST_PAYMENT), saved.watermark ? Date.parse(String(saved.watermark)) - DAY : Date.parse(SQUARE_FIRST_PAYMENT))).toISOString();
    let cursor = saved.cursor == null ? null : String(saved.cursor);
    let ids = savedPageIds(saved.page_ids_json);
    let nextCursor = saved.page_next_cursor == null ? null : String(saved.page_next_cursor);
    // Offset is meaningful only against the immutable identity snapshot. A
    // legacy/incomplete state without that snapshot replays its page safely.
    let offset = ids == null ? 0 : Number(saved.page_offset || 0);
    let totalPages = Number(saved.scan_pages || 0);
    const persist = async () => { await database().prepare("UPDATE square_sync_state SET scan_begin=?,scan_upper=?,scan_phase=?,cursor=?,page_ids_json=?,page_next_cursor=?,page_offset=?,scan_pages=?,last_status='in_progress',last_code='in_progress',coverage_gap=1,lease_expires_at=?,updated_at=? WHERE key=? AND lease_owner=?").bind(begin, upper, phase, cursor, ids == null ? null : JSON.stringify(ids), nextCursor, offset, totalPages, new Date(Date.now() + LEASE_MS).toISOString(), new Date().toISOString(), KEY, lease).run(); };
    await persist(); let processed = 0; const deadline = Date.now() + 40_000; const cache = new Map<string, string | null>();
    for (let pages = 0; pages < MAX_PAGES_PER_RUN; pages++) {
      if (!["payments", "refunds", "pending_refunds"].includes(phase) || totalPages >= MAX_SCAN_PAGES) throw new SquareSyncError(503, "scan_limit");
      if (ids == null) {
        const page = await scanPage(phase, access.accessToken, access.locationId, begin, upper, cursor);
        ids = page.ids; nextCursor = page.cursor; offset = 0;
        // Freeze identities AND next cursor before any record is processed.
        // A changed provider page after a crash cannot shift the saved offset.
        await persist();
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > ids.length) throw new SquareSyncError(502, "response_invalid");
      for (; offset < ids.length; offset++) {
        if (processed >= MAX_RECORDS_PER_RUN || Date.now() >= deadline) { await persist(); return { status: "continuing", code: "in_progress", message: squareMessage("in_progress"), imported, refunds }; }
        const id = ids[offset];
        const raw = await squareRequest(`${phase === "payments" ? "/v2/payments" : "/v2/refunds"}/${id}`, access.accessToken);
        const row = squareObject(raw[phase === "payments" ? "payment" : "refund"]);
        if (row.id !== id || row.location_id !== access.locationId) throw new SquareSyncError(502, "response_invalid");
        if (phase === "payments") {
          const changed = await processPayment(row, access.accessToken, access.locationId, now, cache);
          if (changed.imported) imported++;
          refunds += changed.refunds;
        } else if (await processRefund(row, now)) refunds++;
        processed++;
        // Commit an offset only after the record has been durably processed.
        await database().prepare("UPDATE square_sync_state SET page_offset=?,lease_expires_at=?,updated_at=? WHERE key=? AND lease_owner=?").bind(offset + 1, new Date(Date.now() + LEASE_MS).toISOString(), new Date().toISOString(), KEY, lease).run();
      }
      offset = 0; totalPages++; ids = null; cursor = nextCursor; nextCursor = null;
      if (cursor) { await persist(); continue; }
      if (phase === "payments") { phase = "refunds"; await persist(); continue; }
      if (phase === "refunds") { phase = "pending_refunds"; await persist(); continue; }
      await database().prepare("UPDATE square_sync_state SET watermark=?,scan_begin=NULL,scan_upper=NULL,scan_phase=NULL,cursor=NULL,page_ids_json=NULL,page_next_cursor=NULL,page_offset=0,scan_pages=0,last_status='synced',last_code='synced',last_success_at=?,coverage_gap=0,updated_at=? WHERE key=? AND lease_owner=?").bind(upper, now.toISOString(), now.toISOString(), KEY, lease).run();
      return { status: "synced", code: "synced", message: squareMessage("synced"), imported, refunds, through: upper, reservationConfirmations: "manual", decorationPayments: "held" };
    }
    await persist(); return { status: "continuing", code: "in_progress", message: squareMessage("in_progress"), imported, refunds };
  } catch (error) {
    const code = error instanceof SquareSyncError ? error.code : "provider_error";
    if (lease) await database().prepare("UPDATE square_sync_state SET last_status='error',last_code=?,coverage_gap=1,updated_at=? WHERE key=? AND lease_owner=?").bind(code, now.toISOString(), KEY, lease).run();
    return { status: ["setup_required", "not_connected"].includes(code) ? "setup_required" : "error", code, message: squareMessage(code), imported, refunds };
  } finally { if (lease) await releaseLease(lease); }
}

export async function getSquareStatus() {
  let configured = true; let configCode: string | null = null;
  try { configuration(); } catch (error) { configured = false; configCode = error instanceof SquareSyncError ? error.code : "setup_required"; }
  const [saved, state, counts] = await Promise.all([connection(), readState(), database().prepare("SELECT (SELECT COUNT(*) FROM square_receipts WHERE status='review') + (SELECT COUNT(*) FROM square_refunds WHERE status='review') AS pending").first<Row>()]);
  const code = configCode || (state?.last_status === "error" ? String(state.last_code || "provider_error") : saved ? String(state?.last_code || state?.last_status || "connected") : "not_connected");
  return { connection: !configured ? "setup_required" : !saved ? "not_connected" : state?.last_code === "reconnect_required" ? "error" : "connected", code, message: squareMessage(code), lastAttemptAt: state?.last_attempt_at || null, lastSuccessAt: state?.last_success_at || null, lastStatus: state?.last_status || "not_connected", coverageGap: !!state?.coverage_gap, pendingReviewCount: Number(counts?.pending || 0), through: state?.watermark || null, reservationConfirmations: "manual", decorationPayments: "held" };
}
export async function getSquareTrackerState() {
  const [status, enrollments, receipts, refunds] = await Promise.all([
    getSquareStatus(),
    database().prepare("SELECT inquiry_id,offer_key,accepted_quote_reference,enabled FROM square_quote_enrollments ORDER BY updated_at DESC LIMIT 5001").all<Row>(),
    database().prepare("SELECT r.*,l.voided_at FROM square_receipts r LEFT JOIN ledger_transactions l ON l.id=r.ledger_transaction_id ORDER BY r.updated_at DESC LIMIT 201").all<Row>(),
    database().prepare("SELECT refund_id,payment_id,status,code,amount_cents,occurred_on FROM square_refunds ORDER BY updated_at DESC LIMIT 201").all<Row>(),
  ]);
  if (enrollments.results.length > 5000 || receipts.results.length > 200 || refunds.results.length > 200) throw new SquareSyncError(503, "scan_limit");
  return { status, offers: SQUARE_OFFERS.map(({ key, label, coverage, mediaCents, depositCents, availableFrom }) => ({ key, label, coverage, mediaCents, depositCents, availableFrom })), enrollments: enrollments.results.map(row => ({ inquiryId: String(row.inquiry_id), offerKey: String(row.offer_key), acceptedQuoteReference: String(row.accepted_quote_reference), enabled: !!row.enabled })), receipts: receipts.results.map(row => ({ paymentId: String(row.payment_id), status: String(row.status), code: row.voided_at ? "record_voided" : String(row.code), message: squareMessage(row.voided_at ? "record_voided" : String(row.code)), amountCents: Number(row.amount_cents), occurredOn: String(row.occurred_on), offerKey: row.offer_key, reference: row.reference, inquiryId: row.inquiry_id, ledgerTransactionId: row.ledger_transaction_id })), refunds: refunds.results.map(row => ({ refundId: String(row.refund_id), paymentId: String(row.payment_id), status: String(row.status), code: String(row.code), message: squareMessage(String(row.code)), amountCents: Number(row.amount_cents), occurredOn: String(row.occurred_on) })) };
}
export async function squareTrackerAction(raw: unknown, actorId: string, now = new Date()) {
  const request = cleanInput(raw, ["action", "payload"]); const payload = request.payload ?? {};
  if (request.action === "sync") { cleanInput(payload, []); return syncSquareDeposits(now); }
  if (request.action === "enrollQuote") {
    const input = cleanInput(payload, ["inquiryId", "offerKey", "acceptedQuoteReference", "digitalOnly"]); const inquiryId = inputUuid(input.inquiryId); const offer = offerForKey(input.offerKey);
    if (!offer || input.digitalOnly !== true) throw new SquareSyncError(400, "digital_only_required");
    await eligibleInquiry(inquiryId, offer, now, false); const quote = quoteText(input.acceptedQuoteReference);
    await database().prepare("INSERT INTO square_quote_enrollments (inquiry_id,offer_key,accepted_quote_reference,digital_only,enabled,actor_id,created_at,updated_at) VALUES (?,?,?,1,1,?,?,?) ON CONFLICT(inquiry_id) DO UPDATE SET offer_key=excluded.offer_key,accepted_quote_reference=excluded.accepted_quote_reference,digital_only=1,enabled=1,actor_id=excluded.actor_id,updated_at=excluded.updated_at").bind(inquiryId, offer.key, quote, actorId, now.toISOString(), now.toISOString()).run();
    return { ok: true };
  }
  if (request.action === "disableQuote") {
    const input = cleanInput(payload, ["inquiryId"]); await database().prepare("UPDATE square_quote_enrollments SET enabled=0,actor_id=?,updated_at=? WHERE inquiry_id=?").bind(actorId, now.toISOString(), inputUuid(input.inquiryId)).run(); return { ok: true };
  }
  if (request.action === "ignoreReceipt") {
    const input = cleanInput(payload, ["paymentId"]); const paymentId = squareId(input.paymentId);
    const result = await database().prepare("UPDATE square_receipts SET status='ignored',code='ignored',updated_at=? WHERE payment_id=? AND ledger_transaction_id IS NULL").bind(now.toISOString(), paymentId).run();
    if (!result.meta.changes) throw new SquareSyncError(409, "unknown_receipt"); return { ok: true };
  }
  if (request.action === "mapReceipt") {
    const input = cleanInput(payload, ["paymentId", "inquiryId"]); const paymentId = squareId(input.paymentId); const inquiryId = inputUuid(input.inquiryId);
    const saved = await database().prepare("SELECT * FROM square_receipts WHERE payment_id=?").bind(paymentId).first<Row>(); if (!saved || saved.ledger_transaction_id) throw new SquareSyncError(409, "unknown_receipt");
    const lease = await acquireLease(now); if (!lease) throw new SquareSyncError(409, "busy");
    try {
      const access = await accessForSync(now); const payment = squareObject((await squareRequest(`/v2/payments/${paymentId}`, access.accessToken)).payment);
      const candidate = await paymentCandidate(payment, access.accessToken, access.locationId, now, new Map());
      if (!candidate || candidate.code && !["reference_missing", "reference_ambiguous", "reference_unknown"].includes(candidate.code)) throw new SquareSyncError(409, "receipt_mismatch");
      await eligibleInquiry(inquiryId, candidate.offer, now);
      // This is an explicit owner mapping, never a fuzzy client-name match.
      await database().prepare("UPDATE square_receipts SET status='review' WHERE payment_id=? AND ledger_transaction_id IS NULL").bind(paymentId).run();
      const refunds = await refundsForPayment(payment, access.accessToken, access.locationId);
      for (const refund of refunds) await processRefund(refund, now);
      await importCandidate(candidate, inquiryId, now);
      for (const refund of refunds) await processRefund(refund, now);
      return { ok: true };
    } finally { await releaseLease(lease); }
  }
  throw new SquareSyncError(400, "invalid_input");
}
