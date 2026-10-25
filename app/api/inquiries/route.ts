import { getChatGPTUser } from "@/app/chatgpt-auth";
import { isDevelopment, isOwner } from "@/lib/owner-access";
import { createInquiry, readJsonRequest, TrackerError } from "@/lib/tracker-store";

export const dynamic = "force-dynamic";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function POST(request: Request) {
  try {
    const input = await readJsonRequest(request);
    if ("alertTest" in input) {
      if (typeof input.alertTest !== "boolean" || input.isTest !== true) throw new TrackerError(400, "Alert tests require a test inquiry and a true or false alert choice.");
      if (!(await isOwner(await getChatGPTUser()))) throw new TrackerError(403, "Only the site owner can request an alert test.");
    }
    if (input.isTest === true && !isDevelopment() && !(await isOwner(await getChatGPTUser()))) throw new TrackerError(400, "Test inquiries are available only to the site owner.");
    return response(await createInquiry(input), 201);
  } catch (error) {
    if (error instanceof TrackerError) return response({ error: error.message }, error.status);
    // Never log submitted personal details or SQL parameters.
    return response({ error: "We couldn't save your inquiry. Please try again or message @sidebysouth on Instagram." }, 500);
  }
}
export async function GET() { return response({ error: "Inquiry records are private." }, 405); }
