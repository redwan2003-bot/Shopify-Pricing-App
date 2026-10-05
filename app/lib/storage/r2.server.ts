import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DEFAULT_EXPIRY_SECONDS = 900;
const MAX_EXPIRY_SECONDS = 3600;
const OBJECT_KEY_PATTERN = /^orders\/[A-Za-z0-9_-]{1,80}\/(artwork|proofs)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,480}$/;

export type PrivateStorageConfig = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string };
export type PrivateObjectMetadata = { objectKey: string; contentType: string; contentLength?: number };

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing ${name}`);
  return trimmed;
}

export function privateStorageConfig(env: NodeJS.ProcessEnv = process.env): PrivateStorageConfig {
  const endpoint = required("R2_ENDPOINT", env.R2_ENDPOINT);
  if (!/^https:\/\//i.test(endpoint)) throw new Error("R2_ENDPOINT must use https");
  return { endpoint: endpoint.replace(/\/$/, ""), bucket: required("R2_BUCKET", env.R2_BUCKET), accessKeyId: required("R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID), secretAccessKey: required("R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY), region: env.R2_REGION?.trim() || "auto" };
}

export function assertPrivateObjectKey(objectKey: string, expectedKind?: "artwork" | "proofs"): string {
  const key = objectKey.trim();
  if (!OBJECT_KEY_PATTERN.test(key) || key.includes("..") || key.includes("//")) throw new Error("Invalid private object key");
  if (expectedKind && !key.includes(`/${expectedKind}/`)) throw new Error("Object key does not match expected private object type");
  return key;
}

function expiry(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EXPIRY_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPIRY_SECONDS) throw new Error(`Expiry must be an integer between 1 and ${MAX_EXPIRY_SECONDS} seconds`);
  return value;
}

export function createPrivateObjectStorage(config: PrivateStorageConfig) {
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: false, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  return {
    async createUploadUrl(metadata: PrivateObjectMetadata, expiresIn?: number) {
      const objectKey = assertPrivateObjectKey(metadata.objectKey);
      if (!metadata.contentType.trim() || metadata.contentType.length > 120) throw new Error("Invalid content type");
      if (metadata.contentLength !== undefined && (!Number.isInteger(metadata.contentLength) || metadata.contentLength < 1 || metadata.contentLength > 50_000_000)) throw new Error("Invalid content length");
      const command = new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, ContentType: metadata.contentType, ...(metadata.contentLength === undefined ? {} : { ContentLength: metadata.contentLength }) });
      return { objectKey, url: await getSignedUrl(client, command, { expiresIn: expiry(expiresIn) }) };
    },
    async createDownloadUrl(objectKey: string, expiresIn?: number) {
      const key = assertPrivateObjectKey(objectKey);
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: key, ResponseContentDisposition: "attachment" });
      return { objectKey: key, url: await getSignedUrl(client, command, { expiresIn: expiry(expiresIn) }) };
    },
    async head(objectKey: string) {
      const key = assertPrivateObjectKey(objectKey);
      const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return { objectKey: key, contentType: result.ContentType, contentLength: result.ContentLength, etag: result.ETag };
    },
  };
}
