import test from "node:test";
import assert from "node:assert/strict";
import { fetchAuthenticatedDownload } from "./authenticated-download.ts";

test("authenticated downloads reject foreign origins before sending credentials", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    return new Response("document");
  });
  for (const url of [
    "https://attacker.example/file",
    "//attacker.example/file",
    "http://styrerommet.no/file",
    "https://user:pass@styrerommet.no/file",
  ]) {
    await assert.rejects(
      fetchAuthenticatedDownload(url, "https://styrerommet.no", {
        Cookie: "test-session",
      }),
      /must use/,
    );
  }
  assert.equal(requests.length, 0);
});

test("authenticated downloads check every redirect and keep cookies on the service origin", async (t) => {
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      requests.push(url);
      assert.equal(options.redirect, "manual");
      assert.equal(
        (options.headers as Record<string, string>).Cookie,
        "test-session",
      );
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/file" },
      });
    },
  );
  await assert.rejects(
    fetchAuthenticatedDownload("/file", "https://styrerommet.no", {
      Cookie: "test-session",
    }),
    /must use/,
  );
  assert.deepEqual(requests, ["https://styrerommet.no/file"]);
});

test("authenticated downloads follow same-origin redirects", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "/actual-file" },
        })
      : new Response("document"),
  );
  const response = await fetchAuthenticatedDownload(
    "/file",
    "https://vibbo.no",
    {},
  );
  assert.equal(await response.text(), "document");
  assert.equal(calls, 2);
});
