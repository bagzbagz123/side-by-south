import test from "node:test";
import assert from "node:assert/strict";
import { calculateTrackerMetrics, campaignAttribution, inquiryMoney, reportingDates, sourceLabel, WEBSITE_PACKAGE_AD_ID } from "./tracker-metrics.ts";

const settings = {
  campaignId: "120255494608980357", budgetCents: 35000,
  start: "2026-10-26T09:00:00-04:00", end: "2026-11-02T08:00:00-05:00",
  monthlySoftwareCents: 10000, plannedCostCents: 5000, softwareBusinessUseShare: 1,
};
const now = new Date("2026-10-26T18:00:00-04:00");
const inquiry = (overrides = {}) => ({
  id: "job-1", reference: "SBS-TEST", createdAt: "2026-10-26T13:00:00-04:00",
  name: "Test record", instagram: "test", eventDate: "2026-10-26", eventLocation: "Miami",
  coverage: "both", notes: "", stage: "completed", quotedMediaCents: 60000,
  bookingDate: "2026-10-26", completedDate: "2026-10-26", source: "captured_url",
  attribution: { campaign_id: settings.campaignId }, plannedCostCents: 5000,
  actualCostsConfirmed: true, decorationSettled: false, isTest: false, ...overrides,
});
const txn = (id, type, amountCents, overrides = {}) => ({ id, inquiryId: "job-1", occurredOn: "2026-10-26", type, amountCents, method: "zelle", referenceNote: id, ...overrides });
const spend = [{ id: "spend-1", date: "2026-10-26", amountCents: 35000, verifiedAt: now.toISOString(), notes: "Fixture only" }];
const payments = [txn("deposit", "media_deposit", 20000), txn("balance", "media_balance", 40000), txn("refund", "media_refund", 5000), txn("cost", "direct_expense", 5000)];
const fixture = (overrides = {}) => ({ settings, inquiries: [inquiry()], transactions: payments, spend, ...overrides });

test("deposits, balances and refunds count cash once and one booking", () => {
  const result = calculateTrackerMetrics(fixture(), now);
  assert.equal(result.cash.netMediaCents, 55000);
  assert.equal(result.depositBackedBookingCount, 1);
  assert.equal(result.bookedValueCents, 60000);
  assert.equal(result.completedContributionBeforeSoftwareCents, 15000);
  assert.equal(result.completedContributionAfterSoftwareCents, 12692);
});

test("future shoot deposits are cash, never completed-job contribution", () => {
  const result = calculateTrackerMetrics(fixture({ inquiries: [inquiry({ stage: "booked", completedDate: null })], transactions: [payments[0]] }), now);
  assert.equal(result.cash.netMediaCents, 20000);
  assert.equal(result.completedCash.netMediaCents, 0);
  assert.equal(result.completedContributionBeforeSoftwareCents, null);
  assert.equal(result.completedCount, 0);
});

test("decoration money is only retained after partner settlement is confirmed", () => {
  const transactions = [...payments, txn("decor", "decoration_receipt", 70000), txn("partner", "partner_payout", 65000)];
  const pending = calculateTrackerMetrics(fixture({ transactions }), now);
  assert.equal(pending.completedContributionBeforeSoftwareCents, null);
  const settled = calculateTrackerMetrics(fixture({ inquiries: [inquiry({ decorationSettled: true })], transactions }), now);
  assert.equal(settled.completedCash.decorationBalanceCents, 5000);
  assert.equal(settled.completedContributionAfterSoftwareCents, 17692);
});

test("planned $50 costs are never substituted for missing actual costs", () => {
  const result = calculateTrackerMetrics(fixture({ inquiries: [inquiry({ actualCostsConfirmed: false })] }), now);
  assert.equal(result.completedContributionBeforeSoftwareCents, null);
  assert.equal(result.missingActualCosts.length, 1);
});

test("the $350 budget does not become actual spend when no report exists", () => {
  const result = calculateTrackerMetrics(fixture({ spend: [] }), now);
  assert.equal(result.actualSpendCents, null);
  assert.equal(result.remainingBudgetCents, null);
  assert.equal(result.cashAfterAdsAndDirectExpensesCents, null);
  assert.equal(result.completedContributionAfterSoftwareCents, null);
});

test("zero spend and zero bookings keep ratios unavailable, not NaN", () => {
  const result = calculateTrackerMetrics(fixture({ inquiries: [], transactions: [], spend: [{ ...spend[0], amountCents: 0 }] }), now);
  assert.equal(result.actualSpendCents, 0);
  assert.equal(result.costPerPaidBookingCents, null);
  assert.equal(result.completedContributionAfterSoftwareCents, null);
});

test("all eight Eastern reporting dates are present across the 168-hour DST window", () => {
  assert.deepEqual(reportingDates(settings), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.equal((Date.parse(settings.end) - Date.parse(settings.start)) / 3600000, 168);
});

test("unknown sources stay out of campaign totals and client reports remain distinguishable", () => {
  assert.equal(campaignAttribution(inquiry({ source: "unknown" }), settings), false);
  assert.equal(campaignAttribution(inquiry({ source: "client_reported", attribution: {}, sourceAdId: "120255494734630357" }), settings), true);
  const result = calculateTrackerMetrics(fixture({ inquiries: [inquiry({ source: "unknown" })] }), now);
  assert.equal(result.campaignInquiryCount, 0);
  assert.equal(result.unattributedInquiryCount, 1);
  assert.equal(result.cash.netMediaCents, 0);
});

test("package ad inquiries and paid bookings count once with descriptive URL and client-reported labels", () => {
  const captured = inquiry({ stage: "booked", completedDate: null, quotedMediaCents: 50000, sourceAdId: WEBSITE_PACKAGE_AD_ID, attribution: { campaign_id: settings.campaignId, ad_id: WEBSITE_PACKAGE_AD_ID, utm_content: "package_1250_static" } });
  const reported = inquiry({ id: "job-2", stage: "booked", completedDate: null, quotedMediaCents: 50000, source: "client_reported", sourceAdId: WEBSITE_PACKAGE_AD_ID, attribution: {} });
  const unknown = inquiry({ id: "job-3", source: "unknown", attribution: { campaign_id: settings.campaignId, ad_id: "unrelated-ad" } });
  const excludedTest = inquiry({ ...captured, id: "job-4", isTest: true });
  const result = calculateTrackerMetrics(fixture({
    inquiries: [captured, reported, unknown, excludedTest],
    transactions: [txn("package-1", "media_deposit", 15000), txn("package-2", "media_deposit", 15000, { inquiryId: "job-2" }), txn("other", "media_deposit", 99999, { inquiryId: "job-3" }), txn("test", "media_deposit", 99999, { inquiryId: "job-4" })],
  }), now);
  assert.equal(sourceLabel(captured, settings), "$1,250 package ad · URL captured");
  assert.equal(sourceLabel(reported, settings), "$1,250 package ad · client reported");
  assert.equal(sourceLabel(excludedTest, settings), "$1,250 package ad · URL captured");
  assert.equal(result.campaignInquiryCount, 2);
  assert.equal(result.depositBackedBookingCount, 2);
  assert.equal(result.bookedValueCents, 100000);
  assert.equal(result.cash.netMediaCents, 30000);
  assert.equal(result.unattributedInquiryCount, 1);
  assert.equal(result.testInquiryCount, 1);
  assert.equal(campaignAttribution(inquiry({ source: "captured_url", attribution: { campaign_id: "unrelated-campaign", ad_id: WEBSITE_PACKAGE_AD_ID } }), settings), false);
  assert.equal(campaignAttribution(inquiry({ source: "client_reported", attribution: {}, sourceAdId: "unrelated-ad" }), settings), false);
});

test("test inquiries and their money never enter production metrics", () => {
  const result = calculateTrackerMetrics(fixture({ inquiries: [inquiry({ isTest: true })] }), now);
  assert.equal(result.allInquiryCount, 0);
  assert.equal(result.campaignInquiryCount, 0);
  assert.equal(result.cash.netMediaCents, 0);
  assert.equal(result.testInquiryCount, 1);
});

test("software cash and overhead allocation are never deducted twice", () => {
  const transactions = [...payments, txn("pro", "software_expense", 10000, { inquiryId: null })];
  const result = calculateTrackerMetrics(fixture({ transactions }), now);
  assert.equal(result.softwareCashPaidCents, 10000);
  assert.equal(result.allocatedSoftwareCents, 2308);
  assert.equal(result.completedContributionAfterSoftwareCents, 12692);
});

test("business-use share must be confirmed before final software allocation", () => {
  const result = calculateTrackerMetrics(fixture({ settings: { ...settings, softwareBusinessUseShare: null } }), now);
  assert.equal(result.completedContributionBeforeSoftwareCents, 15000);
  assert.equal(result.allocatedSoftwareCents, null);
  assert.equal(result.completedContributionAfterSoftwareCents, null);
  assert.equal(result.fullBusinessSoftwarePlanningCents, 2308);
});

test("duplicate transfer IDs are not summed and withhold contribution", () => {
  const transactions = [...payments, payments[0]];
  assert.equal(inquiryMoney("job-1", transactions).netMediaCents, 55000);
  const result = calculateTrackerMetrics(fixture({ transactions }), now);
  assert.equal(result.duplicateTransactionCount, 1);
  assert.equal(result.completedContributionBeforeSoftwareCents, null);
});

test("past reporting gaps withhold cash and contribution instead of pretending zero", () => {
  const result = calculateTrackerMetrics(fixture(), new Date("2026-10-28T16:00:00-04:00"));
  assert.deepEqual(result.missingSpendDates, ["2026-10-27", "2026-10-28"]);
  assert.equal(result.cashAfterAdsAndDirectExpensesCents, null);
  assert.equal(result.completedContributionBeforeSoftwareCents, null);
});

test("voiding excludes a mistaken entry and restoring includes its original amount once", () => {
  const voidedDeposit = { ...payments[0], voidedAt: now.toISOString(), voidReason: "Entered twice" };
  const voided = calculateTrackerMetrics(fixture({ transactions: [voidedDeposit, ...payments.slice(1)] }), now);
  assert.equal(voided.cash.netMediaCents, 35000);
  assert.equal(voided.transactions.length, 3);
  assert.equal(voided.allProductionTransactions.length, 4);
  const restored = calculateTrackerMetrics(fixture({ transactions: [{ ...voidedDeposit, voidedAt: null }, ...payments.slice(1)] }), now);
  assert.equal(restored.cash.netMediaCents, 55000);
  assert.equal(restored.transactions.length, 4);
});

test("a real refund larger than recorded receipts remains visible but withholds contribution", () => {
  const transactions = [txn("deposit", "media_deposit", 20000), txn("refund", "media_refund", 25000), txn("cost", "direct_expense", 5000)];
  const result = calculateTrackerMetrics(fixture({ transactions }), now);
  assert.equal(result.cash.netMediaCents, -5000);
  assert.equal(result.unmatchedRefunds.length, 1);
  assert.equal(result.unmatchedRefunds[0].reference, "SBS-TEST");
  assert.equal(result.cashAfterAdsAndDirectExpensesCents, null);
  assert.equal(result.completedContributionBeforeSoftwareCents, null);
  assert.equal(result.completedContributionAfterSoftwareCents, null);
  assert.equal(result.depositBackedBookingCount, 0);
});

test("test or voided refund records do not falsely trigger reconciliation warnings", () => {
  const transactions = [...payments, txn("voided-refund", "media_refund", 999999, { voidedAt: now.toISOString() }), txn("test-refund", "media_refund", 999999, { inquiryId: "test-job" })];
  const result = calculateTrackerMetrics(fixture({ inquiries: [inquiry(), inquiry({ id: "test-job", isTest: true })], transactions }), now);
  assert.equal(result.unmatchedRefunds.length, 0);
  assert.equal(result.completedContributionAfterSoftwareCents, 12692);
});

test("test inquiries retain their descriptive ad source while remaining excluded from metrics", () => {
  const capturedTest = inquiry({ isTest: true, attribution: { campaign_id: settings.campaignId, ad_id: "120255494608960357" } });
  assert.equal(sourceLabel(capturedTest, settings), "Video ad · URL captured");
  assert.equal(campaignAttribution(capturedTest, settings), false);
  const reportedTest = inquiry({ isTest: true, source: "client_reported", sourceAdId: "120255494734630357", attribution: {} });
  assert.equal(sourceLabel(reportedTest, settings), "Photo ad · client reported");
  assert.equal(calculateTrackerMetrics(fixture({ inquiries: [capturedTest, reportedTest] }), now).campaignInquiryCount, 0);
});
