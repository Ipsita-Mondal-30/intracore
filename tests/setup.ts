const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1):/.test(url)) {
  throw new Error(`Refusing to run tests against a non-local database: ${url.replace(/:[^:@/]*@/, ":***@")}`);
}
