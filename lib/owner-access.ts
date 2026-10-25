import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";

// The deployment supplies authenticated identity headers. A signed-in visitor
// still needs this explicit owner allowlist before accessing any client records.
const OWNER_EMAIL_SHA256 = "30cea5cb0bec94f8afd3e5243357af74af0f617da63b2639e4a8958978ca4c3d";

export function isDevelopment(): boolean {
  return (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
}

export class OwnerAccessError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "OwnerAccessError";
  }
}

export async function isOwner(user: ChatGPTUser | null): Promise<boolean> {
  if (!user?.userId || !user.email) return false;
  if (isDevelopment() && user.userId === "local_seedy" && user.email === "seedy@sites.test") return true;
  const normalized = user.email.trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return hash === OWNER_EMAIL_SHA256;
}

export async function requireTrackerOwner(): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (!user) throw new OwnerAccessError(401, "Sign in to view this private tracker.");
  if (!(await isOwner(user))) throw new OwnerAccessError(403, "This tracker is available only to its owner.");
  return user;
}
