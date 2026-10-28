import { OwnerAccessError, requireTrackerOwner } from "@/lib/owner-access";
import { completeSquareConnect, SquareSyncError } from "@/lib/square-sync";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const owner = await requireTrackerOwner(); return await completeSquareConnect(request, owner.userId); }
  catch (error) { const known = error instanceof OwnerAccessError || error instanceof SquareSyncError; return Response.json({ error: known ? error.message : "Square connection could not be completed." }, { status: known ? error.status : 503, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } }); }
}
