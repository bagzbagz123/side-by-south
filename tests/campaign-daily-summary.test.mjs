import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const modules = new Map();
let stored;
const logEvents = [];
function load(path) {
  if (modules.has(path)) return modules.get(path);
  const exports = {};
  modules.set(path, exports);
  const source = ts.transpileModule(readFileSync(resolve(root, path), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ exports, console: { info: (...args) => logEvents.push(args) }, require(name) {
    if (name === "@/lib/tracker-metrics") return load("lib/tracker-metrics.ts");
    if (name === "@/lib/tracker-store") return { readTracker: async () => stored };
    throw new Error("Unexpected summary import");
  } });
  new vm.Script(source, { filename: path }).runInContext(context);
  return exports;
}
const { buildCampaignDailySummary: summary, easternDayStart, getCampaignDailySummary } = load("lib/campaign-daily-summary.ts");
const settings = { campaignId: "120255494608980357", videoAdId: "120255494608960357", photoAdId: "120255494734630357", budgetCents: 35000, start: "2026-10-26T09:00:00-04:00", end: "2026-11-02T08:00:00-05:00", monthlySoftwareCents: 10000, plannedCostCents: 5000, softwareBusinessUseShare: null };
const inquiry = (overrides = {}) => ({ id: "job-1", reference: "SBS-PRIVATE", name: "Private client fixture", instagram: "private_client", createdAt: "2026-10-26T14:00:00Z", eventDate: "2026-11-01", eventLocation: "Private fixture location", coverage: "both", notes: "Never expose private client notes", stage: "completed", quotedMediaCents: 60000, bookingDate: "2026-10-26", completedDate: "2026-11-01", source: "captured_url", attribution: { campaign_id: settings.campaignId }, plannedCostCents: 5000, actualCostsConfirmed: true, decorationSettled: true, isTest: false, ...overrides });
const transaction = (id, type, amountCents, occurredOn, overrides = {}) => ({ id, inquiryId: "job-1", type, amountCents, occurredOn, method: "zelle", referenceNote: "Private transfer reference", ...overrides });
const spend = (day, amountCents = 100, verifiedAt = "2026-11-03T13:00:00.000Z") => ({ id: day, date: day, amountCents, verifiedAt, notes: "Private owner record" });
const data = (overrides = {}) => ({ settings, inquiries: [], transactions: [], spend: [], ...overrides });
const dates = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"];

test("previous Eastern calendar day and local midnight stay correct across the 25-hour DST day", () => {
  const result = summary(data(), new Date("2026-11-02T14:00:00Z"));
  assert.equal(result.reportDate, "2026-11-01");
  assert.equal(new Date(easternDayStart("2026-11-01")).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(new Date(easternDayStart("2026-11-02")).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal((easternDayStart("2026-11-02") - easternDayStart("2026-11-01")) / 3600000, 25);
  for (const now of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) assert.equal(summary(data(), new Date(now)).reportDate, "2026-10-31");
});

test("missing spend stays unknown, while a confirmed explicit zero is zero", () => {
  const now = new Date("2026-10-27T13:00:00Z");
  const missing = summary(data(), now);
  assert.equal(missing.daily.adSpend.reportedCents, null);
  assert.equal(missing.campaignToDate.adSpend.reportedCents, null);
  assert.equal(missing.campaignToDate.completedJobContribution.beforeSoftwareCents, null);
  const zero = summary(data({ spend: [spend("2026-10-26", 0, now.toISOString())] }), now);
  assert.equal(zero.daily.adSpend.reportedCents, 0);
  assert.equal(zero.daily.adSpend.coverageComplete, true);
  assert.equal(zero.campaignToDate.adSpend.coverageComplete, false);
  assert.equal(missing.campaign.phase, "running");
  assert.equal(summary(data(), new Date("2026-10-25T13:00:00Z")).campaign.phase, "not_started");
  assert.equal(summary(data(), new Date("2026-11-03T13:00:00Z")).campaign.phase, "ended");
});

test("inquiries use Eastern creation dates, separate source attribution, and exclude tests", () => {
  const result = summary(data({ inquiries: [
    inquiry({ id: "first-hour", createdAt: "2026-11-01T05:30:00Z" }),
    inquiry({ id: "repeated-hour", createdAt: "2026-11-01T06:30:00Z", source: "client_reported", attribution: {}, sourceAdId: settings.photoAdId }),
    inquiry({ id: "other", createdAt: "2026-11-01T04:00:00Z", source: "unknown" }),
    inquiry({ id: "prior-day", createdAt: "2026-11-01T03:59:59Z" }),
    inquiry({ id: "test", createdAt: "2026-11-01T20:00:00Z", isTest: true }),
  ] }), new Date("2026-11-02T14:00:00Z"));
  assert.equal(result.daily.inquiries.campaign, 2);
  assert.equal(result.daily.inquiries.otherOrUnknown, 1);
  assert.equal(result.campaignToDate.inquiries.campaign, 3);
  assert.equal(result.campaignToDate.inquiries.otherOrUnknown, 1);
});

test("package ad URL and client-reported paid bookings reach daily campaign summaries", () => {
  const packageAdId = "120255499730570357";
  const inquiries = [
    inquiry({ stage: "booked", completedDate: null, sourceAdId: packageAdId, attribution: { campaign_id: settings.campaignId, ad_id: packageAdId, utm_content: "package_1250_static" } }),
    inquiry({ id: "reported-package", stage: "booked", completedDate: null, source: "client_reported", sourceAdId: packageAdId, attribution: {} }),
    inquiry({ id: "other", stage: "booked", completedDate: null, source: "unknown", attribution: { campaign_id: "unrelated-campaign", ad_id: packageAdId } }),
    inquiry({ id: "package-test", isTest: true, sourceAdId: packageAdId, attribution: { campaign_id: settings.campaignId, ad_id: packageAdId } }),
  ];
  const transactions = [
    transaction("package-deposit", "media_deposit", 15000, "2026-10-26"),
    transaction("reported-deposit", "media_deposit", 15000, "2026-10-26", { inquiryId: "reported-package" }),
    transaction("other-deposit", "media_deposit", 10000, "2026-10-26", { inquiryId: "other" }),
    transaction("test-deposit", "media_deposit", 99999, "2026-10-26", { inquiryId: "package-test" }),
  ];
  const result = summary(data({ inquiries, transactions }), new Date("2026-10-27T13:00:00Z"));
  assert.equal(result.daily.inquiries.campaign, 2);
  assert.equal(result.daily.newPaidBookings.campaign, 2);
  assert.equal(result.daily.newPaidBookings.otherOrUnknown, 1);
  assert.equal(result.daily.campaignCash.netMediaCents, 30000);
  assert.equal(result.campaignToDate.currentPaidBookings.campaign, 2);
});

test("confirmed prior-day spend is independent of current-day gaps and stale observations remain provisional", () => {
  const now = new Date("2026-10-28T13:00:00Z");
  const fresh = summary(data({ spend: [spend("2026-10-26", 200, now.toISOString()), spend("2026-10-27", 300, now.toISOString())] }), now);
  assert.equal(fresh.daily.adSpend.reportedCents, 300);
  assert.equal(fresh.daily.adSpend.coverageComplete, true);
  assert.equal(fresh.campaignToDate.adSpend.reportedCents, 500);
  assert.equal(fresh.campaignToDate.adSpend.missingDates.join(","), "2026-10-28");
  const stale = summary(data({ spend: [spend("2026-10-27", 300, "2026-10-27T20:00:00Z")] }), now);
  assert.equal(stale.daily.adSpend.reportedCents, 300);
  assert.equal(stale.daily.adSpend.coverageComplete, false);
  assert.equal(stale.daily.adSpend.freshness, "provisional");
  assert.equal(stale.daily.adSpend.provisionalDates.join(","), "2026-10-27");
});

test("first-funded bookings deduplicate balances and reconcile refunds against the full eligible ledger", () => {
  const inquiries = [inquiry({ stage: "booked", completedDate: null }), inquiry({ id: "other", source: "unknown" }), inquiry({ id: "refunded", stage: "booked" }), inquiry({ id: "test", isTest: true }), inquiry({ id: "cancelled", stage: "cancelled" })];
  const transactions = [transaction("deposit", "media_deposit", 20000, "2026-10-26"), transaction("balance", "media_balance", 40000, "2026-10-27"), transaction("refund", "media_refund", 5000, "2026-10-27"), transaction("cost", "direct_expense", 5000, "2026-10-27"), transaction("other-first", "media_deposit", 10000, "2026-10-27", { inquiryId: "other" }), transaction("refunded-first", "media_deposit", 10000, "2026-10-27", { inquiryId: "refunded" }), transaction("refunded-all", "media_refund", 10000, "2026-10-28", { inquiryId: "refunded" }), transaction("test-money", "media_deposit", 99999, "2026-10-27", { inquiryId: "test" }), transaction("cancelled-first", "media_deposit", 5000, "2026-10-27", { inquiryId: "cancelled" }), transaction("voided", "media_balance", 99999, "2026-10-27", { voidedAt: "2026-10-28T12:00:00Z" })];
  const result = summary(data({ inquiries, transactions }), new Date("2026-10-28T13:00:00Z"));
  assert.equal(result.daily.newPaidBookings.campaign, 0);
  assert.equal(result.daily.newPaidBookings.otherOrUnknown, 1);
  assert.equal(result.campaignToDate.newPaidBookings.campaign, 1);
  assert.equal(result.campaignToDate.currentPaidBookings.campaign, 1);
  assert.equal(result.daily.campaignCash.mediaReceivedCents, 55000);
  assert.equal(result.daily.campaignCash.mediaRefundedCents, 5000);
  assert.equal(result.daily.campaignCash.netMediaCents, 50000);
  assert.equal(result.campaignToDate.campaignCash.netMediaCents, 60000);
  assert.equal(result.campaignToDate.campaignCash.directExpenseCents, 5000);
  assert.equal(result.campaignToDate.completedJobContribution.beforeSoftwareCents, null);
  const serialized = JSON.stringify(result);
  for (const privateValue of ["Private client", "private_client", "SBS-PRIVATE", "Private transfer", "Never expose"]) assert.equal(serialized.includes(privateValue), false);
});

test("current contribution uses full current settlement and withholds unknown software share, costs and stale spend", () => {
  const fixture = data({ inquiries: [inquiry()], transactions: [transaction("receipt", "media_balance", 60000, "2026-11-01"), transaction("cost", "direct_expense", 5000, "2026-11-02"), transaction("decor", "decoration_receipt", 70000, "2026-11-01"), transaction("partner", "partner_payout", 65000, "2026-11-03"), transaction("software", "software_expense", 10000, "2026-11-03", { inquiryId: null })], spend: dates.map(day => spend(day, 4375)) });
  const now = new Date("2026-11-03T14:00:00Z");
  const result = summary(fixture, now);
  assert.equal(result.daily.campaignCash.partnerPayoutCents, 0);
  assert.equal(result.campaignToDate.campaignCash.partnerPayoutCents, 65000);
  assert.equal(result.campaignToDate.completedJobContribution.beforeSoftwareCents, 25000);
  assert.equal(result.campaignToDate.completedJobContribution.afterSoftwareCents, null);
  assert.equal(result.campaignToDate.completedJobContribution.softwareAllocationConfirmed, false);
  assert.equal(result.campaignToDate.softwareCashPaidCents, 10000);
  const allocated = summary({ ...fixture, settings: { ...settings, softwareBusinessUseShare: 1 } }, now);
  assert.equal(allocated.campaignToDate.completedJobContribution.afterSoftwareCents, 22692);
  assert.equal(summary({ ...fixture, inquiries: [inquiry({ actualCostsConfirmed: false })] }, now).campaignToDate.completedJobContribution.beforeSoftwareCents, null);
  assert.equal(summary({ ...fixture, inquiries: [inquiry({ decorationSettled: false })] }, now).campaignToDate.completedJobContribution.beforeSoftwareCents, null);
  assert.equal(summary({ ...fixture, spend: dates.map(day => spend(day, 4375, "2026-11-02T12:00:00Z")) }, now).campaignToDate.completedJobContribution.beforeSoftwareCents, null);
});

test("future inquiries, money and observations are excluded; unmatched refunds withhold contribution", () => {
  const now = new Date("2026-11-03T14:00:00Z");
  const fixture = data({ inquiries: [inquiry(), inquiry({ id: "future", createdAt: "2026-11-04T14:00:00Z" })], transactions: [transaction("receipt", "media_balance", 20000, "2026-11-01"), transaction("refund", "media_refund", 25000, "2026-11-02"), transaction("future-money", "media_balance", 99999, "2026-11-04"), transaction("future-client", "media_balance", 99999, "2026-11-01", { inquiryId: "future" })], spend: dates.map(day => spend(day, 0)) });
  const result = summary(fixture, now);
  assert.equal(result.campaignToDate.inquiries.campaign, 1);
  assert.equal(result.campaignToDate.campaignCash.netMediaCents, -5000);
  assert.equal(result.campaignToDate.currentPaidBookings.campaign, 0);
  assert.equal(result.campaignToDate.completedJobContribution.beforeSoftwareCents, null);
  assert.equal(result.campaignToDate.completedJobContribution.issues.some(issue => issue.includes("Refunds exceed")), true);
  const futureSpend = summary(data({ spend: [spend("2026-11-02", 35000, "2026-11-04T00:00:00Z")] }), now);
  assert.equal(futureSpend.daily.adSpend.reportedCents, null);
});

test("record caps fail closed and successful receipt logging contains only event name and report timestamps", async () => {
  for (const fixture of [data({ inquiries: Array(5000).fill(inquiry()) }), data({ transactions: Array(10000).fill(transaction("x", "media_deposit", 1, "2026-11-01")) }), data({ spend: Array(100).fill(spend("2026-11-01")) })]) assert.throws(() => summary(fixture), /record limit/);
  stored = data({ inquiries: [inquiry()] });
  logEvents.length = 0;
  await getCampaignDailySummary(new Date("2026-11-03T14:00:00Z"));
  assert.equal(logEvents.length, 1);
  assert.equal(logEvents[0][0], "campaign_daily_summary_generated");
  assert.equal(Object.keys(logEvents[0][1]).sort().join(","), "generatedAt,reportDate");
  assert.equal(JSON.stringify(logEvents).includes("Private"), false);
});

test("active production money with an invalid date fails closed while excluded test/void rows do not", () => {
  const invalid = transaction("bad-date", "media_balance", 60000, "2026-11-31");
  const now = new Date("2026-11-03T14:00:00Z");
  assert.throws(() => summary(data({ inquiries: [inquiry()], transactions: [invalid] }), now), /invalid money dates/);
  assert.doesNotThrow(() => summary(data({ inquiries: [inquiry({ isTest: true })], transactions: [invalid] }), now));
  assert.doesNotThrow(() => summary(data({ inquiries: [inquiry()], transactions: [{ ...invalid, voidedAt: "2026-11-01T12:00:00Z" }] }), now));
});
