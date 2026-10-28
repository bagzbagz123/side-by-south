// Pure Square receipt rules. Buyer text is never an instruction or proof of an
// accepted quote, digital-only scope, availability or reservation confirmation.
export const SQUARE_MERCHANT_ID = "MLHDWJZHXQRMK";
export const SQUARE_SITE_ORIGIN = "https://sidebysouth.com";
export const SQUARE_REDIRECT_URI = `${SQUARE_SITE_ORIGIN}/api/square/callback`;
export const SQUARE_FIRST_PAYMENT = "2026-10-27T04:00:00.000Z";
export const SQUARE_FUTURE_FROM = "2026-11-01T12:10:00.000Z";
export const SQUARE_SCOPES = ["PAYMENTS_READ", "ORDERS_READ", "ITEMS_READ", "MERCHANT_PROFILE_READ"] as const;
export const SQUARE_OFFERS = [
  { key: "current_photo", label: "Current photo · $350", coverage: "photo", mediaCents: 35000, depositCents: 10500, parentItemId: "KY3LAMZVAC3ZLTO4SL5V6OBJ", availableFrom: SQUARE_FIRST_PAYMENT },
  { key: "current_film", label: "Current film · $400", coverage: "film", mediaCents: 40000, depositCents: 12000, parentItemId: "OBOOYCYAK72AW24WU7XNC6WF", availableFrom: SQUARE_FIRST_PAYMENT },
  { key: "current_both", label: "Current photo + film · $600", coverage: "both", mediaCents: 60000, depositCents: 18000, parentItemId: "4N6654CHAAB4SYVNCJAEP36E", availableFrom: SQUARE_FIRST_PAYMENT },
  { key: "regular_photo", label: "Regular photo · $450", coverage: "photo", mediaCents: 45000, depositCents: 13500, parentItemId: "PMMOOVLEW2T2LZZPO3J3ZO6M", availableFrom: SQUARE_FUTURE_FROM },
  { key: "regular_film", label: "Regular film · $600", coverage: "film", mediaCents: 60000, depositCents: 18000, parentItemId: "JFZERB422INHFPC4DJWF6N4I", availableFrom: SQUARE_FUTURE_FROM },
  { key: "regular_both", label: "Regular photo + film · $1,000", coverage: "both", mediaCents: 100000, depositCents: 30000, parentItemId: "USHLGH6IPCV3NQYAVPALDCQH", availableFrom: SQUARE_FUTURE_FROM },
] as const;
export type SquareOffer = typeof SQUARE_OFFERS[number];
export type SquareObject = Record<string, unknown>;
export const SQUARE_MESSAGES: Record<string, string> = {
  webhook_setup_required: "Add the Square webhook signature key before enabling direct payment notifications.",
  webhook_processed: "A signed Square event was checked against the provider. Reservation status is unchanged.",
  webhook_ignored: "A signed Square event was unrelated to an approved deposit and was ignored.",
  webhook_processing: "A signed Square event is being checked. It is not proof of a paid booking.",
  setup_required: "Add the Square application's ID and secret before connecting.",
  not_connected: "Connect the approved Photograph LLC Square account.",
  connected: "Square read access is connected. Reservation confirmations remain manual.",
  synced: "The completed Square scan is up to date. Reservation confirmations remain manual.",
  in_progress: "The Square scan will continue from its saved position.",
  busy: "Another Square check is already running.",
  reconnect_required: "Reconnect Square to restore read access. Existing records are unchanged.",
  invalid_app_config: "Check the production Square application settings.",
  oauth_state_invalid: "This connection request expired or did not match. Start Connect Square again.",
  oauth_denied: "Square access was not approved. Existing records are unchanged.",
  merchant_mismatch: "The connected Square account is not the approved Photograph LLC merchant.",
  location_mismatch: "Square did not return one active USD location named Photo.",
  scopes_mismatch: "Square must grant only the four requested read permissions.",
  token_invalid: "Square returned incomplete or invalid connection information.",
  network_error: "Square could not be reached. The prior checkpoint is retained.",
  provider_error: "Square could not complete this read. The prior checkpoint is retained.",
  response_invalid: "Square returned an unexpected response. The prior checkpoint is retained.",
  scan_limit: "The bounded scan needs owner attention before it can finish.",
  storage_unavailable: "Square tracking storage is temporarily unavailable.",
  invalid_input: "Check the Square tracker fields and try again.",
  inquiry_unavailable: "Choose an eligible, non-test inquiry that is not lost or cancelled.",
  digital_only_required: "Confirm an accepted standalone digital-only quote. Mixed orders remain on hold.",
  quote_mismatch: "The inquiry's media quote or coverage does not match this offer.",
  offer_not_live: "This regular-rate offer is not available before November 1 at 7:10 AM Miami time.",
  reference_missing: "The payment needs an owner match to an enrolled quote.",
  reference_ambiguous: "The entered reference is ambiguous. Owner review is needed.",
  reference_unknown: "No inquiry has the exact entered SBS reference.",
  not_enrolled: "The inquiry has no enabled, accepted digital-only quote enrollment.",
  offer_mismatch: "The payment item does not match the inquiry's enrolled offer.",
  payment_not_completed: "Square has not confirmed this payment as completed.",
  unsupported_payment: "This is not a Square-processed payment eligible for automatic import.",
  currency_mismatch: "The receipt is not an exact USD payment for this deposit.",
  amount_mismatch: "The receipt total does not match one deposit for the accepted offer.",
  order_has_extras: "This order includes extra items, quantities or charges. It stays on review hold.",
  physical_fulfillment: "The order contains physical fulfillment details and stays on hold.",
  manual_payment_conflict: "A media deposit is already recorded. Reconcile it before importing another.",
  imported: "The completed deposit was recorded. Confirmation and reservation status remain manual.",
  record_voided: "The owner voided this receipt. Automatic checks will not restore it.",
  ignored: "The owner excluded this receipt from automatic ledger import.",
  unknown_receipt: "The receipt could not be found in the approved deposit review queue.",
  receipt_mismatch: "This receipt cannot be mapped until its offer, amount and scope match.",
  refund_not_completed: "Square has not confirmed this refund as completed.",
  refund_payment_pending: "Match the original deposit before importing this refund.",
  refund_mismatch: "The refund could not be reconciled with its original deposit.",
  manual_refund_conflict: "A refund was already entered manually. Reconcile it before importing a Square refund.",
  refund_imported: "The completed Square refund was recorded; reservation status is unchanged.",
};
export function squareMessage(code: string | null | undefined): string { return SQUARE_MESSAGES[code || "not_connected"] || "Square needs owner review; existing records are retained."; }
export class SquareSyncError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(squareMessage(code)); this.name = "SquareSyncError"; }
}
export function squareObject(value: unknown): SquareObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SquareSyncError(502, "response_invalid");
  return value as SquareObject;
}
export function squareId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,200}$/.test(value)) throw new SquareSyncError(502, "response_invalid");
  return value;
}
export function squareTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new SquareSyncError(502, "response_invalid");
  return new Date(value).toISOString();
}
export function squareDay(value: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  return `${parts.find(x => x.type === "year")!.value}-${parts.find(x => x.type === "month")!.value}-${parts.find(x => x.type === "day")!.value}`;
}
export function moneyAmount(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = (value as SquareObject).amount;
  return Number.isSafeInteger(amount) && Number(amount) >= 0 && Number(amount) <= 100000000 ? Number(amount) : null;
}
export function moneyIsUsd(value: unknown): boolean { return !!value && typeof value === "object" && (value as SquareObject).currency === "USD"; }
export function offerForKey(value: unknown): SquareOffer | undefined { return SQUARE_OFFERS.find(offer => offer.key === value); }
export function offerForParent(value: unknown): SquareOffer | undefined { return SQUARE_OFFERS.find(offer => offer.parentItemId === value); }

// Only fulfillment detail notes are inspected. Never traverse line-item notes,
// metadata, names or arbitrary fields looking for a plausible reference.
export function referenceFromOrder(order: SquareObject): { reference: string | null; code: string | null } {
  const notes: string[] = [];
  if (Array.isArray(order.fulfillments)) for (const raw of order.fulfillments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const fulfillment = raw as SquareObject;
    for (const [detailKey, noteKey] of [["pickup_details", "note"], ["delivery_details", "note"], ["shipment_details", "shipping_note"]]) {
      const details = fulfillment[detailKey];
      if (details && typeof details === "object" && !Array.isArray(details)) {
        const note = (details as SquareObject)[noteKey];
        if (typeof note === "string" && note.length <= 10000) notes.push(note.replace(/\r\n/g, "\n"));
      }
    }
  }
  const labeled: string[] = [];
  for (const note of notes) for (const match of note.matchAll(/(?:^|\n)[ \t]*Booking or quote reference[ \t]*:[ \t]*([^\n]*)/g)) labeled.push(match[1].trim());
  if (!labeled.length) return { reference: null, code: "reference_missing" };
  if (labeled.length !== 1 || !/^SBS-[0-9A-F]{8}$/i.test(labeled[0])) return { reference: null, code: "reference_ambiguous" };
  return { reference: labeled[0].toUpperCase(), code: null };
}
export function physicalFulfillment(order: SquareObject): boolean {
  if (!Array.isArray(order.fulfillments)) return false;
  return order.fulfillments.some(raw => {
    if (!raw || typeof raw !== "object") return false;
    const f = raw as SquareObject;
    // Native Sell-an-item digital checkout can place its custom answers in
    // delivery_details.note. The declared fulfillment type, not that detail
    // key, determines whether this is physical fulfillment.
    if (f.type !== undefined && f.type !== "DIGITAL") return true;
    for (const key of ["shipment_details", "delivery_details", "pickup_details"]) {
      const details = f[key] as SquareObject | undefined;
      const recipient = details?.recipient as SquareObject | undefined;
      if (recipient?.address && typeof recipient.address === "object" && Object.values(recipient.address as SquareObject).some(Boolean)) return true;
    }
    return false;
  });
}
export function candidateCode(payment: SquareObject, order: SquareObject, offer: SquareOffer, now: Date): string | null {
  if (payment.status !== "COMPLETED") return "payment_not_completed";
  if (!["CARD", "BANK_ACCOUNT", "WALLET", "BUY_NOW_PAY_LATER", "SQUARE_ACCOUNT"].includes(String(payment.source_type))) return "unsupported_payment";
  if (!Number.isFinite(Date.parse(String(payment.created_at)))) return "payment_not_completed";
  if (Date.parse(String(payment.created_at)) < Date.parse(offer.availableFrom) || now.getTime() < Date.parse(offer.availableFrom)) return "offer_not_live";
  if (!moneyIsUsd(payment.amount_money) || !moneyIsUsd(payment.total_money) || !moneyIsUsd(order.total_money)) return "currency_mismatch";
  if ([payment.amount_money, payment.total_money, order.total_money].some(value => moneyAmount(value) !== offer.depositCents)) return "amount_mismatch";
  if (payment.tip_money != null && moneyAmount(payment.tip_money) !== 0) return "order_has_extras";
  const zeroFields = [order.total_tax_money, order.total_discount_money, order.total_service_charge_money, order.total_tip_money];
  if (zeroFields.some(value => value != null && moneyAmount(value) !== 0)) return "order_has_extras";
  if (!Array.isArray(order.line_items) || order.line_items.length !== 1) return "order_has_extras";
  const line = squareObject(order.line_items[0]);
  if (typeof line.quantity !== "string" || !/^1(?:\.0+)?$/.test(line.quantity)) return "order_has_extras";
  if (!moneyIsUsd(line.base_price_money) || !moneyIsUsd(line.total_money) || moneyAmount(line.base_price_money) !== offer.depositCents || moneyAmount(line.total_money) !== offer.depositCents) return "amount_mismatch";
  if (Array.isArray(line.modifiers) && line.modifiers.length || Array.isArray(order.service_charges) && order.service_charges.length) return "order_has_extras";
  if (order.state === "CANCELED") return "order_has_extras";
  if (physicalFulfillment(order)) return "physical_fulfillment";
  return null;
}
