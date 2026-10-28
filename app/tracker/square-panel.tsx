"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { money } from "@/lib/tracker-metrics";
import { easternTimestamp } from "./cloud-status";

type QuoteInquiry = {
  id: string; reference: string; coverage: string; stage: string;
  quotedMediaCents: number | null; isTest?: boolean;
};
type Offer = { key: string; label: string; coverage: string; mediaCents: number; depositCents: number; availableFrom: string | null };
type Enrollment = { inquiryId: string; offerKey: string; acceptedQuoteReference: string; enabled: boolean };
type Receipt = {
  paymentId: string; status: "review" | "imported" | "ignored"; code: string; message?: string;
  amountCents: number; occurredOn: string; offerKey: string | null; reference: string | null;
  inquiryId: string | null; ledgerTransactionId: string | null;
};
type SquareState = {
  status: {
    connection: "setup_required" | "not_connected" | "connected" | "error";
    code: string; message?: string; lastAttemptAt: string | null; lastSuccessAt: string | null;
    lastStatus: string | null; coverageGap: string | boolean | null; pendingReviewCount: number;
    webhookConfigured?: boolean; lastWebhookReceivedAt?: string | null; lastWebhookSuccessAt?: string | null;
    lastWebhookStatus?: string | null; lastWebhookCode?: string | null; webhookAttentionCount?: number;
  };
  offers: Offer[]; enrollments: Enrollment[]; receipts: Receipt[];
  refunds?: { refundId: string; paymentId: string; status: string; code: string; message?: string; amountCents: number; occurredOn: string }[];
};

const connectionLabels = {
  setup_required: "Setup needed", not_connected: "Not connected", connected: "Connected", error: "Needs attention",
};

export default function SquarePanel({ inquiries, onRecordsChanged }: {
  inquiries: QuoteInquiry[]; onRecordsChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<SquareState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const lastSuccess = useRef<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/square", { cache: "no-store", credentials: "same-origin" });
    const result = await response.json().catch(() => ({ error: "Square status could not be read. Refresh to try again." }));
    if (!response.ok) throw new Error((result as { error?: string }).error || "Square status could not be read.");
    const next = result as SquareState;
    const receiptRevision = `${next.status.lastSuccessAt || ""}|${next.status.lastWebhookSuccessAt || ""}`;
    let deferLedgerRefresh = false;
    if (lastSuccess.current !== null && (next.status.lastSuccessAt || next.status.lastWebhookSuccessAt) && lastSuccess.current !== receiptRevision) {
      if (document.activeElement?.matches("input, textarea, select")) {
        deferLedgerRefresh = true;
        setNotice("Square has newer records. Finish your entry, then refresh the tracker to see them.");
      } else {
        await onRecordsChanged();
      }
    }
    if (!deferLedgerRefresh) lastSuccess.current = receiptRevision;
    setData(next);
  }, [onRecordsChanged]);
  useEffect(() => {
    let active = true;
    load().catch(err => active && setError(err instanceof Error ? err.message : "Square status could not be read."));
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load().catch(err => active && setError(err instanceof Error ? err.message : "Square status is out of date. Refresh to try again."));
    }, 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, [load]);

  async function act(action: string, payload: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/square", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      const result = await response.json().catch(() => ({ error: "The request could not be confirmed. Refresh Square status before trying again." }));
      if (!response.ok) throw new Error((result as { error?: string }).error || "The Square update could not be confirmed.");
      const outcome = result as { status?: string; message?: string };
      if (outcome.status === "error" || outcome.status === "setup_required") throw new Error(outcome.message || "Square could not finish this check. Review the connection status and try again.");
      await load();
      await onRecordsChanged();
      setNotice(action === "sync" ? "Square check finished. Review the status and any payments below. Reservation status has not changed." : "Saved. Reservation confirmations remain manual.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Square update could not be confirmed.");
      return false;
    } finally { setBusy(false); }
  }

  const liveInquiries = inquiries.filter(i => !i.isTest && !["lost", "cancelled"].includes(i.stage));
  const inquiry = liveInquiries.find(i => i.id === selected);
  const enabled = data?.enrollments.filter(e => e.enabled) || [];
  const eligibleOffers = data?.offers.filter(o => !o.availableFrom || Date.parse(o.availableFrom) <= Date.now()) || [];
  const reviews = data?.receipts.filter(r => r.status === "review") || [];
  const refundReviews = data?.refunds?.filter(r => r.status === "review") || [];
  const recent = data?.receipts.filter(r => r.status === "imported").slice(0, 5) || [];

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("digitalOnly") !== "on") { setError("Confirm that the entire accepted quote is digital media only."); return; }
    await act("enrollQuote", {
      inquiryId: selected, offerKey: String(form.get("offerKey") || ""),
      acceptedQuoteReference: String(form.get("acceptedQuoteReference") || "").trim(), digitalOnly: true,
    });
  }

  return <section className="tracker-panel square-panel" aria-labelledby="square-title" id="square-deposits">
    <div className="square-heading">
      <div><h2 id="square-title">Square deposits</h2><p>Verified payments can update the ledger. You still confirm each reservation.</p></div>
      <span className="square-connection">{data ? connectionLabels[data.status.connection] : "Checking connection"}</span>
    </div>
    <div aria-live="polite">
      {error && <p className="square-notice square-error" role="alert">{error}</p>}
      {notice && <p className="square-notice">{notice}</p>}
    </div>
    {!data && !error && <p className="tracker-note" role="status">Loading your private Square connection status…</p>}
    {!data && error && <button type="button" className="tracker-quiet" onClick={() => { setError(""); load().catch(err => setError(err.message)); }}>Refresh Square status</button>}
    {data && <>
      <div className="square-summary">
        <dl><div><dt>Last complete payment scan</dt><dd>{easternTimestamp(data.status.lastSuccessAt)}</dd></div><div><dt>Last attempt</dt><dd>{easternTimestamp(data.status.lastAttemptAt)}</dd></div><div><dt>Payments needing review</dt><dd>{data.status.pendingReviewCount}</dd></div></dl>
        <div className="square-actions">
          {data.status.connection !== "setup_required" && data.status.connection !== "connected" && <a className="tracker-primary tracker-link" href="/api/square/connect" target="_top">Connect Square</a>}
          <button type="button" className="tracker-quiet" disabled={busy || data.status.connection !== "connected"} onClick={() => act("sync", {})}>{busy ? "Working…" : "Check payments now"}</button>
          <button type="button" className="tracker-quiet" disabled={busy} onClick={() => { setError(""); load().catch(err => setError(err.message)); }}>Refresh status</button>
        </div>
      </div>
      {data.status.message && <p className="tracker-note">{data.status.message}</p>}
      <div className="square-direct-status">
        <h3>Direct Square updates</h3>
        <p className="tracker-note">{data.status.webhookConfigured ? "The notification signing key is configured. Square can send payment updates directly to this tracker, without an AI task or an open computer." : "Direct payment notifications are not configured yet. Use Check payments now for a verified scan while setup is completed."}</p>
        {data.status.webhookConfigured && <p className="tracker-note">Last authenticated notification: {easternTimestamp(data.status.lastWebhookReceivedAt || null)}. Last completed notification processing: {easternTimestamp(data.status.lastWebhookSuccessAt || null)}.</p>}
        {!!data.status.webhookAttentionCount && <p className="square-notice square-error">Some direct notifications need attention. Square retries temporary failures; use Check payments now to reconcile receipts. Existing records and booking status are retained.</p>}
      </div>
      {data.status.connection === "setup_required" && <p className="square-notice">Square connection setup is not complete. No Square payments are being imported yet.</p>}
      {data.status.coverageGap && <p className="square-notice square-error">The last scan is incomplete. Earlier verified receipts are kept; missing payments are not assumed to be zero. Check the connection, then run another check.</p>}
      <p className="tracker-note">Only approved, standalone digital-media quotes are eligible. Decoration and physical-product orders stay on hold. Imported receipts are gross payments, not bank payouts or earned profit.</p>

      <details className="square-quote-details">
        <summary>Approve a quote for deposit matching</summary>
        <p className="tracker-note">Confirm the agreed media price in Inquiries & bookings first. Approval here permits payment matching only; it does not reserve a date.</p>
        {liveInquiries.length === 0 ? <p className="square-empty">Add a real inquiry and its accepted media quote before enabling automatic matching.</p> : <>
          <label className="square-select-label">Inquiry reference<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose an inquiry</option>{liveInquiries.map(i => <option key={i.id} value={i.id}>{i.reference} · {i.coverage === "both" ? "Photo + film" : i.coverage} · {i.quotedMediaCents === null ? "Quote needed" : money(i.quotedMediaCents)}</option>)}</select></label>
          {inquiry && <form className="tracker-form" onSubmit={enroll} key={inquiry.id}>
            <label>Accepted digital-media offer<select name="offerKey" required defaultValue=""><option value="">Choose the matching offer</option>{eligibleOffers.filter(o => o.mediaCents === inquiry.quotedMediaCents && (inquiry.coverage === "unsure" || o.coverage === inquiry.coverage)).map(o => <option key={o.key} value={o.key}>{o.label} · {money(o.mediaCents)} · {money(o.depositCents)} deposit</option>)}</select></label>
            <label>Accepted quote ID / revision<input name="acceptedQuoteReference" maxLength={160} required placeholder="Your agreed quote reference" defaultValue={enabled.find(e => e.inquiryId === inquiry.id)?.acceptedQuoteReference || ""} /></label>
            <label className="tracker-checkbox full"><input name="digitalOnly" type="checkbox" required />I confirm the entire accepted quote is digital media only, with no decoration, prints, albums, drives or other physical products.</label>
            <p className="tracker-note full">Ask the client to enter <strong>{inquiry.reference}</strong> in Square’s “Booking or quote reference” field. A name or matching amount alone will not attach a payment.</p>
            <div className="tracker-form-action"><button className="tracker-primary" disabled={busy}>Enable matching for this quote</button></div>
          </form>}
        </>}
        {enabled.length > 0 && <ul className="square-enrollments">{enabled.map(e => <li key={e.inquiryId}><div><strong>{inquiries.find(i => i.id === e.inquiryId)?.reference || "Inquiry"}</strong><span>{data.offers.find(o => o.key === e.offerKey)?.label || "Digital-media offer"} · quote {e.acceptedQuoteReference}</span></div><button type="button" className="tracker-quiet" disabled={busy} onClick={() => act("disableQuote", { inquiryId: e.inquiryId })}>Pause matching</button></li>)}</ul>}
      </details>

      <div className="square-review">
        <h3>Payments needing a match</h3>
        {reviews.length === 0 && refundReviews.length === 0 ? <p className="square-empty">No payments are waiting for review. New verified deposits will appear in the ledger when they match an approved quote.</p> : <>
          {reviews.map(r => <article className="square-review-row" key={r.paymentId}>
            <div><strong>{money(r.amountCents)} · {r.reference || "Reference not confirmed"}</strong><p>{r.message || "This receipt needs owner review before it can enter the booking ledger."}</p><small>{r.occurredOn} · Square payment ending {r.paymentId.slice(-8)}</small></div>
            <form className="square-match-form" onSubmit={async event => { event.preventDefault(); const id = String(new FormData(event.currentTarget).get("inquiryId") || ""); if (id) await act("mapReceipt", { paymentId: r.paymentId, inquiryId: id }); }}>
              <label>Approved inquiry<select name="inquiryId" required defaultValue=""><option value="">Choose a matching quote</option>{enabled.filter(e => !r.offerKey || e.offerKey === r.offerKey).map(e => <option key={e.inquiryId} value={e.inquiryId}>{inquiries.find(i => i.id === e.inquiryId)?.reference || "Inquiry"} · {e.acceptedQuoteReference}</option>)}</select></label>
              <button className="tracker-quiet" disabled={busy || enabled.length === 0}>Match receipt</button>
            </form>
            <button type="button" className="square-text-button" disabled={busy} onClick={() => act("ignoreReceipt", { paymentId: r.paymentId })}>Ignore for this ledger</button>
          </article>)}
          {refundReviews.map(r => <div className="square-review-row" key={r.refundId}><strong>Refund · {money(r.amountCents)}</strong><p>{r.message || "This refund needs review. Resolve the original deposit match, then check payments again."}</p><small>{r.occurredOn} · refund ending {r.refundId.slice(-8)}</small></div>)}
        </>}
        <p className="tracker-note">Matching or ignoring a receipt does not charge, refund, contact a client or confirm a reservation. Existing manual receipts must be reconciled before another copy can be added.</p>
      </div>
      {recent.length > 0 && <details className="square-recent"><summary>Recent imported deposits</summary><ul>{recent.map(r => <li key={r.paymentId}><span>{r.reference || inquiries.find(i => i.id === r.inquiryId)?.reference || "Matched inquiry"} · {r.occurredOn}</span><strong>{money(r.amountCents)}</strong><small>Receipt imported; reservation status remains yours to confirm.</small></li>)}</ul></details>}
    </>}
  </section>;
}
