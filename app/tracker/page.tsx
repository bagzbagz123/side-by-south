import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { isOwner } from "@/lib/owner-access";
import TrackerClient from "./tracker-client";
import "./tracker.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Private campaign tracker | Side by South", robots: { index: false, follow: false } };

export default async function TrackerPage() {
  const user = await requireChatGPTUser("/tracker");
  if (!(await isOwner(user))) {
    return <main className="sbs-tracker sbs-access"><p className="tracker-kicker">Side by South · Private</p><h1>Owner access required.</h1><p>This campaign tracker is available only to the Side by South owner account.</p><a href="/">Return to Side by South</a></main>;
  }
  return <TrackerClient />;
}
