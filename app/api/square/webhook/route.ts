import { handleSquareWebhook } from "@/lib/square-sync";

export const dynamic = "force-dynamic";
// This endpoint intentionally accepts no browser owner identity. Only Square's
// fixed-URL raw-body HMAC authenticates it; no unsigned payload can write money.
export async function POST(request: Request) { return handleSquareWebhook(request); }
export async function GET() { return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }
