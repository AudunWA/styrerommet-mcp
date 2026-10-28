import assert from "node:assert/strict";
import test from "node:test";
import { getCantorChartOfAccounts } from "./cantor-client.ts";

test("Cantor account lists use the current UI API with the selected setup and reporting period", async (t) => {
  const previous = { ...process.env };
  process.env.STYREROMMET_COOKIE = "session=test";
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.hostname === "styrerommet.no")
      return new Response(null, {
        status: 302,
        headers: { location: "https://cws.obos.no/cantor/test-session" },
      });
    if (url.pathname === "/cantor/test-session")
      return new Response(null, {
        headers: { "set-cookie": "ASP.NET_SessionId=test; Path=/" },
      });
    if (url.pathname.endsWith("/kontoplan-oppsett"))
      return Response.json([{ id: "full", displayName: "Full chart" }]);
    assert.equal(url.pathname, "/cantor/api/ui/firma/12345/kontoplan");
    assert.equal(url.searchParams.get("oppsettId"), "full");
    assert.equal(url.searchParams.get("aar"), "2026");
    assert.equal(url.searchParams.get("periode"), "10");
    return Response.json({
      oppsettId: "full",
      displayName: "Full chart",
      rows: [["3000", "Income", 1250]],
      columns: [],
    });
  });
  try {
    const result = await getCantorChartOfAccounts("12345", { year: 2026, period: 10 });
    assert.equal(requests.length, 4);
    assert.equal(result.accounts[0]?.kontonr, "3000");
    assert.equal(result.accounts[0]?.virkelig, 1250);
  } finally {
    process.env = previous;
  }
});
