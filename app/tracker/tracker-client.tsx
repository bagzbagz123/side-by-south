"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  calculateTrackerMetrics, Inquiry, InquiryStage, inquiryMoney, localDate, money,
  PaymentMethod, sourceLabel, SpendEntry, STAGE_LABELS, TrackerData, TrackerSettings,
  Transaction, TRANSACTION_LABELS, TransactionType, WEBSITE_PACKAGE_AD_ID, WEBSITE_PHOTO_AD_ID, WEBSITE_VIDEO_AD_ID,
} from "@/lib/tracker-metrics";
import { CloudTrackingStatus, cloudStatusSummary, easternTimestamp } from "./cloud-status";

type View = "dashboard" | "pipeline" | "payments" | "spend";
type Save = (action: string, payload: Record<string, unknown>) => Promise<boolean>;
type CloudTrackerData = TrackerData & { cloudStatus?: CloudTrackingStatus };
const views: { id: View; label: string }[] = [{ id: "dashboard", label: "Overview" }, { id: "pipeline", label: "Inquiries & bookings" }, { id: "payments", label: "Payments & costs" }, { id: "spend", label: "Ad spend" }];
const packageNames = { photo: "Photography", film: "Film", both: "Photo + film", unsure: "To be decided" };

function dollarsToCents(value: FormDataEntryValue | null, allowEmpty = false): number | null {
  const text = String(value ?? "").trim();
  if (!text && allowEmpty) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("Enter a valid USD amount with up to two decimal places.");
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error("That amount is too large.");
  return cents;
}

function displayDate(date: string | null | undefined): string {
  if (!date) return "Not set";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(date.length === 10 ? `${date}T12:00:00-04:00` : date));
}

function downloadCSV(name: string, rows: unknown[][]) {
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const file = new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = href; link.download = name; link.click();
  URL.revokeObjectURL(href);
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="tracker-stat"><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

export default function TrackerClient() {
  const [data, setData] = useState<CloudTrackerData | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTests, setShowTests] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/tracker", { cache: "no-store", credentials: "same-origin" });
      const result = await response.json() as CloudTrackerData & { error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to load your tracker.");
      setData(result); setRevision(value => value + 1);
    } catch (err) {
      setData(null);
      throw err;
    }
  }, []);
  useEffect(() => {
    let active = true;
    load().catch(err => active && setError(err.message)).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [load]);
  const save: Save = async (action, payload) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/tracker", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The change could not be saved.");
      await load(); setNotice(action === "addTransaction" ? "Money record saved. Confirm transfers in your payment app; this is a manual ledger." : "Saved.");
      return true;
    } catch (err) { setError(err instanceof Error ? err.message : "The change could not be saved."); return false; }
    finally { setBusy(false); }
  };
  const metrics = useMemo(() => data ? calculateTrackerMetrics(data) : null, [data]);
  const visibleInquiries = data?.inquiries.filter(i => (showTests || !i.isTest) && `${i.name} ${i.instagram} ${i.reference} ${i.eventLocation}`.toLowerCase().includes(search.toLowerCase())) || [];

  return <main className="sbs-tracker">
    <header className="tracker-header"><div><a className="tracker-brand" href="/">SIDE BY SOUTH<span>Miami · Photo & film</span></a></div><div className="tracker-header-actions"><span className="private-label">Owner only</span><button type="button" className="tracker-quiet" disabled={busy || loading} onClick={() => { setLoading(true); setError(""); load().catch(err => setError(err.message)).finally(() => setLoading(false)); }}>Refresh</button></div></header>
    <div className="tracker-title"><p className="tracker-kicker">Your campaign, accounted for.</p><h1>From the first inquiry<br />to the money received.</h1><p>Campaign records for October 25–November 1, 2026. All reporting dates use Eastern Time.</p></div>
    <nav className="tracker-tabs" aria-label="Tracker views">{views.map(item => <button type="button" key={item.id} aria-current={view === item.id ? "page" : undefined} onClick={() => { setView(item.id); setNotice(""); }}>{item.label}</button>)}</nav>
    <div aria-live="polite">{error && <p className="tracker-message tracker-error" role="alert">{error}</p>}{notice && <p className="tracker-message">{notice}</p>}</div>
    {loading && !data && <p className="tracker-empty">Loading your private records…</p>}
    {!loading && !data && <div className="tracker-empty"><h2>The tracker could not load.</h2><p>Check the message above, then refresh. No records are displayed without owner access.</p></div>}
    {data && metrics && <>
      {metrics.unmatchedRefunds.length > 0 && <p className="tracker-message tracker-error" role="alert">Refunds exceed recorded receipts for {metrics.unmatchedRefunds.map(i => i.reference).join(", ")}. Reconcile the original payments and refunds; cash contribution totals are withheld. Record only money that actually moved.</p>}
      {view === "dashboard" && <section className="tracker-view" aria-label="Campaign overview">
        <div className="tracker-section-heading"><div><h2>The week at a glance</h2><p>Only inquiries tied to this exact campaign appear in the campaign totals.</p></div><span className="tracker-budget">{money(data.settings.budgetCents)} total ad budget</span></div>
        <div className="tracker-stats">
          <Stat label="Campaign inquiries" value={metrics.campaignInquiryCount} detail={`${metrics.qualifiedCount} qualified · ${metrics.unattributedInquiryCount} other / unknown`} />
          <Stat label="Bookings with money received" value={metrics.depositBackedBookingCount} detail={`${metrics.completedCount} completed jobs`} />
          <Stat label="Net media cash collected" value={money(metrics.cash.netMediaCents)} detail="Deposits + balances − refunds" />
          <Stat label="Actual ad spend" value={money(metrics.actualSpendCents)} detail={metrics.actualSpendCents === null ? "No spend report entered yet" : `${metrics.spendRows.length} reporting date(s) entered`} />
          <Stat label="Ad cost per paid booking" value={money(metrics.costPerPaidBookingCents)} detail="Actual spend ÷ deposit-backed bookings" />
          <Stat label="Booked media value" value={money(metrics.bookedValueCents)} detail={metrics.missingQuotedBookingCount ? `${metrics.missingQuotedBookingCount} booking(s) need a media quote` : "Contract value; not collected revenue"} />
        </div>
        <CloudStatusPanel status={data.cloudStatus} />
        <div className="tracker-two-column">
          <article className="tracker-panel"><p className="tracker-kicker">Cash movement · campaign inquiries</p><h2>What has come in?</h2><dl className="tracker-calculation"><div><dt>Net media payments</dt><dd>{money(metrics.cash.netMediaCents)}</dd></div><div><dt>Decoration money received</dt><dd>{money(metrics.cash.decorationReceivedCents)}</dd></div><div><dt>Partner payouts recorded</dt><dd>− {money(metrics.cash.partnerPayoutCents)}</dd></div><div><dt>Direct expenses recorded</dt><dd>− {money(metrics.cash.directExpenseCents)}</dd></div><div><dt>Actual ad spend</dt><dd>{metrics.actualSpendCents === null ? "Not entered" : `− ${money(metrics.actualSpendCents)}`}</dd></div><div className="total"><dt>Cash after ads & direct payments</dt><dd>{money(metrics.cashAfterAdsAndDirectExpensesCents)}</dd></div></dl><p className="tracker-note">This cash balance can include deposits owed toward future shoots and unsettled decoration money. It is not earned profit. Software cash payments are shown separately below.</p></article>
          <article className="tracker-panel"><p className="tracker-kicker">Completed campaign jobs only</p><h2>What have we kept?</h2><dl className="tracker-calculation"><div><dt>Net media cash on completed jobs</dt><dd>{money(metrics.completedCash.netMediaCents)}</dd></div><div><dt>Settled decoration spread</dt><dd>{metrics.unsettledDecoration.length ? "Settlement pending" : money(metrics.completedCash.decorationBalanceCents)}</dd></div><div><dt>Actual completed-job costs</dt><dd>{metrics.missingActualCosts.length ? "Confirmation needed" : `− ${money(metrics.completedCash.directExpenseCents)}`}</dd></div><div><dt>Actual campaign ad spend</dt><dd>{money(metrics.actualSpendCents)}</dd></div><div><dt>Weekly software allocation</dt><dd>{metrics.allocatedSoftwareCents === null ? "Business share not confirmed" : `− ${money(metrics.allocatedSoftwareCents)}`}</dd></div><div className="total"><dt>Completed-job contribution</dt><dd>{money(metrics.completedContributionAfterSoftwareCents)}</dd></div></dl>{metrics.contributionIssues.length > 0 && <ul className="tracker-checks">{metrics.contributionIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>}<p className="tracker-note">Cash-basis contribution after the full campaign spend and a weekly overhead allocation. Owner labor, taxes, fees and any unrecorded costs still need accounting; this is not verified net profit.</p></article>
        </div>
        <div className="tracker-two-column"><article className="tracker-panel"><h2>Keep the trail intact.</h2><ol className="tracker-steps"><li>Website forms retain their ad reference automatically. Add Instagram-only inquiries manually.</li><li>When a date is agreed, mark the inquiry Booked and record the actual deposit.</li><li>Add balances, refunds and costs as separate money records. Mark the job Completed after delivery.</li><li>Confirm actual job costs and partner settlement. Review actual Meta spend in Ad spend.</li></ol><p className="tracker-note">Captured URLs and client reports are attribution evidence, not proof the ad caused the booking. Unknown sources remain separate. Test inquiries never enter headline totals.</p></article><SoftwareSettings key={`settings-${revision}`} data={data} metrics={metrics} busy={busy} save={save} onError={setError} /></div>
        {(metrics.duplicateTransactionCount > 0 || metrics.invalidMoneyRows > 0) && <p className="tracker-message tracker-error">Some money records are invalid or duplicated. Contribution is withheld until they are resolved.</p>}
      </section>}

      {view === "pipeline" && <section className="tracker-view" aria-label="Inquiry and booking pipeline"><div className="tracker-section-heading"><div><h2>Inquiries & bookings</h2><p>Each inquiry keeps one reference from first contact through delivery.</p></div><button type="button" className="tracker-quiet" onClick={() => downloadCSV("side-by-south-inquiries.csv", [["Inquiry ID", "Reference", "Created", "Name", "Instagram", "Event date", "Location", "Coverage", "Stage", "Quoted media USD", "Source", "Campaign ID", "Ad ID", "Is test"], ...data.inquiries.filter(i => showTests || !i.isTest).map(i => [i.id, i.reference, i.createdAt, i.name, i.instagram, i.eventDate, i.eventLocation, i.coverage, i.stage, i.quotedMediaCents === null ? "" : i.quotedMediaCents / 100, i.source, i.attribution?.campaign_id, i.sourceAdId || i.attribution?.ad_id, Boolean(i.isTest)])])}>Export inquiries CSV</button></div>
        <ManualInquiryForm busy={busy} settings={data.settings} save={save} onError={setError} />
        <div className="tracker-filter"><label>Find a client<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, Instagram, reference or location" /></label><label className="tracker-checkbox"><input type="checkbox" checked={showTests} onChange={e => setShowTests(e.target.checked)} />Show test inquiries ({metrics.testInquiryCount})</label></div>
        {visibleInquiries.length === 0 ? <div className="tracker-empty"><h3>No matching inquiries yet.</h3><p>Website inquiries will appear here. Use “Add an Instagram inquiry” for conversations that began in DMs.</p></div> : <div className="inquiry-list">{visibleInquiries.map(inquiry => <InquiryEditor key={`${inquiry.id}-${revision}`} inquiry={inquiry} settings={data.settings} transactions={data.transactions} busy={busy} save={save} onError={setError} />)}</div>}
      </section>}

      {view === "payments" && <section className="tracker-view" aria-label="Payments and costs"><div className="tracker-section-heading"><div><h2>Record money when it moves.</h2><p>Zelle, Venmo, cash and bank payments are entered manually after you confirm them.</p></div><button type="button" className="tracker-quiet" onClick={() => downloadCSV("side-by-south-money.csv", [["Transaction ID", "Inquiry ID", "Date", "Type", "USD amount", "Method", "Reference", "Voided at", "Void reason"], ...metrics.allProductionTransactions.map(t => [t.id, t.inquiryId, t.occurredOn, t.type, t.amountCents / 100, t.method, t.referenceNote, t.voidedAt, t.voidReason])])}>Export money CSV</button></div>
        <TransactionForm key={`money-${revision}`} data={data} busy={busy} save={save} onError={setError} />
        <p className="tracker-note">Enter each transfer once. A deposit is part of the package payment; the balance is only the remaining amount. Use the payment app’s transfer reference to help prevent duplicates. Do not enter card numbers or banking credentials.</p>
        <label className="tracker-checkbox void-toggle"><input type="checkbox" checked={showVoided} onChange={event => setShowVoided(event.target.checked)} />Show voided entries ({metrics.allProductionTransactions.filter(t => t.voidedAt).length})</label>
        <div className="tracker-table-wrap"><table className="tracker-table"><caption>Production money records. Transactions linked to test inquiries are excluded. Voided entries remain in the audit trail and are excluded from totals.</caption><thead><tr><th>Date</th><th>Client / reference</th><th>Type</th><th>Amount</th><th>Method / note</th><th>Correction history</th></tr></thead><tbody>{metrics.allProductionTransactions.filter(t => showVoided || !t.voidedAt).length === 0 ? <tr><td colSpan={6}>No payments or costs recorded yet.</td></tr> : [...metrics.allProductionTransactions].filter(t => showVoided || !t.voidedAt).sort((a, b) => b.occurredOn.localeCompare(a.occurredOn)).map(t => <tr className={t.voidedAt ? "voided-record" : undefined} key={`${t.id}-${revision}`}><td>{displayDate(t.occurredOn)}</td><td>{data.inquiries.find(i => i.id === t.inquiryId)?.reference || "Business overhead"}</td><td>{TRANSACTION_LABELS[t.type]}{t.voidedAt && <small>Voided · excluded from totals</small>}</td><td>{money(t.amountCents)}</td><td>{t.method.replace(/_/g, " ")}<small>{t.referenceNote || "No reference entered"}</small></td><td><TransactionCorrection transaction={t} busy={busy} save={save} onError={setError} /></td></tr>)}</tbody></table></div>
      </section>}

      {view === "spend" && <section className="tracker-view" aria-label="Actual Meta ad spend"><div className="tracker-section-heading"><div><h2>Actual spend, not the budget.</h2><p>Successful Meta imports and verified manual entries use the same daily rows. Update a date’s total; do not add a cumulative total as another day.</p></div><a className="tracker-quiet tracker-link" href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2313142399498951&business_id=126637379336909&selected_campaign_ids=${encodeURIComponent(data.settings.campaignId)}`} target="_blank" rel="noreferrer">Open Meta Ads Manager ↗</a></div>
        <CloudStatusPanel status={data.cloudStatus} />
        <div className="tracker-spend-summary"><div><span>Lifetime budget</span><strong>{money(data.settings.budgetCents)}</strong></div><div><span>Reported spend</span><strong>{money(metrics.actualSpendCents)}</strong></div><div><span>Budget remaining</span><strong>{money(metrics.remainingBudgetCents)}</strong></div></div>
        <p className="tracker-note">October 25, 8:10 AM EDT to November 1, 7:10 AM EST is 168 hours and touches eight Eastern reporting dates. November 1 includes only the final morning. A blank amount means not entered; a confirmed $0 is different.</p>
        <div className="tracker-spend-list">{metrics.dates.map(date => <SpendRow key={`${date}-${revision}`} date={date} entry={data.spend.find(s => s.date === date)} busy={busy} save={save} onError={setError} />)}</div>
        <div className="tracker-section-heading"><p className="tracker-note">{metrics.missingSpendDates.length ? `${metrics.missingSpendDates.length} date(s) through today still need a spend report.` : metrics.reportingHasStarted ? "Every reporting date through today has an entry. Today’s total may still change." : "The campaign has not started; no spend is assumed."}</p><button type="button" className="tracker-quiet" onClick={() => downloadCSV("side-by-south-ad-spend.csv", [["Campaign ID", "Date Eastern", "Actual USD", "Verified at", "Notes"], ...data.spend.map(s => [data.settings.campaignId, s.date, s.amountCents / 100, s.verifiedAt, s.notes])])}>Export spend CSV</button></div>
      </section>}
    </>}
    <footer className="tracker-footer">Side by South · Private business records · <a href="/">View the public website</a></footer>
  </main>;
}

function CloudStatusPanel({ status }: { status?: CloudTrackingStatus }) {
  const summary = cloudStatusSummary(status);
  const count = (value: number | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "Not confirmed";
  return <article className={`tracker-panel tracker-cloud-panel${summary.needsAttention ? " cloud-needs-attention" : ""}`} aria-label="Cloud tracking status"><div className="tracker-cloud-heading"><div><p className="tracker-kicker">Cloud tracking status</p><h2>{summary.headline}</h2></div><span className="cloud-status-label">Read only</span></div><p className="tracker-note">{summary.detail}</p><div className="tracker-cloud-columns"><section><h3>Campaign spend</h3><dl><div><dt>Meta connection</dt><dd>{status ? status.tokenConfigured ? "Configured" : "Missing read connection" : "Not confirmed"}</dd></div><div><dt>Last successful import</dt><dd>{easternTimestamp(status?.lastSuccessfulSyncAt)}</dd></div><div><dt>Last attempt</dt><dd>{easternTimestamp(status?.lastAttemptAt)}</dd></div><div><dt>Reporting days imported</dt><dd>{count(status?.importedDayCount)}</dd></div></dl></section><section><h3>Cloud checks</h3><p>Recurring schedule execution is not verified by this dashboard. A configured connection or a saved schedule does not confirm that a cloud run succeeded.</p>{status?.lastResultCode && <p className="cloud-result-code">Latest result: {status.lastResultCode}</p>}<p className="tracker-note">Future spend dates stay blank until a real report is available.</p></section><section><h3>Inquiry notices</h3><dl><div><dt>Last inquiry check</dt><dd>{easternTimestamp(status?.lastInquiryScanAt)}</dd></div><div><dt>Pending notices</dt><dd>{count(status?.pendingInquiryAlerts)}</dd></div><div><dt>Reported notices</dt><dd>{count(status?.reportedInquiryAlerts)}</dd></div><div><dt>Last reported notice</dt><dd>{easternTimestamp(status?.lastInquiryAlertReportedAt)}</dd></div><div><dt>Notification delivery</dt><dd>Not confirmed</dd></div></dl><p className="tracker-note">A reported notice does not confirm that a notification reached your device.</p></section></div><p className="tracker-note cloud-source">Spend source: {status?.spendSource || "Not confirmed"}. All status times use Eastern Time.</p></article>;
}

function SourceFields({ settings, initialSource = "unknown", initialAd = "", captured = false }: { settings: TrackerSettings; initialSource?: string; initialAd?: string; captured?: boolean }) {
  if (captured) return <p className="tracker-note">Original URL attribution is retained. Ad reference: {initialAd || "Campaign-level URL"}.</p>;
  return <><label>How did they find us?<select name="source" defaultValue={initialSource}><option value="unknown">Unknown / not asked</option><option value="client_reported">Client said this Meta campaign</option></select></label><label>Which ad, if known?<select name="sourceAdId" defaultValue={initialAd}><option value="">Campaign only / unsure</option><option value={settings.videoAdId || WEBSITE_VIDEO_AD_ID}>15-second proposal video</option><option value={settings.photoAdId || WEBSITE_PHOTO_AD_ID}>Proposal photo</option><option value={settings.packageAdId || WEBSITE_PACKAGE_AD_ID}>$1,250 photo + film + setup</option></select></label></>;
}

function ManualInquiryForm({ busy, settings, save, onError }: { busy: boolean; settings: TrackerSettings; save: Save; onError: (s: string) => void }) {
  const [flexibleDate, setFlexibleDate] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    try {
      const source = String(values.get("source"));
      const adId = String(values.get("sourceAdId") || "");
      if (source === "unknown" && adId) throw new Error("Choose client-reported campaign attribution before assigning an ad.");
      const ok = await save("createInquiry", { id: crypto.randomUUID(), name: String(values.get("name")), instagram: String(values.get("instagram")), eventDate: String(values.get("eventDate") || ""), flexibleDate, eventLocation: String(values.get("eventLocation")), coverage: String(values.get("coverage")), notes: String(values.get("notes") || ""), source, sourceAdId: adId || null, attribution: source === "client_reported" ? { campaign_id: settings.campaignId, ad_id: adId || null } : {}, isTest: values.get("isTest") === "on" });
      if (ok) { form.reset(); setFlexibleDate(false); }
    } catch (err) { onError(err instanceof Error ? err.message : "Unable to add inquiry."); }
  }
  return <details className="tracker-panel manual-inquiry"><summary>Add an Instagram inquiry <span>+</span></summary><form className="tracker-form" onSubmit={submit}><label>Client name<input name="name" required maxLength={100} autoComplete="off" /></label><label>Instagram handle<input name="instagram" required maxLength={80} placeholder="@handle" autoComplete="off" /></label><label>Event date<input type="date" name="eventDate" required={!flexibleDate} /></label><label>Miami-area location<input name="eventLocation" required maxLength={150} /></label><label className="tracker-checkbox full"><input type="checkbox" checked={flexibleDate} onChange={event => setFlexibleDate(event.target.checked)} />Date is flexible / not decided yet</label><label>Coverage<select name="coverage" defaultValue="both"><option value="both">Photo + film · $600</option><option value="photo">Photography · $350</option><option value="film">Film · $400</option><option value="unsure">To be decided</option></select></label><SourceFields settings={settings} /><label className="full">Notes<textarea name="notes" maxLength={2000} rows={2} /></label><label className="tracker-checkbox"><input type="checkbox" name="isTest" />This is a test inquiry</label><div className="tracker-form-action"><button className="tracker-primary" disabled={busy}>Save inquiry</button></div></form></details>;
}

function InquiryEditor({ inquiry, settings, transactions, busy, save, onError }: { inquiry: Inquiry; settings: TrackerSettings; transactions: Transaction[]; busy: boolean; save: Save; onError: (s: string) => void }) {
  const [stage, setStage] = useState<InquiryStage>(inquiry.stage);
  const amounts = inquiryMoney(inquiry.id, transactions);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    try {
      const source = inquiry.source === "captured_url" ? "captured_url" : String(values.get("source"));
      const adId = inquiry.source === "captured_url" ? inquiry.sourceAdId || inquiry.attribution?.ad_id : String(values.get("sourceAdId") || "");
      if (source === "unknown" && adId) throw new Error("Choose client-reported attribution before assigning an ad.");
      await save("updateInquiry", { id: inquiry.id, stage, quotedMediaCents: dollarsToCents(values.get("quotedMedia"), true), bookingDate: String(values.get("bookingDate") || "") || null, completedDate: String(values.get("completedDate") || "") || null, notes: String(values.get("notes") || ""), actualCostsConfirmed: values.get("actualCostsConfirmed") === "on", decorationSettled: values.get("decorationSettled") === "on", isTest: values.get("isTest") === "on", ...(source !== "captured_url" ? { source, sourceAdId: adId || null, attribution: source === "client_reported" ? { campaign_id: settings.campaignId, ad_id: adId || null } : {} } : {}) });
    } catch (err) { onError(err instanceof Error ? err.message : "Unable to update inquiry."); }
  }
  return <details className="inquiry-card"><summary><div><span className="tracker-kicker">{inquiry.reference}{inquiry.isTest ? " · TEST" : ""}</span><h3>{inquiry.name || inquiry.instagram}</h3><p>{inquiry.instagram} · {displayDate(inquiry.eventDate)} · {packageNames[inquiry.coverage]}</p></div><div className="inquiry-summary-right"><span className={`stage-badge stage-${inquiry.stage}`}>{STAGE_LABELS[inquiry.stage]}</span><small>{sourceLabel(inquiry, settings)}</small><strong>{money(amounts.netMediaCents)} received</strong></div></summary><div className="inquiry-details"><dl className="inquiry-facts"><div><dt>Location</dt><dd>{inquiry.eventLocation || "Not provided"}</dd></div><div><dt>First contact</dt><dd>{displayDate(inquiry.createdAt)}</dd></div><div><dt>Planned direct cost</dt><dd>{money(inquiry.plannedCostCents)} · estimate</dd></div><div><dt>Actual costs recorded</dt><dd>{money(amounts.directExpenseCents)} · {inquiry.actualCostsConfirmed ? "confirmed" : "not confirmed"}</dd></div></dl><form className="tracker-form" onSubmit={submit}><label>Stage<select name="stage" value={stage} onChange={e => setStage(e.target.value as InquiryStage)}>{Object.entries(STAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Agreed media package price ($)<input name="quotedMedia" inputMode="decimal" placeholder="Enter agreed amount" defaultValue={inquiry.quotedMediaCents === null ? "" : (inquiry.quotedMediaCents / 100).toFixed(2)} /></label><label>Booking agreed on<input type="date" name="bookingDate" required={stage === "booked" || stage === "completed"} defaultValue={inquiry.bookingDate || ""} /></label><label>Work completed on<input type="date" name="completedDate" required={stage === "completed"} defaultValue={inquiry.completedDate || ""} /></label><SourceFields settings={settings} initialSource={inquiry.source} initialAd={inquiry.sourceAdId || inquiry.attribution?.ad_id || ""} captured={inquiry.source === "captured_url"} /><label className="full">Notes<textarea name="notes" rows={2} maxLength={2000} defaultValue={inquiry.notes} /></label><label className="tracker-checkbox full"><input type="checkbox" name="actualCostsConfirmed" defaultChecked={inquiry.actualCostsConfirmed} />All actual direct costs are recorded, including any confirmed zero cost.</label><label className="tracker-checkbox full"><input type="checkbox" name="decorationSettled" defaultChecked={inquiry.decorationSettled} />All decoration partner payouts are recorded; the remaining spread is ours.</label><label className="tracker-checkbox full"><input type="checkbox" name="isTest" defaultChecked={Boolean(inquiry.isTest)} />Test inquiry · exclude this inquiry and its money records from totals.</label><div className="tracker-form-action"><button className="tracker-primary" disabled={busy}>Save booking details</button></div></form></div></details>;
}

function TransactionForm({ data, busy, save, onError }: { data: TrackerData; busy: boolean; save: Save; onError: (s: string) => void }) {
  const [type, setType] = useState<TransactionType>("media_deposit");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    try {
      const amountCents = dollarsToCents(values.get("amount"));
      if (!amountCents || amountCents <= 0) throw new Error("Enter an amount greater than $0.");
      const inquiryId = String(values.get("inquiryId") || "");
      if (type !== "software_expense" && !inquiryId) throw new Error("Choose the inquiry this payment or cost belongs to.");
      const ok = await save("addTransaction", { id: crypto.randomUUID(), inquiryId: inquiryId || null, occurredOn: String(values.get("occurredOn")), type, amountCents, method: String(values.get("method")) as PaymentMethod, referenceNote: String(values.get("referenceNote") || "") });
      if (ok) form.reset();
    } catch (err) { onError(err instanceof Error ? err.message : "Unable to record payment."); }
  }
  return <form className="tracker-panel tracker-form" onSubmit={submit}><label>Record type<select name="type" value={type} onChange={e => setType(e.target.value as TransactionType)}>{Object.entries(TRANSACTION_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label>Client / inquiry<select name="inquiryId" required={type !== "software_expense"} defaultValue=""><option value="">{type === "software_expense" ? "Business overhead" : "Choose an inquiry"}</option>{data.inquiries.map(i => <option key={i.id} value={i.id}>{i.reference} · {i.name || i.instagram}{i.isTest ? " · TEST" : ""}</option>)}</select></label><label>Amount ($)<input name="amount" inputMode="decimal" required placeholder="0.00" /></label><label>Payment / expense date<input type="date" name="occurredOn" defaultValue={localDate(new Date())} required /></label><label>Method<select name="method" defaultValue="zelle"><option value="zelle">Zelle</option><option value="venmo">Venmo</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="other">Other</option></select></label><label>Transfer confirmation / reference<input name="referenceNote" maxLength={200} placeholder="Reference from the payment app" /></label><p className="tracker-note full">This records a payment you have confirmed; it does not connect to or verify your bank, Zelle or Venmo account. Record refunds only when money was actually returned.</p><div className="tracker-form-action"><button className="tracker-primary" disabled={busy}>Record money movement</button></div></form>;
}

function SpendRow({ date, entry, busy, save, onError }: { date: string; entry?: SpendEntry; busy: boolean; save: Save; onError: (s: string) => void }) {
  const future = date > localDate(new Date());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    try { await save("saveSpend", { date, amountCents: dollarsToCents(values.get("amount")), verifiedAt: new Date().toISOString(), notes: String(values.get("notes") || "") }); }
    catch (err) { onError(err instanceof Error ? err.message : "Unable to save spend."); }
  }
  return <form className="tracker-spend-row" onSubmit={submit}><div><strong>{displayDate(date)}</strong><small>{entry ? `Updated ${displayDate(entry.verifiedAt)}` : future ? "Upcoming reporting date" : "Not entered"}</small></div><label>Actual spend ($)<input name="amount" inputMode="decimal" required disabled={future} placeholder="Not entered" defaultValue={entry ? (entry.amountCents / 100).toFixed(2) : ""} /></label><label>Report note<input name="notes" maxLength={300} disabled={future} placeholder="e.g. Meta Amount spent, Eastern Time" defaultValue={entry?.notes || ""} /></label><button className="tracker-quiet" disabled={busy || future}>Save daily total</button></form>;
}

function TransactionCorrection({ transaction, busy, save, onError }: { transaction: Transaction; busy: boolean; save: Save; onError: (s: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") || "").trim();
    if (reason.length < 3) { onError("Enter a short reason for the correction."); return; }
    await save(transaction.voidedAt ? "restoreTransaction" : "voidTransaction", { id: transaction.id, reason });
  }
  return <details className="transaction-correction"><summary>{transaction.voidedAt ? "Restore entry" : "Correct entry"}</summary><p>{transaction.voidedAt ? "Restore this original entry to totals. No payment is sent." : "Void a mistaken record while keeping its history. This does not issue a refund or move money."}</p>{transaction.voidReason && <p>Last reason: {transaction.voidReason}</p>}<form onSubmit={submit}><label>Reason<textarea name="reason" minLength={3} maxLength={500} rows={2} required /></label><button type="submit" className="tracker-quiet" disabled={busy}>{transaction.voidedAt ? "Restore record" : "Void mistaken record"}</button></form>{Boolean(transaction.auditEvents?.length) && <ol>{transaction.auditEvents?.map(event => <li key={event.id}>{displayDate(event.createdAt)} · {event.action}: {event.reason}</li>)}</ol>}</details>;
}

function SoftwareSettings({ data, metrics, busy, save, onError }: { data: TrackerData; metrics: ReturnType<typeof calculateTrackerMetrics>; busy: boolean; save: Save; onError: (s: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    try {
      const shareText = String(values.get("share") || "").trim();
      const share = shareText === "" ? null : Number(shareText) / 100;
      if (share !== null && (!Number.isFinite(share) || share < 0 || share > 1)) throw new Error("Business use must be between 0% and 100%.");
      await save("updateSettings", { monthlySoftwareCents: dollarsToCents(values.get("monthlySoftware")), plannedCostCents: dollarsToCents(values.get("plannedCost")), softwareBusinessUseShare: share });
    } catch (err) { onError(err instanceof Error ? err.message : "Unable to save cost settings."); }
  }
  return <article className="tracker-panel"><h2>Software & cost assumptions</h2><p className="tracker-note">ChatGPT Pro is fixed monthly overhead. Allocation is a planning cost, not a second subscription charge.</p><form className="tracker-form compact" onSubmit={submit}><label>Pro monthly charge ($)<input name="monthlySoftware" inputMode="decimal" required defaultValue={(data.settings.monthlySoftwareCents / 100).toFixed(2)} /></label><label>Business use (%)<input type="number" name="share" min="0" max="100" step="1" placeholder="Unconfirmed" defaultValue={data.settings.softwareBusinessUseShare == null ? "" : data.settings.softwareBusinessUseShare * 100} /></label><label className="full">Planned direct cost per shoot ($)<input name="plannedCost" inputMode="decimal" required defaultValue={(data.settings.plannedCostCents / 100).toFixed(2)} /></label><div className="tracker-form-action"><button className="tracker-quiet" disabled={busy}>Save assumptions</button></div></form><dl className="tracker-calculation"><div><dt>Weekly allocation at confirmed share</dt><dd>{money(metrics.allocatedSoftwareCents)}</dd></div><div><dt>Full business-use weekly scenario</dt><dd>{money(metrics.fullBusinessSoftwarePlanningCents)}</dd></div><div><dt>Actual software cash paid in window</dt><dd>{money(metrics.softwareCashPaidCents)}</dd></div></dl><p className="tracker-note">Weekly planning cost = monthly charge × 12 ÷ 52 × business-use share. The $50 planned shoot cost includes transportation; confirm actual costs after each job. Software cash payments and allocated overhead are never both deducted from completed-job contribution.</p></article>;
}
