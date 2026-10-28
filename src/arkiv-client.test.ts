import assert from "node:assert/strict";
import test from "node:test";
import { getArchivePath, reloadArkivTokens, searchArchive } from "./arkiv-client.ts";

function trailer(status: number): string {
  const payload = Buffer.from(`grpc-status:${status}\r\n`);
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0x80;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame.toString("base64");
}

test("archive HTTP 200 responses report gRPC authentication and service failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(trailer(16)));
  const previous = { ...process.env };
  try {
    process.env.STYREROMMET_ORG_ID = "12345";
    process.env.STYREROMMET_ARKIV_TOKEN = "test-token";
    process.env.NO_AUTO_LOGIN = "true";
    reloadArkivTokens();
    await assert.rejects(getArchivePath("/"), /authentication expired or was rejected/);
    await assert.rejects(searchArchive("minutes"), /authentication expired or was rejected/);

    t.mock.method(globalThis, "fetch", async () => new Response(trailer(7)));
    await assert.rejects(searchArchive("minutes"), /gRPC status 7/);

    t.mock.method(globalThis, "fetch", async () => new Response(trailer(0)));
    assert.deepEqual(await searchArchive("minutes"), []);
  } finally {
    process.env = previous;
    reloadArkivTokens();
  }
});

test("archive does not send a known-expired token after refresh and sign-in fail", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Expired token must not be sent");
  });
  const previous = { ...process.env };
  try {
    process.env.STYREROMMET_ORG_ID = "12345";
    process.env.STYREROMMET_ARKIV_TOKEN = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    delete process.env.STYREROMMET_COOKIE;
    delete process.env.STYREROMMET_ARKIV_COOKIE;
    process.env.NO_AUTO_LOGIN = "true";
    reloadArkivTokens();
    await assert.rejects(getArchivePath("/"), /token is missing or expired/);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    process.env = previous;
    reloadArkivTokens();
  }
});
