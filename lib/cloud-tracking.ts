import { env } from "cloudflare:workers";

// This integration has no caller-selectable destination, account or time range.
const ACCOUNT_ID = "2313142399498951";
const CAMPAIGN_ID = "120255494608980357";
const GRAPH_ORIGIN = "https://graph.facebook.com";
const GRAPH_VERSION = "v26.0";
const START = "2026-10-25T08:10:00-04:00";
const FIRST_DAY = "2026-10-25";
const LAST_DAY = "2026-11-01";
const REPORTING_DATES = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
const ALERT_CUTOFF = "2026-10-25T07:59:47.280Z";
const STATE_KEY = "meta_spend";
const INQUIRY_STATE_KEY = "inquiry_alerts";
type Row = Record<string, string | number | null>;
type ObjectValue = Record<string, unknown>;

export class CloudTrackingError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "CloudTrackingError"; }
}
function database(): D1Database {
  if (!env.DB) throw new CloudTrackingError("storage_unavailable", "Cloud tracking storage is unavailable.");
  return env.DB;
}
function token(): string | null {
  const value = (env as unknown as { META_ADS_READ_TOKEN?: string }).META_ADS_READ_TOKEN;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asObject(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudTrackingError("invalid_meta_report", "Meta returned an unexpected report shape. No spend was changed.");
  return value as ObjectValue;
}
function localDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return `${parts.find(part => part.type === "year")!.value}-${parts.find(part => part.type === "month")!.value}-${parts.find(part => part.type === "day")!.value}`;
}
function expectedDays(now: Date): string[] {
  const until = localDay(now) < LAST_DAY ? localDay(now) : LAST_DAY;
  const result: string[] = [];
  for (const day = new Date(`${FIRST_DAY}T12:00:00Z`); day.toISOString().slice(0, 10) <= until; day.setUTCDate(day.getUTCDate() + 1)) result.push(day.toISOString().slice(0, 10));
  return result;
}
export function decimalSpendCents(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new CloudTrackingError("invalid_meta_report", "Meta spend must be an exact nonnegative USD decimal. No spend was changed.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(100000000)) throw new CloudTrackingError("invalid_meta_report", "Meta returned an out-of-range spend value. No spend was changed.");
  return Number(amount);
}
async function ensureState(now: Date) {
  await database().prepare("INSERT INTO tracking_cloud_state (key, last_status, connection_status, updated_at) VALUES (?, 'ready', 'not_verified', ?) ON CONFLICT(key) DO NOTHING").bind(STATE_KEY, now.toISOString()).run();
}
async function state(key = STATE_KEY) { return database().prepare("SELECT * FROM tracking_cloud_state WHERE key = ?").bind(key).first<Row>(); }

async function graphGet(path: string, params: Record<string, string>, credential: string): Promise<ObjectValue> {
  const url = new URL(`${GRAPH_ORIGIN}/${GRAPH_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    // Never put the credential in URLs, logs, returned values, source or database.
    // Workers supports manual/follow; redirect:"error" throws before sending.
    const result = await fetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" }, redirect: "manual", signal: controller.signal });
    if (result.status >= 300 && result.status < 400) throw new CloudTrackingError("meta_redirect_blocked", "Meta returned a redirect. The credential was not forwarded and no spend was changed.");
    const reader = result.body?.getReader();
    if (!reader) throw new CloudTrackingError("invalid_meta_report", "Meta returned an empty response. No spend was changed.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 262144) { await reader.cancel(); throw new CloudTrackingError("meta_response_limit", "The Meta response exceeded the bounded report size. No spend was changed."); }
      chunks.push(next.value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    let data: ObjectValue;
    try { data = asObject(JSON.parse(new TextDecoder().decode(joined))); }
    catch { throw new CloudTrackingError("invalid_meta_report", "Meta returned an unreadable response. No spend was changed."); }
    if (!result.ok || data.error) {
      const errorCode = data.error && typeof data.error === "object" ? (data.error as ObjectValue).code : null;
      if (errorCode === 190 || errorCode === 102 || result.status === 401) throw new CloudTrackingError("token_rejected", "Meta rejected or expired the read credential. Reconnect the read-only credential.");
      if (result.status === 403) throw new CloudTrackingError("meta_access_denied", "The read credential cannot access this exact ad account and campaign.");
      if (result.status === 429) throw new CloudTrackingError("meta_rate_limited", "Meta temporarily rate-limited the read request. No spend was changed.");
      throw new CloudTrackingError("meta_request_failed", "Meta could not provide this bounded report. No spend was changed.");
    }
    return data;
  } catch (error) {
    if (error instanceof CloudTrackingError) throw error;
    throw new CloudTrackingError(controller.signal.aborted ? "meta_timeout" : "meta_unavailable", "The Meta read request did not complete. No spend was changed.");
  } finally { clearTimeout(timeout); }
}

async function verifyIdentifiers(credential: string) {
  const account = await graphGet(`act_${ACCOUNT_ID}`, { fields: "id,account_id,currency,timezone_name,account_status" }, credential);
  if (account.id !== `act_${ACCOUNT_ID}` || account.account_id !== ACCOUNT_ID || account.currency !== "USD" || account.timezone_name !== "America/New_York") throw new CloudTrackingError("account_mismatch", "The read credential did not verify the expected USD / America/New_York ad account. No spend was changed.");
  const campaign = await graphGet(CAMPAIGN_ID, { fields: "id,account_id" }, credential);
  if (campaign.id !== CAMPAIGN_ID || campaign.account_id !== ACCOUNT_ID) throw new CloudTrackingError("campaign_mismatch", "The campaign did not match the expected ad account. No spend was changed.");
}
export async function verifyMetaConnection(now = new Date()) {
  await ensureState(now);
  const credential = token();
  if (!credential) {
    await database().prepare("UPDATE tracking_cloud_state SET connection_status = 'setup_required', connection_result_code = 'missing_token', updated_at = ? WHERE key = ?").bind(now.toISOString(), STATE_KEY).run();
    return { status: "setup_required", code: "missing_token", tokenConfigured: false, verifiedAt: null, message: "The server-side Meta read credential has not been configured. No spend was read or changed." };
  }
  try {
    await verifyIdentifiers(credential);
    await database().prepare("UPDATE tracking_cloud_state SET connection_status = 'verified', connection_verified_at = ?, connection_result_code = 'verified_identifiers', updated_at = ? WHERE key = ?").bind(now.toISOString(), now.toISOString(), STATE_KEY).run();
    return { status: "verified", tokenConfigured: true, verifiedAt: now.toISOString(), adAccountId: ACCOUNT_ID, campaignId: CAMPAIGN_ID, currency: "USD", timezone: "America/New_York", credentialScopeVerification: "Configure and verify ads_read-only permissions in Meta; this integration only issues fixed GET requests.", spendChanged: false };
  } catch (error) {
    const failure = error instanceof CloudTrackingError ? error : new CloudTrackingError("tracking_unavailable", "The connection could not be verified.");
    await database().prepare("UPDATE tracking_cloud_state SET connection_status = 'error', connection_result_code = ?, updated_at = ? WHERE key = ?").bind(failure.code, now.toISOString(), STATE_KEY).run();
    return { status: "error", code: failure.code, tokenConfigured: true, message: failure.message, spendChanged: false };
  }
}

async function fetchDailySpend(credential: string, days: string[]) {
  const path = `${CAMPAIGN_ID}/insights`;
  const params = { fields: "account_id,account_currency,campaign_id,date_start,date_stop,spend", level: "campaign", time_increment: "1", time_range: JSON.stringify({ since: FIRST_DAY, until: days[days.length - 1] }), limit: "100" };
  const seenCursors = new Set<string>();
  const rows = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < 3; page++) {
    const data = await graphGet(path, after ? { ...params, after } : params, credential);
    if (!Array.isArray(data.data) || data.data.length > 100) throw new CloudTrackingError("invalid_meta_report", "Meta did not return bounded daily report rows. No spend was changed.");
    for (const entry of data.data) {
      const row = asObject(entry);
      if (row.account_id !== ACCOUNT_ID || row.campaign_id !== CAMPAIGN_ID || row.account_currency !== "USD" || typeof row.date_start !== "string" || row.date_start !== row.date_stop || !days.includes(row.date_start) || rows.has(row.date_start)) throw new CloudTrackingError("invalid_meta_report", "Meta returned mismatched, duplicate or out-of-window report rows. No spend was changed.");
      rows.set(row.date_start, decimalSpendCents(row.spend));
    }
    const paging = data.paging && typeof data.paging === "object" ? data.paging as ObjectValue : null;
    if (!paging?.next) return rows;
    if (typeof paging.next !== "string") throw new CloudTrackingError("unsafe_pagination", "Meta pagination could not be verified. No spend was changed.");
    let nextUrl: URL;
    try { nextUrl = new URL(paging.next); } catch { throw new CloudTrackingError("unsafe_pagination", "Meta pagination could not be verified. No spend was changed."); }
    if (nextUrl.origin !== GRAPH_ORIGIN || nextUrl.pathname !== `/${GRAPH_VERSION}/${path}`) throw new CloudTrackingError("unsafe_pagination", "Meta pagination left the fixed campaign endpoint. No spend was changed.");
    const cursors = paging.cursors && typeof paging.cursors === "object" ? paging.cursors as ObjectValue : null;
    if (typeof cursors?.after !== "string" || !/^[A-Za-z0-9+/=_-]{1,2048}$/.test(cursors.after) || seenCursors.has(cursors.after)) throw new CloudTrackingError("unsafe_pagination", "Meta pagination repeated or omitted its bounded cursor. No spend was changed.");
    after = cursors.after;
    seenCursors.add(after);
    // Only the opaque cursor is reused. Provider URLs and their credential query
    // parameters are never followed or copied to an outgoing request.
  }
  throw new CloudTrackingError("meta_page_limit", "Meta exceeded the bounded daily-report page limit. No spend was changed.");
}

export async function syncCampaignSpend(now = new Date()) {
  await ensureState(now);
  const credential = token();
  if (!credential) return { status: "setup_required", code: "missing_token", tokenConfigured: false, message: "Configure the server-side ads_read-only Meta credential before automatic spend sync. No spend was changed." };
  if (now.getTime() < new Date(START).getTime()) {
    await database().prepare("UPDATE tracking_cloud_state SET last_attempt_at = ?, last_status = 'not_started', last_result_code = 'before_campaign_start', updated_at = ? WHERE key = ?").bind(now.toISOString(), now.toISOString(), STATE_KEY).run();
    return { status: "not_started", code: "before_campaign_start", startsAt: START, message: "The campaign has not started. No spend rows were created." };
  }
  const lease = crypto.randomUUID();
  const leaseExpiry = new Date(now.getTime() + 120000).toISOString();
  const lock = await database().prepare("UPDATE tracking_cloud_state SET lease_owner = ?, lease_expires_at = ?, last_attempt_at = ?, last_status = 'syncing', last_result_code = NULL, updated_at = ? WHERE key = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").bind(lease, leaseExpiry, now.toISOString(), now.toISOString(), STATE_KEY, now.toISOString()).run();
  if (!lock.meta.changes) return { status: "syncing", code: "lease_active", message: "Another bounded spend sync is in progress." };
  try {
    await verifyIdentifiers(credential);
    const days = expectedDays(now);
    const rows = await fetchDailySpend(credential, days);
    const status = rows.size === days.length ? "synced" : "incomplete";
    const code = rows.size === 0 ? "empty_report" : status === "synced" ? "daily_rows_verified" : "missing_daily_rows";
    const observedAt = now.toISOString();
    const notes = new Map(Array.from(rows.keys(), day => [day, `Meta Marketing API v26.0: explicit daily campaign spend; ${day === localDay(now) ? "current day provisional" : "past day as reported"}; observed ${observedAt}. Missing days are not inferred.`]));
    if (rows.size) {
      const conflicts = Array.from(rows).map(() => "(date = ? AND (verified_at > ? OR (verified_at = ? AND amount_cents != ?)))").join(" OR ");
      const conflictValues = Array.from(rows).flatMap(([day, amount]) => [day, observedAt, observedAt, amount]);
      const statements: D1PreparedStatement[] = [database().prepare(`UPDATE tracking_cloud_state SET last_result_code = 'verified_write_guard' WHERE key = ? AND lease_owner = ? AND NOT EXISTS (SELECT 1 FROM ad_spend WHERE campaign_id = ? AND (${conflicts}))`).bind(STATE_KEY, lease, CAMPAIGN_ID, ...conflictValues)];
      for (const [day, amount] of rows) statements.push(database().prepare("INSERT INTO ad_spend (id, campaign_id, date, amount_cents, verified_at, notes) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tracking_cloud_state WHERE key = ? AND lease_owner = ? AND last_result_code = 'verified_write_guard') ON CONFLICT(campaign_id, date) DO UPDATE SET amount_cents = excluded.amount_cents, verified_at = excluded.verified_at, notes = excluded.notes").bind(`${CAMPAIGN_ID}:${day}`, CAMPAIGN_ID, day, amount, observedAt, notes.get(day)!, STATE_KEY, lease));
      const results = await database().batch(statements);
      if (!results[0].meta.changes) throw new CloudTrackingError("spend_observation_conflict", "A newer or conflicting verified spend observation exists. No report rows were replaced.");
      const persisted = await database().prepare(`SELECT date, amount_cents, verified_at, notes FROM ad_spend WHERE campaign_id = ? AND date IN (${Array.from(rows).map(() => "?").join(",")})`).bind(CAMPAIGN_ID, ...rows.keys()).all<Row>();
      if (persisted.results.length !== rows.size || persisted.results.some(row => !rows.has(String(row.date)) || Number(row.amount_cents) !== rows.get(String(row.date)) || row.verified_at !== observedAt || row.notes !== notes.get(String(row.date)))) throw new CloudTrackingError("spend_readback_mismatch", "Persisted spend did not match the verified report. The sync is not marked successful; review the existing observations.");
    }
    const result = await database().prepare("UPDATE tracking_cloud_state SET lease_owner = NULL, lease_expires_at = NULL, last_success_at = CASE WHEN ? > 0 THEN ? ELSE last_success_at END, last_status = ?, last_result_code = ?, last_imported_days = ?, connection_status = 'verified', connection_verified_at = ?, connection_result_code = 'verified_identifiers', updated_at = ? WHERE key = ? AND lease_owner = ?").bind(rows.size, observedAt, status, code, rows.size, observedAt, observedAt, STATE_KEY, lease).run();
    if (!result.meta.changes) throw new CloudTrackingError("lease_lost", "The sync lease changed before its report could be confirmed.");
    return { status, code, campaignId: CAMPAIGN_ID, adAccountId: ACCOUNT_ID, currency: "USD", timezone: "America/New_York", verifiedAt: rows.size ? now.toISOString() : null, importedDayCount: rows.size, expectedDayCount: days.length, missingDates: days.filter(day => !rows.has(day)), message: rows.size ? "Explicit daily spend rows were reconciled. Missing days remain unknown." : "Meta returned no daily rows. Existing spend was preserved; missing days remain unknown." };
  } catch (error) {
    const failure = error instanceof CloudTrackingError ? error : new CloudTrackingError("tracking_unavailable", "Cloud spend sync did not complete. Existing spend was preserved.");
    await database().prepare("UPDATE tracking_cloud_state SET lease_owner = NULL, lease_expires_at = NULL, last_status = 'error', last_result_code = ?, last_imported_days = 0, updated_at = ? WHERE key = ? AND lease_owner = ?").bind(failure.code, now.toISOString(), STATE_KEY, lease).run();
    return { status: "error", code: failure.code, message: failure.message };
  }
}

export async function getCloudTrackingStatus(now = new Date()) {
  const current = await state();
  const inquiryScan = await state(INQUIRY_STATE_KEY);
  const reported = await database().prepare(`SELECT date, amount_cents, verified_at FROM ad_spend WHERE campaign_id = ? AND date IN (${REPORTING_DATES.map(() => "?").join(",")}) ORDER BY date LIMIT 8`).bind(CAMPAIGN_ID, ...REPORTING_DATES).all<Row>();
  const today = localDay(now);
  const confirmedRows = reported.results.filter(row => {
    const amount = Number(row.amount_cents);
    const verifiedAt = Date.parse(String(row.verified_at));
    return now.getTime() >= new Date(START).getTime() && String(row.date) <= today && Number.isSafeInteger(amount) && amount >= 0 && amount <= 100000000 && Number.isFinite(verifiedAt) && verifiedAt <= now.getTime();
  });
  const confirmedSpendDates = confirmedRows.map(row => String(row.date));
  const reportedSpendTotalCents = confirmedRows.length ? confirmedRows.reduce((total, row) => total + Number(row.amount_cents), 0) : null;
  const alerts = await database().prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN a.reported_at IS NOT NULL THEN 1 ELSE 0 END) AS reported, MAX(a.reported_at) AS last_reported FROM inquiries i LEFT JOIN inquiry_alerts a ON a.inquiry_id = i.id WHERE i.is_test = 0 AND i.created_at >= ?").bind(ALERT_CUTOFF).first<Row>();
  const configured = !!token();
  const leaseActive = !!current?.lease_expires_at && String(current.lease_expires_at) > now.toISOString();
  let status = !configured ? "setup_required" : leaseActive ? "syncing" : String(current?.last_status || (now.getTime() < new Date(START).getTime() ? "not_started" : "ready"));
  if (!leaseActive && status === "syncing") status = "error";
  return { tokenConfigured: configured, spendSource: "Meta Marketing API v26.0; exact campaign and explicit daily rows", status, setupReason: configured ? null : "missing_token", lastAttemptAt: current?.last_attempt_at || null, lastSuccessfulSyncAt: current?.last_success_at || null, lastResultCode: current?.last_result_code || null, importedDayCount: Number(current?.last_imported_days || 0), reportingDates: [...REPORTING_DATES], confirmedSpendDates, reportedSpendTotalCents, completeCampaignReporting: confirmedSpendDates.length === REPORTING_DATES.length && REPORTING_DATES.every(day => confirmedSpendDates.includes(day)), connectionStatus: current?.connection_status || "not_verified", connectionVerifiedAt: current?.connection_verified_at || null, connectionResultCode: current?.connection_result_code || null, monitorState: "unverified", pendingInquiryAlerts: Number(alerts?.total || 0) - Number(alerts?.reported || 0), reportedInquiryAlerts: Number(alerts?.reported || 0), lastInquiryScanAt: inquiryScan?.last_attempt_at || null, lastInquiryScanStatus: inquiryScan?.last_status || null, lastInquiryScanResultCode: inquiryScan?.last_result_code || null, lastInquiryScanAlertCount: Number(inquiryScan?.last_imported_days || 0), lastInquiryAlertReportedAt: alerts?.last_reported || null, alertDeliverySemantics: "reported_intent_not_delivery_confirmation", credentialScopeVerification: "external_ads_read_only_required" };
}

export async function getPendingInquiryAlerts(limit = 10, now = new Date()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new CloudTrackingError("invalid_arguments", "Choose an alert limit between 1 and 25.");
  await database().prepare("INSERT INTO inquiry_alerts (inquiry_id, queued_at) SELECT id, ? FROM inquiries WHERE is_test = 0 AND created_at >= ? ON CONFLICT(inquiry_id) DO NOTHING").bind(now.toISOString(), ALERT_CUTOFF).run();
  const claimId = crypto.randomUUID();
  const claimExpiresAt = new Date(now.getTime() + 600000).toISOString();
  await database().prepare("UPDATE inquiry_alerts SET claim_id = ?, claim_expires_at = ? WHERE inquiry_id IN (SELECT a.inquiry_id FROM inquiry_alerts a JOIN inquiries i ON i.id = a.inquiry_id WHERE (i.is_test = 0 OR (i.is_test = 1 AND a.is_test_alert = 1)) AND i.created_at >= ? AND a.reported_at IS NULL AND (a.claim_id IS NULL OR a.claim_expires_at <= ?) ORDER BY i.created_at LIMIT ?)").bind(claimId, claimExpiresAt, ALERT_CUTOFF, now.toISOString(), limit).run();
  const rows = await database().prepare("SELECT i.id, i.reference, i.coverage, i.event_date, i.created_at, i.is_test, a.is_test_alert FROM inquiry_alerts a JOIN inquiries i ON i.id = a.inquiry_id WHERE a.claim_id = ? AND a.reported_at IS NULL AND (i.is_test = 0 OR (i.is_test = 1 AND a.is_test_alert = 1)) ORDER BY i.created_at").bind(claimId).all<Row>();
  // A successful empty scan also needs a durable receipt. This separate state
  // key never modifies Meta sync state or implies notification delivery.
  const checkedAt = now.toISOString();
  await database().prepare("INSERT INTO tracking_cloud_state (key, last_attempt_at, last_status, last_result_code, last_imported_days, updated_at) VALUES (?, ?, 'scanned', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_status = excluded.last_status, last_result_code = excluded.last_result_code, last_imported_days = excluded.last_imported_days, updated_at = excluded.updated_at").bind(INQUIRY_STATE_KEY, checkedAt, rows.results.length ? "pending" : "empty", rows.results.length, checkedAt).run();
  return { checkedAt, claimId: rows.results.length ? claimId : null, claimExpiresAt: rows.results.length ? claimExpiresAt : null, alerts: rows.results.map(row => ({ id: row.id, reference: row.reference, coverage: row.coverage, eventDate: row.event_date, createdAt: row.created_at, isTest: !!row.is_test, testAlert: !!row.is_test && !!row.is_test_alert, localTime: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(String(row.created_at))) })), deliverySemantics: "reported_intent_not_delivery_confirmation" };
}
export async function acknowledgeInquiryAlerts(claimId: unknown, inquiryIds: unknown, now = new Date()) {
  if (typeof claimId !== "string" || !/^[0-9a-f-]{36}$/i.test(claimId) || !Array.isArray(inquiryIds) || !inquiryIds.length || inquiryIds.length > 25 || new Set(inquiryIds).size !== inquiryIds.length || inquiryIds.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) throw new CloudTrackingError("invalid_arguments", "Provide the known alert claim and one to 25 unique inquiry IDs.");
  const placeholders = inquiryIds.map(() => "?").join(",");
  const rows = await database().prepare(`SELECT a.inquiry_id, a.claim_id, a.reported_at FROM inquiry_alerts a JOIN inquiries i ON i.id = a.inquiry_id WHERE a.inquiry_id IN (${placeholders}) AND (i.is_test = 0 OR (i.is_test = 1 AND a.is_test_alert = 1)) AND i.created_at >= ?`).bind(...inquiryIds as string[], ALERT_CUTOFF).all<Row>();
  if (rows.results.length !== inquiryIds.length || rows.results.some(row => row.claim_id !== claimId)) throw new CloudTrackingError("unknown_alert_claim", "Only known inquiry IDs from this alert claim can be acknowledged.");
  await database().prepare(`UPDATE inquiry_alerts SET reported_at = COALESCE(reported_at, ?) WHERE claim_id = ? AND inquiry_id IN (${placeholders})`).bind(now.toISOString(), claimId, ...inquiryIds as string[]).run();
  const confirmed = await database().prepare(`SELECT inquiry_id, claim_id, reported_at FROM inquiry_alerts WHERE inquiry_id IN (${placeholders})`).bind(...inquiryIds as string[]).all<Row>();
  if (confirmed.results.length !== inquiryIds.length || confirmed.results.some(row => row.claim_id !== claimId || !row.reported_at)) throw new CloudTrackingError("alert_claim_changed", "The alert claim changed before its report could be confirmed. Poll again before acknowledging.");
  return { status: "acknowledged", inquiryCount: inquiryIds.length, deliverySemantics: "reported_intent_not_delivery_confirmation", message: "The cloud task's report intent is recorded. This does not confirm push-notification delivery." };
}
