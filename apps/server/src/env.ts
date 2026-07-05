export const env = {
  port: Number(process.env.PORT ?? 3838),
  jwtSecret: process.env.JWT_SECRET ?? "dev-change-me",
  bootstrapEmail: process.env.LUMORA_BOOTSTRAP_EMAIL ?? "reader@example.com",
  bootstrapPassword: process.env.LUMORA_BOOTSTRAP_PASSWORD ?? "change-me",
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3838",
  clientBaseUrl: process.env.CLIENT_BASE_URL ?? "http://localhost:5173",
  s3Endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
  s3Region: process.env.S3_REGION ?? "us-east-1",
  s3Bucket: process.env.S3_BUCKET ?? "lumora",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? "lumora",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "lumora-secret",
  mendeleyClientId: process.env.MENDELEY_CLIENT_ID,
  mendeleyClientSecret: process.env.MENDELEY_CLIENT_SECRET
};
