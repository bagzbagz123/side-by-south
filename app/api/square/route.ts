import { OwnerAccessError, requireTrackerOwner } from "@/lib/owner-access";
import { readJsonRequest, TrackerError } from "@/lib/tracker-store";
import { getSquareTrackerState, squareTrackerAction, SquareSyncError } from "@/lib/square-sync";
export const dynamic = "force-dynamic";
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
function failure(error: unknown) {
  if (error instanceof OwnerAccessError || error instanceof TrackerError || error instanceof SquareSyncError) return response({ error: error.message, ...(error instanceof SquareSyncError ? { code: error.code } : {}) }, error.status);
  return response({ error: "Square tracking is temporarily unavailable.", code: "storage_unavailable" }, 503);
}
export async function GET() { try { await requireTrackerOwner(); return response(await getSquareTrackerState()); } catch (error) { return failure(error); } }
export async function POST(request: Request) { try { const owner = await requireTrackerOwner(); return response(await squareTrackerAction(await readJsonRequest(request), owner.userId)); } catch (error) { return failure(error); } }
