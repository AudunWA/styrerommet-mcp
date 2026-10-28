import test from "node:test";
import assert from "node:assert/strict";
import {
  graphqlQuery,
  getMimeType,
  getUploadRoute,
  uploadAttachment,
} from "./client.ts";

test("getMimeType and getUploadRoute map extensions and routes correctly", () => {
  assert.equal(getMimeType("document.pdf"), "application/pdf");
  assert.equal(getUploadRoute("application/pdf"), "attachment");

  assert.equal(getMimeType("photo.png"), "image/png");
  assert.equal(getUploadRoute("image/png"), "attachment");

  assert.equal(getMimeType("movie.mov"), "video/quicktime");
  assert.equal(getUploadRoute("video/quicktime"), "attachment");

  assert.equal(getMimeType("data.csv"), "text/csv");
  assert.equal(getUploadRoute("text/csv"), "attachment");
});

test("uploadAttachment throws clean error when file does not exist", async () => {
  await assert.rejects(async () => {
    await uploadAttachment("non-existent-file-xyz.pdf");
  }, /File not found for upload/i);
});

test("graphqlQuery throws clean error without crashing process when credentials missing and auto-login disabled", async () => {
  const origCookie = process.env.STYREROMMET_COOKIE;
  const origNoAuto = process.env.NO_AUTO_LOGIN;

  try {
    delete process.env.STYREROMMET_COOKIE;
    process.env.NO_AUTO_LOGIN = "true";

    await assert.rejects(async () => {
      await graphqlQuery("dummyQuery", "query { dummy }");
    }, /Authentication required/i);
  } finally {
    if (origCookie !== undefined) {
      process.env.STYREROMMET_COOKIE = origCookie;
    } else {
      delete process.env.STYREROMMET_COOKIE;
    }
    if (origNoAuto !== undefined) {
      process.env.NO_AUTO_LOGIN = origNoAuto;
    } else {
      delete process.env.NO_AUTO_LOGIN;
    }
  }
});
