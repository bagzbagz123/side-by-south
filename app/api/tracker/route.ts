import { OwnerAccessError, requireTrackerOwner } from "@/lib/owner-access";
import { readJsonRequest, readTracker, TrackerError, trackerAction } from "@/lib/tracker-store";

export const dynamic = "force-dynamic";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" } });
function failure(error: unknown) {
  if (error instanceof OwnerAccessError || error instanceof TrackerError) return response({ error: error.message }, error.status);
  return response({ error: "The tracker is temporarily unavailable. Please try again." }, 500);
}
export async function GET() {
  try { await requireTrackerOwner(); return response(await readTracker()); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try { const owner = await requireTrackerOwner(); return response(await trackerAction(await readJsonRequest(request, 32768), owner.userId)); }
  catch (error) { return failure(error); }
}
