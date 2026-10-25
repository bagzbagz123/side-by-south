import { OwnerAccessError, requireTrackerOwner } from "@/lib/owner-access";
import { acknowledgeInquiryAlerts, CloudTrackingError, getCloudTrackingStatus, getPendingInquiryAlerts, syncCampaignSpend, verifyMetaConnection } from "@/lib/cloud-tracking";
import { DailySummaryError, getCampaignDailySummary } from "@/lib/campaign-daily-summary";

export const dynamic = "force-dynamic";
const EMPTY = { type: "object", properties: {}, additionalProperties: false };
const TOOLS = [
  { name: "get_tracking_status", description: "Read private Side by South cloud tracking setup, safe sync status and inquiry-alert counts. Does not return credentials or client contact details.", inputSchema: EMPTY },
  { name: "get_campaign_daily_summary", description: "Read an owner-only aggregate report of yesterday's Eastern-time ad spend, inquiries and first-funded bookings, plus current campaign-to-date cash and safeguarded completed-job contribution. Excludes tests and client details; missing spend stays unknown. Payments are owner-recorded, not bank-verified.", inputSchema: EMPTY },
  { name: "verify_meta_connection", description: "Verify the server-side read credential against the exact Side by South USD ad account, New York timezone and campaign using fixed Meta GET requests. May run before the campaign starts; never changes spend or ads.", inputSchema: EMPTY },
  { name: "sync_campaign_spend", description: "Reconcile explicit daily spend for the fixed Side by South campaign using a server-side ads_read-only credential. Preserves unknown days; never changes Meta ads, budgets or schedules.", inputSchema: EMPTY },
  { name: "get_pending_inquiry_alerts", description: "Claim up to 25 unreported inquiry alerts using a durable ten-minute lease. Ordinary tests are excluded; explicit owner-requested alert tests are returned with isTest and testAlert true. Returns only references, coverage and dates, without names, handles or notes.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 25, default: 10 } }, additionalProperties: false } },
  { name: "acknowledge_inquiry_alerts", description: "Idempotently record that the cloud task reported the known inquiry IDs from its claim. This is report intent, not guaranteed notification delivery.", inputSchema: { type: "object", properties: { claimId: { type: "string", format: "uuid" }, inquiryIds: { type: "array", minItems: 1, maxItems: 25, uniqueItems: true, items: { type: "string", format: "uuid" } } }, required: ["claimId", "inquiryIds"], additionalProperties: false } },
];
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" } });
function rpcError(id: unknown, code: number, message: string, status = 200) { return response({ jsonrpc: "2.0", id, error: { code, message } }, status); }
function args(value: unknown, keys: string[]) {
  if (value == null) return {} as Record<string, unknown>;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new CloudTrackingError("invalid_arguments", "The tool arguments are invalid.");
  return value as Record<string, unknown>;
}
async function boundedRpc(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new CloudTrackingError("invalid_request", "Use a JSON MCP request.");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new CloudTrackingError("invalid_request", "Cross-origin browser calls are not supported.");
  const reader = request.body?.getReader();
  if (!reader) throw new CloudTrackingError("invalid_request", "Provide an MCP request.");
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 16384) { await reader.cancel(); throw new CloudTrackingError("invalid_request", "The MCP request is too large."); } parts.push(part.value); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
export async function POST(request: Request) {
  let id: unknown = null;
  try {
    const raw = await boundedRpc(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rpcError(null, -32600, "Invalid JSON-RPC request.", 400);
    const rpc = raw as Record<string, unknown>;
    id = typeof rpc.id === "number" || (typeof rpc.id === "string" && rpc.id.length <= 100) ? rpc.id : null;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return rpcError(id, -32600, "Invalid JSON-RPC request.", 400);
    if (rpc.method === "server/discover") return response({ jsonrpc: "2.0", id, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "side-by-south-tracking", version: "1.0.0" } } });
    if (rpc.method === "initialize") return response({ jsonrpc: "2.0", id, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "side-by-south-tracking", version: "1.0.0" } } });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    if (rpc.method === "tools/list") return response({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (rpc.method !== "tools/call") return rpcError(id, -32601, "Method not found.");
    await requireTrackerOwner();
    // MCP clients may attach protocol metadata (for example a progress token).
    // It is not a tool argument and must never expand any tool's allowlist.
    const params = args(rpc.params, ["name", "arguments", "_meta"]);
    let result: Record<string, unknown>;
    switch (params.name) {
      case "get_tracking_status": args(params.arguments, []); result = await getCloudTrackingStatus(); break;
      case "get_campaign_daily_summary": args(params.arguments, []); result = await getCampaignDailySummary(); break;
      case "verify_meta_connection": args(params.arguments, []); result = await verifyMetaConnection(); break;
      case "sync_campaign_spend": args(params.arguments, []); result = await syncCampaignSpend(); break;
      case "get_pending_inquiry_alerts": { const input = args(params.arguments, ["limit"]); result = await getPendingInquiryAlerts(input.limit === undefined ? 10 : input.limit as number); break; }
      case "acknowledge_inquiry_alerts": { const input = args(params.arguments, ["claimId", "inquiryIds"]); result = await acknowledgeInquiryAlerts(input.claimId, input.inquiryIds); break; }
      default: throw new CloudTrackingError("unknown_tool", "Unknown tracking tool.");
    }
    // Reading status succeeds even when it reports an integration needing setup.
    // This keeps inquiry checks usable independently of the Meta credential.
    const isError = params.name !== "get_tracking_status" && (result.status === "error" || result.status === "setup_required");
    return response({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError } });
  } catch (error) {
    if (error instanceof OwnerAccessError) return rpcError(id, -32001, error.message, error.status);
    const safe = error instanceof CloudTrackingError || error instanceof DailySummaryError ? { code: error.code, message: error.message } : { code: "tracking_unavailable", message: "The tracking request could not be completed." };
    return response({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ status: "error", ...safe }) }], structuredContent: { status: "error", ...safe }, isError: true } });
  }
}
export async function GET() { return response({ error: "Use a JSON-RPC POST request. Client records are private." }, 405); }
