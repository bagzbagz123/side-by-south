# Square digital-media deposit tracking

Production connection: OAuth confidential authorization-code flow, with only PAYMENTS_READ, ORDERS_READ, ITEMS_READ and MERCHANT_PROFILE_READ. No payment creation, refund or customer-management permission. Merchant and location are verified on initial connection and refresh.

## Owner setup

1. Production app: Side by South Deposit Reporting (public application ID sq0idp-S-sadqRnP5mnee_Le8FIQg).
2. Production callback: https://sidebysouth.com/api/square/callback (approved and saved October 27, 2026).
3. Set hosted runtime SQUARE_APPLICATION_ID to that ID. Set SQUARE_APPLICATION_SECRET as a secret using the production OAuth Application secret. Do not use a Personal Access Token. Never commit a secret or enter it in chat.
4. Publish the tested integration with the existing D1 binding and owner access preserved. Deploy again after changing runtime configuration. Verify that /tracker shows the new Square panel before connecting.
5. In the owner tracker, Connect Square; review the four read permissions and authorize Photograph LLC. Do not authorize an unrelated merchant.
6. Exercise get_square_status and sync_square_deposits through the Site-hosted owner-only MCP tools; read back the durable successful check. Only then create a linked cloud task every 15 minutes, reusing any existing matching task. Keep its prompt minimal and instruct it to notify only once per actionable connection or matching problem, otherwise stay quiet.

## Booking workflow

Record the accepted media quote on a real inquiry, then enable matching for that quote in Payments & costs. This requires a quote ID/revision and explicit whole-order digital-only scope. Give the client the matching approved deposit link and the immutable SBS reference to enter in Square’s Booking or quote reference field. Current media-only deposits remain $105 / $120 / $180. Decoration, physical products and mixed orders remain held even when payments would be split. Future rates cannot enroll before November 1, 2026, 7:10 AM America/New_York.

Payments must be completed Square-processed receipts, USD, one approved catalog item, quantity one, with exact deposit total and no tax, tips, extra items or service charges. The API item is resolved from the historical variation to its approved parent item. A payment amount or client name never establishes a match. Missing references, unenrolled quotes, existing manual deposits and scope/amount mismatches enter owner review. Owner mapping rechecks the authoritative receipt and quote. Unexpected native custom-field formatting also enters review.

Imports add gross media-deposit ledger entries only. Reservation, booking and completion stages remain manual; no client messages are sent. Square processing fees and bank payouts are not reconciled by this import. Completed refunds are recorded once after authoritative reconciliation; existing manual refund entries require review. There is no refund-creation capability.

## Reliability and privacy

OAuth tokens are encrypted at rest with AES-GCM and bound to the application, approved merchant and owner. The app secret stays in hosted secret configuration. Source, client bundles, logs, schedules and this document contain no token. The sync takes a durable lease; freezes bounded page IDs and next cursor; fetches each payment/refund authoritatively; checkpoints only after durable processing; and advances its watermark only after complete payment, refund and pending-refund scans. Failed and incomplete scans preserve prior records and disclose a coverage gap. Receipt and refund IDs prevent duplicate imports. Voided imported receipts are not resurrected. OAuth and API writes require authenticated owner access; browser writes also require same-origin validation.

## Pricing release safeguard

Do not deploy the previously saved pricing-only version after this integration: it would remove the Square code. Apply docs/future-pricing-after-campaign.patch to the integration (it changes only the four approved pricing files and adds the regular-price test), validate, and save a new future version without deploying it early. Reconcile the existing November 1 pricing-release task with that new version and current live-version guard; do not create a duplicate or silently overwrite a newer Site release.

## Verification boundary

Automated tests cover financial matching, authorization, duplicates, refunds, resumable paging and manual stage invariants, including actual Workers/D1 execution with fictional fixtures. A real paid Square receipt has not yet been validated. Do not claim live imports or cloud scheduling work until the intended hosted access path is exercised and its persisted result is read back.
