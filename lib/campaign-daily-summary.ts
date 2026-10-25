import { calculateTrackerMetrics, campaignAttribution, inquiryMoney, localDate, reportingDates, type Inquiry, type SpendEntry, type TrackerData, type Transaction } from "@/lib/tracker-metrics";
import { readTracker } from "@/lib/tracker-store";

const TIMEZONE = "America/New_York";
const MONEY_LIMIT = 100000000;
export class DailySummaryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "DailySummaryError"; }
}
function calendarDay(day: string, difference: number): string {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + difference);
  return value.toISOString().slice(0, 10);
}
// Resolve local midnight instead of subtracting 24 hours across DST changes.
export function easternDayStart(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const wanted = Date.UTC(year, month - 1, date);
  let epoch = wanted;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let iteration = 0; iteration < 3; iteration++) {
    const parts = formatter.formatToParts(new Date(epoch));
    const part = (type: string) => Number(parts.find(value => value.type === type)?.value);
    const displayed = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    epoch += wanted - displayed;
  }
  return epoch;
}
function dayEnd(day: string): number { return easternDayStart(calendarDay(day, 1)); }
function validDay(day: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T12:00:00Z`)) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day; }
function unique<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
function spendSummary(rows: SpendEntry[], expectedDates: string[], now: Date) {
  const eligible = new Map<string, SpendEntry>();
  for (const row of rows) {
    const observed = Date.parse(row.verifiedAt);
    if (!expectedDates.includes(row.date) || !Number.isSafeInteger(row.amountCents) || row.amountCents < 0 || row.amountCents > MONEY_LIMIT || !Number.isFinite(observed) || observed > now.getTime()) continue;
    const prior = eligible.get(row.date);
    if (!prior || observed > Date.parse(prior.verifiedAt)) eligible.set(row.date, row);
  }
  const observedDates = expectedDates.filter(day => eligible.has(day));
  const confirmedDates = observedDates.filter(day => Date.parse(eligible.get(day)!.verifiedAt) >= dayEnd(day));
  const provisionalDates = observedDates.filter(day => !confirmedDates.includes(day));
  const missingDates = expectedDates.filter(day => !eligible.has(day));
  const lastVerifiedAt = eligible.size ? new Date(Math.max(...Array.from(eligible.values(), row => Date.parse(row.verifiedAt)))).toISOString() : null;
  return {
    applicable: expectedDates.length > 0,
    reportedCents: eligible.size ? Array.from(eligible.values()).reduce((sum, row) => sum + row.amountCents, 0) : null,
    expectedDates, observedDates, confirmedDates, missingDates, provisionalDates,
    coverageComplete: expectedDates.length > 0 && !missingDates.length && !provisionalDates.length,
    lastVerifiedAt,
    freshness: !expectedDates.length ? "not_applicable" : missingDates.length ? (eligible.size ? "partial" : "missing") : provisionalDates.length ? "provisional" : "reported_after_day_close",
    valuesAreRecordedObservations: true,
  };
}
function cash(rows: Transaction[]) {
  const sum = (type: string) => rows.filter(row => row.type === type).reduce((total, row) => total + row.amountCents, 0);
  const mediaReceivedCents = sum("media_deposit") + sum("media_balance");
  const mediaRefundedCents = sum("media_refund");
  return { mediaReceivedCents, mediaRefundedCents, netMediaCents: mediaReceivedCents - mediaRefundedCents, directExpenseCents: sum("direct_expense"), decorationReceivedCents: sum("decoration_receipt"), partnerPayoutCents: sum("partner_payout") };
}

export function buildCampaignDailySummary(data: TrackerData, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new DailySummaryError("invalid_report_time", "The report time is invalid.");
  if (data.inquiries.length >= 5000 || data.transactions.length >= 10000 || data.spend.length >= 100) throw new DailySummaryError("summary_record_limit", "The tracker record limit prevents a complete daily summary. Totals are withheld.");
  const today = localDate(now);
  const reportDate = calendarDay(today, -1);
  const firstCampaignDate = localDate(data.settings.start);
  const campaignDates = reportingDates(data.settings);
  const inquiries = unique(data.inquiries).filter(inquiry => !inquiry.isTest && Number.isFinite(Date.parse(inquiry.createdAt)) && Date.parse(inquiry.createdAt) <= now.getTime());
  const inquiryIds = new Set(inquiries.map(inquiry => inquiry.id));
  const campaignIds = new Set(inquiries.filter(inquiry => campaignAttribution(inquiry, data.settings)).map(inquiry => inquiry.id));
  const activeProductionRows = data.transactions.filter(row => !row.voidedAt && (row.inquiryId === null || inquiryIds.has(row.inquiryId)));
  if (activeProductionRows.some(row => !validDay(row.occurredOn))) throw new DailySummaryError("invalid_money_records", "Reconcile invalid money dates before using the daily summary.");
  const productionRows = activeProductionRows.filter(row => row.occurredOn <= today);
  if (productionRows.some(row => !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0 || row.amountCents > MONEY_LIMIT)) throw new DailySummaryError("invalid_money_records", "Reconcile invalid money records before using the daily summary.");
  const transactions = unique(productionRows);
  const paid = inquiries.filter(inquiry => ["booked", "completed"].includes(inquiry.stage) && inquiryMoney(inquiry.id, transactions).netMediaCents > 0).map(inquiry => ({ inquiry, firstPaymentDate: transactions.filter(row => row.inquiryId === inquiry.id && ["media_deposit", "media_balance"].includes(row.type)).map(row => row.occurredOn).sort()[0] }));
  const activity = (fromDate: string, throughDate: string) => {
    const inPeriod = (day: string) => day >= fromDate && day <= throughDate;
    const newInquiries = inquiries.filter(inquiry => inPeriod(localDate(inquiry.createdAt)));
    const newlyFunded = paid.filter(item => item.firstPaymentDate && inPeriod(item.firstPaymentDate));
    const rows = transactions.filter(row => inPeriod(row.occurredOn));
    const splitCount = (values: Inquiry[]) => ({ campaign: values.filter(inquiry => campaignIds.has(inquiry.id)).length, otherOrUnknown: values.filter(inquiry => !campaignIds.has(inquiry.id)).length });
    return {
      inquiries: splitCount(newInquiries),
      newPaidBookings: splitCount(newlyFunded.map(item => item.inquiry)),
      campaignCash: cash(rows.filter(row => !!row.inquiryId && campaignIds.has(row.inquiryId))),
      otherOrUnknownCash: cash(rows.filter(row => !!row.inquiryId && !campaignIds.has(row.inquiryId))),
      softwareCashPaidCents: rows.filter(row => row.type === "software_expense").reduce((total, row) => total + row.amountCents, 0),
    };
  };
  const currentDates = campaignDates.filter(day => day <= today);
  const currentSpend = spendSummary(data.spend, currentDates, now);
  const validCurrentSpend = data.spend.filter(row => currentSpend.observedDates.includes(row.date) && Number.isSafeInteger(row.amountCents) && row.amountCents >= 0 && row.amountCents <= MONEY_LIMIT && Number.isFinite(Date.parse(row.verifiedAt)) && Date.parse(row.verifiedAt) <= now.getTime());
  const currentInquiries = inquiries.map(inquiry => inquiry.stage === "completed" && inquiry.completedDate && inquiry.completedDate > today ? { ...inquiry, stage: "booked" as const } : inquiry);
  const metrics = calculateTrackerMetrics({ ...data, inquiries: currentInquiries, transactions: productionRows, spend: validCurrentSpend }, now);
  const issues = [...metrics.contributionIssues];
  if (currentSpend.provisionalDates.length) issues.push("Daily spend observations made before the reporting day ended remain provisional.");
  const missingCompletionDates = currentInquiries.filter(inquiry => campaignIds.has(inquiry.id) && inquiry.stage === "completed" && (!inquiry.completedDate || !validDay(inquiry.completedDate))).length;
  if (missingCompletionDates) issues.push("Confirm completion dates for completed campaign jobs.");
  const completedIds = new Set(currentInquiries.filter(inquiry => campaignIds.has(inquiry.id) && inquiry.stage === "completed").map(inquiry => inquiry.id));
  if (data.transactions.some(row => !row.voidedAt && !!row.inquiryId && completedIds.has(row.inquiryId) && row.occurredOn > today)) issues.push("Future-dated money records for completed jobs must be reconciled before contribution is reported.");
  const contributionSafe = !issues.length && currentSpend.coverageComplete;
  const currentPaidBookings = { campaign: paid.filter(item => campaignIds.has(item.inquiry.id)).length, otherOrUnknown: paid.filter(item => !campaignIds.has(item.inquiry.id)).length };
  return {
    status: "ok", generatedAt: now.toISOString(), timezone: TIMEZONE, currency: "USD", reportDate,
    campaign: { id: data.settings.campaignId, start: data.settings.start, end: data.settings.end, budgetCents: data.settings.budgetCents, phase: now.getTime() < Date.parse(data.settings.start) ? "not_started" : now.getTime() >= Date.parse(data.settings.end) ? "ended" : "running" },
    daily: { date: reportDate, ...activity(reportDate, reportDate), adSpend: spendSummary(data.spend, campaignDates.includes(reportDate) ? [reportDate] : [], now) },
    campaignToDate: {
      fromDate: firstCampaignDate, throughDate: today, asOf: now.toISOString(), ...activity(firstCampaignDate, today), currentPaidBookings, adSpend: currentSpend,
      completedJobContribution: {
        asOf: now.toISOString(), completedJobs: metrics.completedCount,
        beforeSoftwareCents: contributionSafe ? metrics.completedContributionBeforeSoftwareCents : null,
        afterSoftwareCents: contributionSafe ? metrics.completedContributionAfterSoftwareCents : null,
        softwareBusinessUseShare: metrics.softwareShareConfirmed ? data.settings.softwareBusinessUseShare : null,
        fullCampaignWeeklyAllocationCents: metrics.allocatedSoftwareCents,
        fullBusinessWeeklyPlanningCents: metrics.fullBusinessSoftwarePlanningCents,
        softwareAllocationConfirmed: metrics.softwareShareConfirmed,
        issues: [...new Set(issues)],
        label: "Completed-job contribution before owner labor and tax; deposits are not profit.",
      },
    },
    dataNotes: [
      "Yesterday contains recorded activity only. Campaign-to-date contribution and paid-booking counts use current records as of generatedAt, not a historical snapshot.",
      "New paid bookings count each currently booked/completed inquiry once on its earliest active media deposit or balance date, only while current net media receipts remain positive. A later balance is not a second booking.",
      "Current paid bookings are distinct currently booked/completed inquiries with positive net media receipts; this is separate from newly funded bookings in a date range.",
      "Test inquiries, their linked money and voided entries are excluded. Other or unknown inquiry sources are separated from campaign attribution.",
      "Payments and costs are manually confirmed by the owner; bank accounts are not connected. Backdated entries, stage changes, refunds and corrections can revise a report.",
      "Missing or future spend observations remain unknown. Observations made before a local day ended are provisional, and Meta may later restate spend.",
      "Decoration receipts are pass-through cash until partner settlement is confirmed. Deposits, cash movements and quoted booking values are not net profit.",
      "Software cash payments are shown separately from the full-campaign weekly overhead allocation, which is unavailable until business-use share is confirmed; neither is deducted twice.",
      "Date-only money entries cannot establish transaction times within the campaign's partial first and last calendar days.",
    ],
  };
}

export async function getCampaignDailySummary(now = new Date()) {
  const summary = buildCampaignDailySummary(await readTracker() as unknown as TrackerData, now);
  console.info("campaign_daily_summary_generated", { reportDate: summary.reportDate, generatedAt: summary.generatedAt });
  return summary;
}
