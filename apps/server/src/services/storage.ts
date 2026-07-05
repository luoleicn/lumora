import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.js";

export const s3 = new S3Client({
  endpoint: env.s3Endpoint,
  region: env.s3Region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.s3AccessKeyId,
    secretAccessKey: env.s3SecretAccessKey
  }
});

const publicS3 = new S3Client({
  endpoint: env.s3PublicEndpoint,
  region: env.s3Region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.s3AccessKeyId,
    secretAccessKey: env.s3SecretAccessKey
  }
});

let bucketReady = false;

export async function ensureBucket() {
  if (bucketReady) {
    return;
  }

  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.s3Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.s3Bucket }));
  }

  bucketReady = true;
}

export function objectKeyForFile(userId: string, sha256: string, fileName: string) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160) || "paper.pdf";
  return `${userId}/${sha256}/${safeName}`;
}

export async function createUploadUrl(objectKey: string, mime: string) {
  await ensureBucket();

  return getSignedUrl(
    publicS3,
    new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: objectKey,
      ContentType: mime
    }),
    { expiresIn: 60 * 15 }
  );
}

export async function createDownloadUrl(objectKey: string) {
  await ensureBucket();

  return getSignedUrl(
    publicS3,
    new GetObjectCommand({
      Bucket: env.s3Bucket,
      Key: objectKey
    }),
    { expiresIn: 60 * 15 }
  );
}
