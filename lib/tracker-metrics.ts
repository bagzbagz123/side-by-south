export type InquiryStage = "new" | "qualified" | "quoted" | "booked" | "completed" | "lost" | "cancelled";
export type Coverage = "photo" | "film" | "both" | "unsure";
export type SourceConfidence = "captured_url" | "client_reported" | "unknown";
export type TransactionType = "media_deposit" | "media_balance" | "media_refund" | "direct_expense" | "decoration_receipt" | "partner_payout" | "software_expense";
export type PaymentMethod = "zelle" | "venmo" | "cash" | "bank_transfer" | "other";

export interface Inquiry {
  id: string;
  reference: string;
  createdAt: string;
  name: string;
  instagram: string;
  eventDate: string | null;
  flexibleDate?: boolean;
  eventLocation: string;
  coverage: Coverage;
  notes: string;
  stage: InquiryStage;
  quotedMediaCents: number | null;
  bookingDate: string | null;
  completedDate: string | null;
  source: SourceConfidence;
  sourceAdId?: string | null;
  attribution: Record<string, string | null | undefined>;
  plannedCostCents: number;
  actualCostsConfirmed: boolean;
  decorationSettled: boolean;
  isTest?: boolean;
}

export interface Transaction {
  id: string;
  inquiryId: string | null;
  occurredOn: string;
  type: TransactionType;
  amountCents: number;
  method: PaymentMethod;
  referenceNote: string;
  voidedAt?: string | null;
  voidReason?: string | null;
  auditEvents?: { id: string; action: string; reason: string; createdAt: string }[];
}

export interface SpendEntry {
  id: string;
  date: string;
  amountCents: number;
  verifiedAt: string;
  notes: string;
}

export interface TrackerSettings {
  campaignId: string;
  adSetId?: string;
  videoAdId?: string;
  photoAdId?: string;
  budgetCents: number;
  start: string;
  end: string;
  timezone?: string;
  monthlySoftwareCents: number;
  plannedCostCents: number;
  softwareBusinessUseShare?: number | null;
}

export interface TrackerData {
  inquiries: Inquiry[];
  transactions: Transaction[];
  spend: SpendEntry[];
  settings: TrackerSettings;
}

export const WEBSITE_VIDEO_AD_ID = "120255494608960357";
export const WEBSITE_PHOTO_AD_ID = "120255494734630357";
export const STAGE_LABELS: Record<InquiryStage, string> = {
  new: "New inquiry", qualified: "Qualified", quoted: "Quote sent", booked: "Booked", completed: "Completed", lost: "Lost", cancelled: "Cancelled",
};
export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  media_deposit: "Media deposit", media_balance: "Media balance payment", media_refund: "Media refund", direct_expense: "Direct shoot expense", decoration_receipt: "Decoration money received", partner_payout: "Decoration partner payout", software_expense: "Software payment",
};

export function money(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function localDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return `${parts.find(p => p.type === "year")?.value}-${parts.find(p => p.type === "month")?.value}-${parts.find(p => p.type === "day")?.value}`;
}

export function reportingDates(settings: TrackerSettings): string[] {
  const first = localDate(settings.start);
  const last = localDate(settings.end);
  if (!first || !last || last < first) return [];
  const dates: string[] = [];
  const day = new Date(`${first}T12:00:00Z`);
  while (day.toISOString().slice(0, 10) <= last && dates.length < 370) {
    dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

export function campaignAttribution(inquiry: Inquiry, settings: TrackerSettings): boolean {
  if (inquiry.isTest || inquiry.source === "unknown") return false;
  if (inquiry.attribution?.campaign_id === settings.campaignId) return true;
  const ad = inquiry.sourceAdId || inquiry.attribution?.ad_id;
  return inquiry.source === "client_reported" && [settings.videoAdId || WEBSITE_VIDEO_AD_ID, settings.photoAdId || WEBSITE_PHOTO_AD_ID].includes(ad || "");
}

export function sourceLabel(inquiry: Inquiry, settings: TrackerSettings): string {
  const ad = inquiry.sourceAdId || inquiry.attribution?.ad_id;
  const name = ad === (settings.videoAdId || WEBSITE_VIDEO_AD_ID) ? "Video ad" : ad === (settings.photoAdId || WEBSITE_PHOTO_AD_ID) ? "Photo ad" : "Campaign";
  const sourceMatchesCampaign = campaignAttribution({ ...inquiry, isTest: false }, settings);
  if (inquiry.source === "captured_url" && sourceMatchesCampaign) return `${name} · URL captured`;
  if (inquiry.source === "client_reported" && sourceMatchesCampaign) return `${name} · client reported`;
  if (inquiry.source === "captured_url") return "Other URL source";
  if (inquiry.source === "client_reported") return "Other · client reported";
  return "Unknown / unassigned";
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const found = new Set<string>();
  return rows.filter(row => {
    if (found.has(row.id)) return false;
    found.add(row.id);
    return true;
  });
}

function safeCents(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function inquiryMoney(inquiryId: string, transactions: Transaction[]) {
  const rows = uniqueById(transactions).filter(t => t.inquiryId === inquiryId && !t.voidedAt);
  const total = (type: TransactionType) => rows.filter(t => t.type === type).reduce((sum, t) => sum + safeCents(t.amountCents), 0);
  const mediaReceivedCents = total("media_deposit") + total("media_balance");
  const mediaRefundCents = total("media_refund");
  const decorationReceivedCents = total("decoration_receipt");
  const partnerPayoutCents = total("partner_payout");
  return {
    mediaReceivedCents, mediaRefundCents,
    netMediaCents: mediaReceivedCents - mediaRefundCents,
    directExpenseCents: total("direct_expense"),
    decorationReceivedCents, partnerPayoutCents,
    decorationBalanceCents: decorationReceivedCents - partnerPayoutCents,
  };
}

export function calculateTrackerMetrics(data: TrackerData, now = new Date()) {
  const inquiries = uniqueById(data.inquiries).filter(i => !i.isTest);
  const inquiryIds = new Set(inquiries.map(i => i.id));
  const productionTransactionRows = data.transactions.filter(t => t.inquiryId === null || inquiryIds.has(t.inquiryId));
  const allProductionTransactions = uniqueById(productionTransactionRows);
  const activeTransactionRows = productionTransactionRows.filter(t => !t.voidedAt);
  const transactions = uniqueById(activeTransactionRows);
  const attributed = inquiries.filter(i => campaignAttribution(i, data.settings));
  const completed = attributed.filter(i => i.stage === "completed");
  const booked = attributed.filter(i => ["booked", "completed"].includes(i.stage));
  const qualified = attributed.filter(i => ["qualified", "quoted", "booked", "completed"].includes(i.stage));
  const totalsFor = (rows: Inquiry[]) => rows.reduce((acc, i) => {
    const values = inquiryMoney(i.id, transactions);
    acc.netMediaCents += values.netMediaCents;
    acc.directExpenseCents += values.directExpenseCents;
    acc.decorationBalanceCents += values.decorationBalanceCents;
    acc.decorationReceivedCents += values.decorationReceivedCents;
    acc.partnerPayoutCents += values.partnerPayoutCents;
    return acc;
  }, { netMediaCents: 0, directExpenseCents: 0, decorationBalanceCents: 0, decorationReceivedCents: 0, partnerPayoutCents: 0 });
  const cash = totalsFor(attributed);
  const completedCash = totalsFor(completed);
  const dates = reportingDates(data.settings);
  const today = localDate(now);
  const requiredDates = dates.filter(d => d <= today);
  const spendByDate = new Map<string, SpendEntry>();
  for (const row of data.spend) {
    if (!dates.includes(row.date)) continue;
    const prior = spendByDate.get(row.date);
    if (!prior || row.verifiedAt >= prior.verifiedAt) spendByDate.set(row.date, row);
  }
  const spendRows = Array.from(spendByDate.values());
  const actualSpendCents = spendRows.length ? spendRows.reduce((sum, row) => sum + safeCents(row.amountCents), 0) : null;
  const missingSpendDates = requiredDates.filter(d => !spendByDate.has(d));
  const invalidMoneyRows = activeTransactionRows.filter(t => !Number.isSafeInteger(t.amountCents) || t.amountCents <= 0).length;
  const duplicateTransactionCount = activeTransactionRows.length - uniqueById(activeTransactionRows).length;
  const missingActualCosts = completed.filter(i => !i.actualCostsConfirmed);
  const unmatchedRefunds = inquiries.filter(i => {
    const values = inquiryMoney(i.id, transactions);
    return values.mediaRefundCents > values.mediaReceivedCents;
  });
  const unsettledDecoration = completed.filter(i => {
    const values = inquiryMoney(i.id, transactions);
    return (values.decorationReceivedCents > 0 || values.partnerPayoutCents > 0) && !i.decorationSettled;
  });
  const businessShare = data.settings.softwareBusinessUseShare;
  const softwareShareConfirmed = typeof businessShare === "number" && Number.isFinite(businessShare) && businessShare >= 0 && businessShare <= 1;
  const fullBusinessSoftwarePlanningCents = Math.round(safeCents(data.settings.monthlySoftwareCents) * 12 / 52);
  const allocatedSoftwareCents = softwareShareConfirmed ? Math.round(fullBusinessSoftwarePlanningCents * businessShare) : null;
  const contributionIssues: string[] = [];
  if (!completed.length) contributionIssues.push("No completed campaign jobs yet.");
  if (actualSpendCents === null) contributionIssues.push("Actual campaign spend has not been entered.");
  if (missingSpendDates.length) contributionIssues.push(`Spend is missing for ${missingSpendDates.length} reporting date${missingSpendDates.length === 1 ? "" : "s"}.`);
  if (missingActualCosts.length) contributionIssues.push(`Confirm actual costs for ${missingActualCosts.length} completed job${missingActualCosts.length === 1 ? "" : "s"}.`);
  if (unsettledDecoration.length) contributionIssues.push("Confirm partner payouts and decoration settlement for completed jobs.");
  if (invalidMoneyRows || duplicateTransactionCount) contributionIssues.push("Resolve invalid or duplicate money records.");
  if (unmatchedRefunds.length) contributionIssues.push("Refunds exceed recorded media receipts. Reconcile the payment history before using contribution totals.");
  const completedContributionBeforeSoftwareCents = contributionIssues.length ? null : completedCash.netMediaCents + completedCash.decorationBalanceCents - completedCash.directExpenseCents - (actualSpendCents ?? 0);
  const completedContributionAfterSoftwareCents = completedContributionBeforeSoftwareCents !== null && allocatedSoftwareCents !== null ? completedContributionBeforeSoftwareCents - allocatedSoftwareCents : null;
  const cashAfterAdsAndDirectExpensesCents = actualSpendCents === null || missingSpendDates.length || invalidMoneyRows || duplicateTransactionCount || unmatchedRefunds.length ? null : cash.netMediaCents + cash.decorationBalanceCents - cash.directExpenseCents - actualSpendCents;
  const depositBacked = booked.filter(i => inquiryMoney(i.id, transactions).netMediaCents > 0);
  const bookedValueCents = booked.reduce((sum, i) => sum + (i.quotedMediaCents == null ? 0 : safeCents(i.quotedMediaCents)), 0);
  const softwareCashPaidCents = transactions.filter(t => t.type === "software_expense" && t.occurredOn >= dates[0] && t.occurredOn <= dates[dates.length - 1]).reduce((sum, t) => sum + safeCents(t.amountCents), 0);
  return {
    inquiries, attributed, completed, booked, qualified, transactions, allProductionTransactions, cash, completedCash,
    allInquiryCount: inquiries.length, campaignInquiryCount: attributed.length,
    unattributedInquiryCount: inquiries.length - attributed.length,
    testInquiryCount: data.inquiries.filter(i => i.isTest).length,
    qualifiedCount: qualified.length, bookedCount: booked.length, completedCount: completed.length,
    depositBackedBookingCount: depositBacked.length, bookedValueCents,
    missingQuotedBookingCount: booked.filter(i => i.quotedMediaCents == null).length,
    dates, requiredDates, missingSpendDates, spendRows,
    actualSpendCents, spendCoverageComplete: actualSpendCents !== null && missingSpendDates.length === 0,
    remainingBudgetCents: actualSpendCents === null ? null : data.settings.budgetCents - actualSpendCents,
    costPerPaidBookingCents: actualSpendCents !== null && depositBacked.length ? Math.round(actualSpendCents / depositBacked.length) : null,
    cashAfterAdsAndDirectExpensesCents,
    completedContributionBeforeSoftwareCents, completedContributionAfterSoftwareCents,
    softwareShareConfirmed, allocatedSoftwareCents, fullBusinessSoftwarePlanningCents, softwareCashPaidCents,
    contributionIssues, missingActualCosts, unsettledDecoration, unmatchedRefunds, duplicateTransactionCount, invalidMoneyRows,
    reportingHasStarted: now.getTime() >= new Date(data.settings.start).getTime(),
    reportingHasEnded: now.getTime() >= new Date(data.settings.end).getTime(),
  };
}
