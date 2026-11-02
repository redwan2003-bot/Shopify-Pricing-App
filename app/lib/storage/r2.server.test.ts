import test from "node:test";
import assert from "node:assert/strict";
import { assertPrivateObjectKey, createPrivateObjectStorage, privateStorageConfig } from "./r2.server.ts";

test("R2 config requires all private credentials", () => {
  assert.throws(() => privateStorageConfig({ R2_ENDPOINT: "https://example.r2.cloudflarestorage.com" } as unknown as NodeJS.ProcessEnv), /Missing R2_BUCKET/);
  assert.deepEqual(privateStorageConfig({ R2_ENDPOINT: "https://example.r2.cloudflarestorage.com/", R2_BUCKET: "imprintid-private", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret" } as unknown as NodeJS.ProcessEnv), { endpoint: "https://example.r2.cloudflarestorage.com", bucket: "imprintid-private", accessKeyId: "access", secretAccessKey: "secret", region: "auto" });
});

test("private object keys are scoped to an order and workflow asset type", () => {
  assert.equal(assertPrivateObjectKey("orders/wf_123/artwork/logo.ai", "artwork"), "orders/wf_123/artwork/logo.ai");
  assert.throws(() => assertPrivateObjectKey("public/logo.ai"), /Invalid private object key/);
  assert.throws(() => assertPrivateObjectKey("orders/wf_123/../artwork/logo.ai"), /Invalid private object key/);
  assert.throws(() => assertPrivateObjectKey("orders/wf_123/proofs/proof.pdf", "artwork"), /does not match/);
});

test("presigned upload and download URLs are generated without contacting the bucket", async () => {
  const storage = createPrivateObjectStorage(privateStorageConfig({ R2_ENDPOINT: "https://example.r2.cloudflarestorage.com", R2_BUCKET: "imprintid-private", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret" } as unknown as NodeJS.ProcessEnv));
  const upload = await storage.createUploadUrl({ objectKey: "orders/wf_123/artwork/logo.ai", contentType: "application/postscript", contentLength: 123 }, 60);
  const download = await storage.createDownloadUrl("orders/wf_123/proofs/proof.pdf", 60);
  assert.match(upload.url, /X-Amz-Signature=/);
  assert.match(download.url, /X-Amz-Signature=/);
});
