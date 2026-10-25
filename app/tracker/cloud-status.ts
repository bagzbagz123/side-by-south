export interface CloudTrackingStatus {
  tokenConfigured: boolean;
  spendSource: string;
  status: "setup_required" | "not_started" | "ready" | "syncing" | "synced" | "incomplete" | "error";
  setupReason: "missing_token" | null;
  lastAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastResultCode: string | null;
  importedDayCount: number;
  monitorState: "unverified";
  pendingInquiryAlerts: number;
  reportedInquiryAlerts: number;
  lastInquiryAlertReportedAt?: string | null;
  lastAlertResultCode?: string | null;
  lastInquiryScanAt?: string | null;
  lastInquiryScanStatus?: string | null;
  lastInquiryScanResultCode?: string | null;
  lastInquiryScanAlertCount?: number | null;
  alertDeliverySemantics: "reported_intent_not_delivery_confirmation";
}

export function hasConfirmedSync(status: CloudTrackingStatus): boolean {
  return Boolean(status.lastSuccessfulSyncAt && Number.isFinite(Date.parse(status.lastSuccessfulSyncAt)));
}

export function cloudStatusSummary(status?: CloudTrackingStatus): { headline: string; detail: string; needsAttention: boolean } {
  if (!status) return { headline: "Cloud status unavailable", detail: "No cloud configuration or successful run has been confirmed here. Financial records remain separate from this status.", needsAttention: true };
  if (!status.tokenConfigured || status.setupReason === "missing_token" || status.status === "setup_required") return { headline: "Setup required", detail: "Automatic spend import needs a Meta read connection. You can still enter verified spend manually; no credentials are entered on this page.", needsAttention: true };
  if (status.status === "error" || status.status === "incomplete") return { headline: "Spend import needs attention", detail: "The latest attempt did not confirm a complete import. Review the recorded daily totals before using them.", needsAttention: true };
  if (status.status === "not_started") return { headline: "Campaign not started", detail: "The connection is configured, but future reporting dates remain blank. A scheduled check is not proof of a successful spend import.", needsAttention: false };
  if (status.status === "syncing") return { headline: "Spend import in progress", detail: "The current attempt has not yet confirmed success. Any earlier successful import is shown separately below.", needsAttention: false };
  if (status.status === "synced" && hasConfirmedSync(status)) return { headline: "Spend import recorded", detail: "A successful import has been recorded. This does not by itself verify a recurring schedule or notification delivery.", needsAttention: false };
  return { headline: "Awaiting a confirmed spend import", detail: "The Meta connection is configured. No completed import is confirmed by the available status evidence.", needsAttention: false };
}

export function easternTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not confirmed";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}
