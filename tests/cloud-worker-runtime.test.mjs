import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("real Workers runtime verifies fixed Meta responses and blocks redirects without forwarding credentials", async () => {
  const root = resolve(import.meta.dirname, "..");
  const bundle = await build({
    stdin: { contents: 'import { verifyMetaConnection } from "./lib/cloud-tracking.ts"; export default { async fetch() { return Response.json(await verifyMetaConnection()); } };', resolveDir: root },
    bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:workers"],
  });
  const calls = [];
  let redirect = false;
  const runtime = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-05-22", cf: false,
    bindings: { META_ADS_READ_TOKEN: "local-runtime-fixture-not-a-real-credential" },
    d1Databases: ["DB"],
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ hostname: url.hostname, path: url.pathname, authorization: request.headers.get("authorization") });
      assert.equal(url.hostname, "graph.facebook.com");
      assert.equal(url.searchParams.has("access_token"), false);
      if (redirect) return new Response(null, { status: 302, headers: { location: "https://never-follow.example/credential-target" } });
      if (url.pathname === "/v26.0/act_2313142399498951") return Response.json({ id: "act_2313142399498951", account_id: "2313142399498951", currency: "USD", timezone_name: "America/New_York", account_status: 1 });
      if (url.pathname === "/v26.0/120255494608980357") return Response.json({ id: "120255494608980357", account_id: "2313142399498951" });
      throw new Error("Unexpected local fixture endpoint");
    },
  });
  try {
    const database = await runtime.getD1Database("DB");
    const migration = readFileSync(resolve(root, "drizzle/0002_freezing_blink.sql"), "utf8");
    const stateTable = migration.match(/CREATE TABLE `tracking_cloud_state`[\s\S]*?;/)[0];
    await database.prepare(stateTable).run();
    const verified = await (await runtime.dispatchFetch("https://site.test/verify")).json();
    assert.equal(verified.status, "verified");
    assert.equal(calls.length, 2);
    assert.equal(calls.every(call => call.authorization === "Bearer local-runtime-fixture-not-a-real-credential"), true);
    redirect = true;
    const before = calls.length;
    const blocked = await (await runtime.dispatchFetch("https://site.test/verify")).json();
    assert.equal(blocked.status, "error");
    assert.equal(blocked.code, "meta_redirect_blocked");
    assert.equal(calls.length, before + 1);
    assert.equal(JSON.stringify(blocked).includes("never-follow.example"), false);
    assert.equal(JSON.stringify(blocked).includes("local-runtime-fixture"), false);
  } finally { await runtime.dispose(); }
});
