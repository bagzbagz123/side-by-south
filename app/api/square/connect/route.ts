import { OwnerAccessError, requireTrackerOwner } from "@/lib/owner-access";
import { beginSquareConnect, SquareSyncError } from "@/lib/square-sync";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const owner = await requireTrackerOwner(); return await beginSquareConnect(request, owner.userId); }
  catch (error) { const known = error instanceof OwnerAccessError || error instanceof SquareSyncError; return Response.json({ error: known ? error.message : "Square connection is temporarily unavailable.", ...(error instanceof SquareSyncError ? { code: error.code } : {}) }, { status: known ? error.status : 503, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } }); }
}
