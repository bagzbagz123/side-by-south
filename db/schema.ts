import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const inquiries = sqliteTable("inquiries", {
  id: text("id").primaryKey(),
  submissionId: text("submission_id").notNull(),
  reference: text("reference").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  name: text("name").notNull(),
  instagram: text("instagram").notNull(),
  eventDate: text("event_date"),
  flexibleDate: integer("flexible_date", { mode: "boolean" }).notNull().default(false),
  eventLocation: text("event_location").notNull(),
  coverage: text("coverage").notNull(),
  notes: text("notes").notNull().default(""),
  stage: text("stage").notNull().default("new"),
  quotedMediaCents: integer("quoted_media_cents"),
  bookingDate: text("booking_date"),
  completedDate: text("completed_date"),
  source: text("source").notNull().default("unknown"),
  sourceAdId: text("source_ad_id"),
  attributionJson: text("attribution_json").notNull().default("{}"),
  plannedCostCents: integer("planned_cost_cents").notNull().default(5000),
  actualCostsConfirmed: integer("actual_costs_confirmed", { mode: "boolean" }).notNull().default(false),
  decorationSettled: integer("decoration_settled", { mode: "boolean" }).notNull().default(false),
  isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  uniqueIndex("inquiries_submission_unique").on(table.submissionId),
  uniqueIndex("inquiries_reference_unique").on(table.reference),
]);

export const ledgerTransactions = sqliteTable("ledger_transactions", {
  id: text("id").primaryKey(),
  inquiryId: text("inquiry_id").references(() => inquiries.id),
  occurredOn: text("occurred_on").notNull(),
  type: text("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  method: text("method").notNull(),
  referenceNote: text("reference_note").notNull().default(""),
  referenceKey: text("reference_key"),
  createdAt: text("created_at").notNull(),
  voidedAt: text("voided_at"),
  voidReason: text("void_reason"),
  lastChangeId: text("last_change_id"),
}, (table) => [uniqueIndex("ledger_payment_reference_unique").on(table.referenceKey).where(sql`${table.voidedAt} is null`)]);

export const transactionAudit = sqliteTable("transaction_audit", {
  id: text("id").primaryKey(),
  transactionId: text("transaction_id").notNull().references(() => ledgerTransactions.id),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
  actorId: text("actor_id").notNull(),
});

export const adSpend = sqliteTable("ad_spend", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  date: text("date").notNull(),
  amountCents: integer("amount_cents").notNull(),
  verifiedAt: text("verified_at").notNull(),
  notes: text("notes").notNull().default(""),
}, (table) => [uniqueIndex("ad_spend_campaign_date_unique").on(table.campaignId, table.date)]);

export const trackerSettings = sqliteTable("tracker_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const trackingCloudState = sqliteTable("tracking_cloud_state", {
  key: text("key").primaryKey(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  lastAttemptAt: text("last_attempt_at"),
  lastSuccessAt: text("last_success_at"),
  lastStatus: text("last_status").notNull().default("ready"),
  lastResultCode: text("last_result_code"),
  lastImportedDays: integer("last_imported_days").notNull().default(0),
  connectionStatus: text("connection_status").notNull().default("not_verified"),
  connectionVerifiedAt: text("connection_verified_at"),
  connectionResultCode: text("connection_result_code"),
  updatedAt: text("updated_at").notNull(),
});

export const inquiryAlerts = sqliteTable("inquiry_alerts", {
  inquiryId: text("inquiry_id").primaryKey().references(() => inquiries.id),
  queuedAt: text("queued_at").notNull(),
  isTestAlert: integer("is_test_alert", { mode: "boolean" }).notNull().default(false),
  claimId: text("claim_id"),
  claimExpiresAt: text("claim_expires_at"),
  reportedAt: text("reported_at"),
});

// Square credentials are encrypted with a key derived from the runtime app
// secret. No plaintext access/refresh token or provider payload is persisted.
export const squareConnections = sqliteTable("square_connections", {
  key: text("key").primaryKey(),
  ownerId: text("owner_id").notNull(),
  merchantId: text("merchant_id").notNull(),
  locationId: text("location_id").notNull(),
  encryptedTokens: text("encrypted_tokens").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshedAt: text("refreshed_at").notNull(),
  scopesJson: text("scopes_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const squareOauthStates = sqliteTable("square_oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  ownerId: text("owner_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
});

export const squareQuoteEnrollments = sqliteTable("square_quote_enrollments", {
  inquiryId: text("inquiry_id").primaryKey().references(() => inquiries.id),
  offerKey: text("offer_key").notNull(),
  acceptedQuoteReference: text("accepted_quote_reference").notNull(),
  digitalOnly: integer("digital_only", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const squareReceipts = sqliteTable("square_receipts", {
  paymentId: text("payment_id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  orderId: text("order_id").notNull(),
  providerUpdatedAt: text("provider_updated_at").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  occurredOn: text("occurred_on").notNull(),
  offerKey: text("offer_key"),
  reference: text("reference"),
  status: text("status").notNull().default("review"),
  code: text("code").notNull(),
  inquiryId: text("inquiry_id").references(() => inquiries.id),
  ledgerTransactionId: text("ledger_transaction_id").references(() => ledgerTransactions.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const squareRefunds = sqliteTable("square_refunds", {
  refundId: text("refund_id").primaryKey(),
  paymentId: text("payment_id").notNull().references(() => squareReceipts.paymentId),
  providerUpdatedAt: text("provider_updated_at").notNull(),
  amountCents: integer("amount_cents").notNull(),
  occurredOn: text("occurred_on").notNull(),
  status: text("status").notNull().default("review"),
  code: text("code").notNull(),
  ledgerTransactionId: text("ledger_transaction_id").references(() => ledgerTransactions.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const squareSyncState = sqliteTable("square_sync_state", {
  key: text("key").primaryKey(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  watermark: text("watermark"),
  scanBegin: text("scan_begin"),
  scanUpper: text("scan_upper"),
  scanPhase: text("scan_phase"),
  cursor: text("cursor"),
  pageIdsJson: text("page_ids_json"),
  pageNextCursor: text("page_next_cursor"),
  pageOffset: integer("page_offset").notNull().default(0),
  scanPages: integer("scan_pages").notNull().default(0),
  lastAttemptAt: text("last_attempt_at"),
  lastSuccessAt: text("last_success_at"),
  lastStatus: text("last_status").notNull().default("not_connected"),
  lastCode: text("last_code"),
  coverageGap: integer("coverage_gap", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});
