import { env } from "cloudflare:workers";
import { getCloudTrackingStatus } from "@/lib/cloud-tracking";

export const CAMPAIGN_ID = "120255494608980357";
export const VIDEO_AD_ID = "120255494608960357";
export const PHOTO_AD_ID = "120255494734630357";
export const PACKAGE_AD_ID = "120255499730570357";
export const BASE_SETTINGS = {
  campaignId: CAMPAIGN_ID,
  adSetId: "120255494608970357",
  videoAdId: VIDEO_AD_ID,
  photoAdId: PHOTO_AD_ID,
  packageAdId: PACKAGE_AD_ID,
  budgetCents: 35000,
  start: "2026-10-25T08:10:00-04:00",
  end: "2026-11-01T07:10:00-05:00",
  timezone: "America/New_York",
  monthlySoftwareCents: 10000,
  softwareBusinessUseShare: null as number | null,
  plannedCostCents: 5000,
};
const COVERAGE = ["photo", "film", "both", "unsure"];
const STAGES = ["new", "qualified", "quoted", "booked", "completed", "lost", "cancelled"];
const SOURCES = ["captured_url", "client_reported", "unknown"];
const TYPES = ["media_deposit", "media_balance", "media_refund", "direct_expense", "decoration_receipt", "partner_payout", "software_expense"];
const METHODS = ["zelle", "venmo", "cash", "bank_transfer", "other"];
const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "campaign_id", "adset_id", "ad_id"];
const KNOWN_ADS = new Set([VIDEO_AD_ID, PHOTO_AD_ID, PACKAGE_AD_ID]);
type JsonObject = Record<string, unknown>;
type Row = Record<string, string | number | null>;

export class TrackerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "TrackerError";
  }
}

function db(): D1Database {
  if (!env.DB) throw new TrackerError(503, "The tracker is temporarily unavailable. Please try again.");
  return env.DB;
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TrackerError(400, "Please provide a valid request.");
  return value as JsonObject;
}
function onlyKeys(value: JsonObject, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TrackerError(400, "The request includes an unsupported field.");
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (value == null && !required) return "";
  if (typeof value !== "string") throw new TrackerError(400, `${label} must be text.`);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cleaned)) throw new TrackerError(400, `Please check ${label.toLowerCase()}.`);
  return cleaned;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TrackerError(400, `${label} must be true or false.`);
  return value;
}
function choice(value: unknown, allowed: string[], label: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new TrackerError(400, `Please check ${label.toLowerCase()}.`);
  return value;
}
function cents(value: unknown, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) > 100000000) throw new TrackerError(400, `${label} must be a valid amount in whole cents.`);
  return value as number;
}
function uuid(value: unknown, label = "Submission ID"): string {
  const result = text(value, label, 36, true);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new TrackerError(400, `${label} is invalid.`);
  return result.toLowerCase();
}
export function date(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value == null || value === "")) return null;
  const result = text(value, label, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new TrackerError(400, `Please check ${label.toLowerCase()}.`);
  const parsed = new Date(`${result}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new TrackerError(400, `Please check ${label.toLowerCase()}.`);
  return result;
}
function attribution(value: unknown): Record<string, string> {
  if (value == null) return {};
  const input = object(value);
  onlyKeys(input, ATTRIBUTION_KEYS);
  const result: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    if (input[key] != null && input[key] !== "") result[key] = text(input[key], "Attribution", key.endsWith("_id") ? 40 : 160);
  }
  return result;
}
function adId(value: unknown): string | null {
  if (value == null || value === "") return null;
  const result = text(value, "Ad ID", 40, true);
  if (!KNOWN_ADS.has(result)) throw new TrackerError(400, "Choose one of this campaign's ads.");
  return result;
}
function capturedSource(attrs: Record<string, string>): boolean {
  return attrs.campaign_id === CAMPAIGN_ID && KNOWN_ADS.has(attrs.ad_id);
}

export async function readJsonRequest(request: Request, maximumBytes = 16384): Promise<JsonObject> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new TrackerError(403, "This request must come from this website.");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new TrackerError(415, "Use a JSON request.");
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(declaredLength) || declaredLength > maximumBytes) throw new TrackerError(413, "This request is too large.");
  if (!request.body) throw new TrackerError(400, "Please provide a request.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maximumBytes) { await reader.cancel(); throw new TrackerError(413, "This request is too large."); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return object(JSON.parse(new TextDecoder().decode(bytes))); }
  catch (error) { if (error instanceof TrackerError) throw error; throw new TrackerError(400, "Please provide valid JSON."); }
}

export function validateInquiry(raw: unknown, manual = false) {
  const input = object(raw);
  onlyKeys(input, ["id", "submissionId", "name", "instagram", "eventDate", "flexibleDate", "eventLocation", "coverage", "notes", "attribution", "consent", "company", "source", "sourceAdId", "isTest", "alertTest"]);
  const isTest = input.isTest == null ? false : bool(input.isTest, "Test inquiry");
  const alertTest = input.alertTest == null ? false : bool(input.alertTest, "Alert test");
  if ("alertTest" in input && (!isTest || typeof input.alertTest !== "boolean")) throw new TrackerError(400, "Alert tests require a test inquiry and a true or false alert choice.");
  if (!manual && input.consent !== true) throw new TrackerError(400, "Please agree to being contacted about this inquiry.");
  if (text(input.company, "Company", 200)) throw new TrackerError(400, "Please try again.");
  const name = text(input.name, "Name", 100, true);
  const instagram = text(input.instagram, "Instagram handle", 31, true).replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(instagram)) throw new TrackerError(400, "Please enter a valid Instagram handle.");
  const eventDate = date(input.eventDate, "Event date", true);
  const flexibleDate = input.flexibleDate == null ? false : bool(input.flexibleDate, "Flexible date");
  if (!eventDate && !flexibleDate) throw new TrackerError(400, "Choose an event date or mark your date as flexible.");
  const attrs = attribution(input.attribution);
  let source = capturedSource(attrs) ? "captured_url" : "unknown";
  let sourceAdId = source === "captured_url" ? attrs.ad_id : null;
  if (manual) {
    source = input.source == null ? "unknown" : choice(input.source, ["client_reported", "unknown"], "Source");
    sourceAdId = adId(input.sourceAdId ?? attrs.ad_id);
    if (source === "client_reported") { attrs.campaign_id = CAMPAIGN_ID; if (sourceAdId) attrs.ad_id = sourceAdId; }
    else sourceAdId = null;
  } else if (input.source != null || input.sourceAdId != null || input.id != null) {
    throw new TrackerError(400, "Please provide the public inquiry fields only.");
  }
  return {
    submissionId: input.submissionId == null && manual ? (input.id ? uuid(input.id) : crypto.randomUUID()) : uuid(input.submissionId),
    name, instagram, eventDate, flexibleDate,
    eventLocation: text(input.eventLocation, "Event location", 160, true),
    coverage: choice(input.coverage, COVERAGE, "Coverage"),
    notes: text(input.notes, "Notes", 2000),
    attribution: attrs, source, sourceAdId,
    isTest, alertTest,
  };
}

function mapInquiry(row: Row) {
  let attrs: Record<string, string> = {};
  try { attrs = JSON.parse(String(row.attribution_json || "{}")); } catch { /* Invalid legacy metadata must not expose raw data. */ }
  return { id: String(row.id), reference: String(row.reference), createdAt: String(row.created_at), updatedAt: String(row.updated_at), name: String(row.name), instagram: String(row.instagram), eventDate: row.event_date, flexibleDate: !!row.flexible_date, eventLocation: String(row.event_location), coverage: String(row.coverage), notes: String(row.notes || ""), stage: String(row.stage), quotedMediaCents: row.quoted_media_cents, bookingDate: row.booking_date, completedDate: row.completed_date, source: String(row.source), sourceAdId: row.source_ad_id, attribution: attrs, plannedCostCents: Number(row.planned_cost_cents), actualCostsConfirmed: !!row.actual_costs_confirmed, decorationSettled: !!row.decoration_settled, isTest: !!row.is_test };
}
export async function readSettings() {
  const row = await db().prepare("SELECT value_json FROM tracker_settings WHERE key = ?").bind("business").first<{ value_json: string }>();
  let saved: JsonObject = {};
  if (row) { try { saved = JSON.parse(row.value_json); } catch { /* Fall back to documented configuration. */ } }
  return { ...BASE_SETTINGS, monthlySoftwareCents: typeof saved.monthlySoftwareCents === "number" ? saved.monthlySoftwareCents : BASE_SETTINGS.monthlySoftwareCents, plannedCostCents: typeof saved.plannedCostCents === "number" ? saved.plannedCostCents : BASE_SETTINGS.plannedCostCents, softwareBusinessUseShare: typeof saved.softwareBusinessUseShare === "number" ? saved.softwareBusinessUseShare : null };
}
export async function createInquiry(raw: unknown, manual = false) {
  const value = validateInquiry(raw, manual);
  const existing = await db().prepare("SELECT id, reference FROM inquiries WHERE submission_id = ?").bind(value.submissionId).first<{id:string;reference:string}>();
  if (existing) {
    if (value.alertTest) await enqueueExplicitTestAlert(existing.id, value.submissionId);
    return existing;
  }
  const id = crypto.randomUUID();
  const reference = `SBS-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const settings = await readSettings();
  const query = `INSERT INTO inquiries (id, submission_id, reference, created_at, updated_at, name, instagram, event_date, flexible_date, event_location, coverage, notes, stage, source, source_ad_id, attribution_json, planned_cost_cents, is_test)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?
    WHERE ? = 1 OR ((SELECT COUNT(*) FROM inquiries WHERE created_at >= ? AND is_test = 0) < 120 AND (SELECT COUNT(*) FROM inquiries WHERE instagram = ? AND created_at >= ? AND is_test = 0) < 3)
    ON CONFLICT(submission_id) DO NOTHING`;
  const result = await db().prepare(query).bind(id, value.submissionId, reference, now, now, value.name, value.instagram, value.eventDate, value.flexibleDate ? 1 : 0, value.eventLocation, value.coverage, value.notes, value.source, value.sourceAdId, JSON.stringify(value.attribution), settings.plannedCostCents, value.isTest ? 1 : 0, manual || value.isTest ? 1 : 0, hourAgo, value.instagram, hourAgo).run();
  if (!result.meta.changes) {
    const duplicate = await db().prepare("SELECT id, reference FROM inquiries WHERE submission_id = ?").bind(value.submissionId).first<{id:string;reference:string}>();
    if (duplicate) {
      if (value.alertTest) await enqueueExplicitTestAlert(duplicate.id, value.submissionId);
      return duplicate;
    }
    throw new TrackerError(429, "Please wait before sending another inquiry, or contact @sidebysouth on Instagram.");
  }
  if (value.alertTest) await enqueueExplicitTestAlert(id, value.submissionId);
  return { id, reference };
}

async function enqueueExplicitTestAlert(id: string, submissionId: string) {
  // Callers authorize this opt-in. The persisted test flag is checked again so
  // reusing an old real submission ID can never enroll it as a test alert.
  const saved = await db().prepare("SELECT is_test FROM inquiries WHERE id = ? AND submission_id = ?").bind(id, submissionId).first<Row>();
  if (Number(saved?.is_test) !== 1) throw new TrackerError(400, "Only a saved test inquiry can request an alert test.");
  await db().prepare("INSERT INTO inquiry_alerts (inquiry_id, queued_at, is_test_alert) SELECT id, ?, 1 FROM inquiries WHERE id = ? AND submission_id = ? AND is_test = 1 ON CONFLICT(inquiry_id) DO UPDATE SET is_test_alert = 1").bind(new Date().toISOString(), id, submissionId).run();
  const queued = await db().prepare("SELECT a.is_test_alert FROM inquiry_alerts a JOIN inquiries i ON i.id = a.inquiry_id WHERE i.id = ? AND i.submission_id = ? AND i.is_test = 1").bind(id, submissionId).first<Row>();
  if (Number(queued?.is_test_alert) !== 1) throw new TrackerError(400, "The inquiry changed before its test alert could be confirmed.");
}

export async function readTracker() {
  const [leads, ledger, audit, spent, settings] = await Promise.all([
    db().prepare("SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 5000").all<Row>(),
    db().prepare("SELECT * FROM ledger_transactions ORDER BY occurred_on DESC, created_at DESC LIMIT 10000").all<Row>(),
    db().prepare("SELECT id, transaction_id, action, reason, created_at FROM transaction_audit ORDER BY created_at LIMIT 50000").all<Row>(),
    db().prepare("SELECT * FROM ad_spend WHERE campaign_id = ? ORDER BY date LIMIT 100").bind(CAMPAIGN_ID).all<Row>(),
    readSettings(),
  ]);
  if (leads.results.length >= 5000 || ledger.results.length >= 10000 || audit.results.length >= 50000 || spent.results.length >= 100) throw new TrackerError(503, "This tracker has reached its record-view limit. Totals are hidden to avoid reporting incomplete financial results. The original records remain stored.");
  const auditByTransaction = new Map<string, { id: string; action: string; reason: string; createdAt: string }[]>();
  for (const row of audit.results) {
    const key = String(row.transaction_id);
    const events = auditByTransaction.get(key) || [];
    events.push({ id: String(row.id), action: String(row.action), reason: String(row.reason), createdAt: String(row.created_at) });
    auditByTransaction.set(key, events);
  }
  return { inquiries: leads.results.map(mapInquiry), transactions: ledger.results.map(row => ({ id: String(row.id), inquiryId: row.inquiry_id, occurredOn: String(row.occurred_on), type: String(row.type), amountCents: Number(row.amount_cents), method: String(row.method), referenceNote: String(row.reference_note || ""), createdAt: String(row.created_at), voidedAt: row.voided_at, voidReason: row.void_reason, auditEvents: auditByTransaction.get(String(row.id)) || [] })), spend: spent.results.map(row => ({ id: String(row.id), date: String(row.date), amountCents: Number(row.amount_cents), verifiedAt: String(row.verified_at), notes: String(row.notes || "") })), settings, cloudStatus: await getCloudTrackingStatus() };
}

async function updateInquiry(raw: unknown) {
  const input = object(raw);
  onlyKeys(input, ["id", "stage", "quotedMediaCents", "bookingDate", "completedDate", "source", "sourceAdId", "attribution", "notes", "actualCostsConfirmed", "decorationSettled", "isTest"]);
  const id = uuid(input.id, "Inquiry ID");
  const existing = await db().prepare("SELECT * FROM inquiries WHERE id = ?").bind(id).first<Row>();
  if (!existing) throw new TrackerError(404, "Inquiry not found.");
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => { updates.push(`${column} = ?`); values.push(value); };
  if (input.stage !== undefined) set("stage", choice(input.stage, STAGES, "Stage"));
  if (input.quotedMediaCents !== undefined) set("quoted_media_cents", input.quotedMediaCents === null ? null : cents(input.quotedMediaCents, "Media quote", true));
  if (input.bookingDate !== undefined) set("booking_date", date(input.bookingDate, "Booking date", true));
  if (input.completedDate !== undefined) set("completed_date", date(input.completedDate, "Completion date", true));
  if (input.notes !== undefined) set("notes", text(input.notes, "Notes", 2000));
  for (const [field, column] of [["actualCostsConfirmed", "actual_costs_confirmed"], ["decorationSettled", "decoration_settled"], ["isTest", "is_test"]]) if (input[field] !== undefined) set(column, bool(input[field], field) ? 1 : 0);
  if (input.source !== undefined || input.sourceAdId !== undefined || input.attribution !== undefined) {
    const source = input.source === undefined ? String(existing.source) : choice(input.source, SOURCES, "Source");
    const attrs = input.attribution === undefined ? JSON.parse(String(existing.attribution_json)) : attribution(input.attribution);
    const sourceAdId = input.sourceAdId === undefined ? (existing.source_ad_id == null ? null : String(existing.source_ad_id)) : adId(input.sourceAdId);
    if (source === "captured_url" && !capturedSource(attrs)) throw new TrackerError(400, "Captured attribution requires this campaign's original ad URL data.");
    if (source === "client_reported") { attrs.campaign_id = CAMPAIGN_ID; if (sourceAdId) attrs.ad_id = sourceAdId; else delete attrs.ad_id; }
    set("source", source); set("source_ad_id", source === "unknown" ? null : sourceAdId); set("attribution_json", JSON.stringify(attrs));
  }
  if (!updates.length) throw new TrackerError(400, "No supported changes were provided.");
  set("updated_at", new Date().toISOString());
  await db().prepare(`UPDATE inquiries SET ${updates.join(", ")} WHERE id = ?`).bind(...values, id).run();
  return { ok: true };
}

export function validateTransaction(raw: unknown) {
  const input = object(raw);
  onlyKeys(input, ["id", "inquiryId", "occurredOn", "type", "amountCents", "method", "referenceNote"]);
  const type = choice(input.type, TYPES, "Transaction type");
  const inquiryId = input.inquiryId == null || input.inquiryId === "" ? null : uuid(input.inquiryId, "Inquiry ID");
  if (type !== "software_expense" && !inquiryId) throw new TrackerError(400, "Select the inquiry this transaction belongs to.");
  const method = choice(input.method, METHODS, "Payment method");
  const referenceNote = text(input.referenceNote, "Payment reference", 240);
  const referenceKey = inquiryId && ["media_deposit", "media_balance", "media_refund"].includes(type) && ["zelle", "venmo", "bank_transfer"].includes(method) && referenceNote ? `${inquiryId}|${method}|${referenceNote.toLowerCase().replace(/\s+/g, " ")}` : null;
  return { id: uuid(input.id, "Transaction ID"), inquiryId, occurredOn: date(input.occurredOn, "Payment date")!, type, amountCents: cents(input.amountCents, "Transaction amount"), method, referenceNote, referenceKey };
}
async function addTransaction(raw: unknown) {
  const value = validateTransaction(raw);
  if (value.inquiryId && !(await db().prepare("SELECT id FROM inquiries WHERE id = ?").bind(value.inquiryId).first())) throw new TrackerError(404, "Inquiry not found.");
  const duplicate = await db().prepare("SELECT id FROM ledger_transactions WHERE id = ? OR (? IS NOT NULL AND reference_key = ? AND voided_at IS NULL)").bind(value.id, value.referenceKey, value.referenceKey).first();
  if (duplicate) throw new TrackerError(409, "That payment ID or transfer reference is already recorded. No duplicate was added.");
  try {
    const now = new Date().toISOString();
    const statements = [db().prepare("INSERT INTO ledger_transactions (id, inquiry_id, occurred_on, type, amount_cents, method, reference_note, reference_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(value.id, value.inquiryId, value.occurredOn, value.type, value.amountCents, value.method, value.referenceNote, value.referenceKey, now)];
    const confirmation = value.type === "direct_expense" ? "actual_costs_confirmed" : ["decoration_receipt", "partner_payout"].includes(value.type) ? "decoration_settled" : null;
    if (confirmation && value.inquiryId) statements.push(db().prepare(`UPDATE inquiries SET ${confirmation} = 0, updated_at = ? WHERE id = ?`).bind(now, value.inquiryId));
    await db().batch(statements);
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) throw new TrackerError(409, "That payment ID or transfer reference is already recorded. No duplicate was added.");
    throw error;
  }
  return { ok: true, id: value.id };
}
async function changeTransactionState(raw: unknown, action: "void" | "restore", actorId: string) {
  const input = object(raw);
  onlyKeys(input, ["id", "reason"]);
  const id = uuid(input.id, "Transaction ID");
  const reason = text(input.reason, "Correction reason", 500, true);
  if (reason.length < 3) throw new TrackerError(400, "Explain the reason for this correction.");
  const existing = await db().prepare("SELECT id, voided_at, inquiry_id, type FROM ledger_transactions WHERE id = ?").bind(id).first<Row>();
  if (!existing) throw new TrackerError(404, "Transaction not found.");
  if ((action === "void" && existing.voided_at != null) || (action === "restore" && existing.voided_at == null)) throw new TrackerError(409, "That transaction's state has already changed. Refresh before trying again.");
  const now = new Date().toISOString();
  const changeId = crypto.randomUUID();
  const update = action === "void"
    ? db().prepare("UPDATE ledger_transactions SET voided_at = ?, void_reason = ?, last_change_id = ? WHERE id = ? AND voided_at IS NULL").bind(now, reason, changeId, id)
    : db().prepare("UPDATE ledger_transactions SET voided_at = NULL, void_reason = NULL, last_change_id = ? WHERE id = ? AND voided_at IS NOT NULL").bind(changeId, id);
  try {
    const statements = [
      update,
      db().prepare("INSERT INTO transaction_audit (id, transaction_id, action, reason, created_at, actor_id) SELECT ?, id, ?, ?, ?, ? FROM ledger_transactions WHERE id = ? AND last_change_id = ?").bind(changeId, action, reason, now, actorId, id, changeId),
    ];
    const confirmation = existing.type === "direct_expense" ? "actual_costs_confirmed" : ["decoration_receipt", "partner_payout"].includes(String(existing.type)) ? "decoration_settled" : null;
    if (confirmation && existing.inquiry_id) statements.push(db().prepare(`UPDATE inquiries SET ${confirmation} = 0, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM ledger_transactions WHERE id = ? AND last_change_id = ?)`).bind(now, existing.inquiry_id, id, changeId));
    const result = await db().batch(statements);
    if (!result[0].meta.changes) throw new TrackerError(409, "That transaction's state has already changed. Refresh before trying again.");
  } catch (error) {
    if (error instanceof TrackerError) throw error;
    if (/unique|constraint/i.test(String(error))) throw new TrackerError(409, "An active payment already uses that transfer reference. Void the replacement before restoring the original.");
    throw error;
  }
  return { ok: true, id };
}
async function saveSpend(raw: unknown) {
  const input = object(raw);
  onlyKeys(input, ["date", "amountCents", "verifiedAt", "notes"]);
  const day = date(input.date, "Spend date")!;
  if (day < "2026-10-25" || day > "2026-11-01") throw new TrackerError(400, "Choose a date within the campaign's reporting window.");
  const amount = cents(input.amountCents, "Actual ad spend", true);
  const verifiedAt = text(input.verifiedAt, "Verification time", 40, true);
  if (!Number.isFinite(Date.parse(verifiedAt))) throw new TrackerError(400, "Please provide a valid verification time.");
  const notes = text(input.notes, "Spend notes", 500);
  const id = `${CAMPAIGN_ID}:${day}`;
  await db().prepare("INSERT INTO ad_spend (id, campaign_id, date, amount_cents, verified_at, notes) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(campaign_id, date) DO UPDATE SET amount_cents = excluded.amount_cents, verified_at = excluded.verified_at, notes = excluded.notes").bind(id, CAMPAIGN_ID, day, amount, verifiedAt, notes).run();
  return { ok: true, id };
}
async function updateSettings(raw: unknown) {
  const input = object(raw);
  onlyKeys(input, ["monthlySoftwareCents", "plannedCostCents", "softwareBusinessUseShare"]);
  if (!Object.keys(input).length) throw new TrackerError(400, "No supported changes were provided.");
  const current = await readSettings();
  const next = { monthlySoftwareCents: input.monthlySoftwareCents === undefined ? current.monthlySoftwareCents : cents(input.monthlySoftwareCents, "Monthly software cost", true), plannedCostCents: input.plannedCostCents === undefined ? current.plannedCostCents : cents(input.plannedCostCents, "Planned shoot cost", true), softwareBusinessUseShare: input.softwareBusinessUseShare === undefined ? current.softwareBusinessUseShare : input.softwareBusinessUseShare };
  if (next.softwareBusinessUseShare !== null && (typeof next.softwareBusinessUseShare !== "number" || !Number.isFinite(next.softwareBusinessUseShare) || next.softwareBusinessUseShare < 0 || next.softwareBusinessUseShare > 1)) throw new TrackerError(400, "Business-use share must be blank or between 0 and 1.");
  await db().prepare("INSERT INTO tracker_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").bind("business", JSON.stringify(next), new Date().toISOString()).run();
  return { ok: true };
}
export async function trackerAction(raw: unknown, actorId: string) {
  const input = object(raw);
  onlyKeys(input, ["action", "payload"]);
  switch (input.action) {
    case "createInquiry": return { ok: true, ...(await createInquiry(input.payload, true)) };
    case "updateInquiry": return updateInquiry(input.payload);
    case "addTransaction": return addTransaction(input.payload);
    case "voidTransaction": return changeTransactionState(input.payload, "void", actorId);
    case "restoreTransaction": return changeTransactionState(input.payload, "restore", actorId);
    case "saveSpend": return saveSpend(input.payload);
    case "updateSettings": return updateSettings(input.payload);
    default: throw new TrackerError(400, "Unsupported tracker action.");
  }
}
