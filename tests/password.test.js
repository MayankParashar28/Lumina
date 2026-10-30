// Password hashing: scrypt, with transparent upgrade of the old single-round
// HMAC-SHA256 hashes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");

const { hashPassword, verifyPassword, isLegacyHash } = require("../services/password");

test("hashPassword produces a tagged scrypt hash with a fresh salt", async () => {
  const a = await hashPassword("correct horse battery staple");
  const b = await hashPassword("correct horse battery staple");

  assert.match(a.hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+$/);
  assert.notEqual(a.salt, b.salt, "each hash must get its own salt");
  assert.notEqual(a.hash, b.hash, "same password must not produce the same hash");
  assert.ok(!a.hash.includes("correct horse"), "hash must not embed the password");
});

test("verifyPassword accepts the right password and rejects wrong ones", async () => {
  const { salt, hash } = await hashPassword("s3cret-password");

  assert.equal(await verifyPassword("s3cret-password", hash, salt), true);
  assert.equal(await verifyPassword("s3cret-passwore", hash, salt), false);
  assert.equal(await verifyPassword("", hash, salt), false);
  assert.equal(await verifyPassword("s3cret-password", hash, "wrong-salt"), false);
});

test("verifyPassword handles missing inputs without throwing", async () => {
  assert.equal(await verifyPassword("x", null, "salt"), false);
  assert.equal(await verifyPassword("x", "scrypt$16384$8$1$", "salt"), false);
  assert.equal(await verifyPassword("x", "hash", null), false);
});

test("legacy HMAC hashes still verify, and are recognised as legacy", async () => {
  const salt = "a".repeat(32);
  const legacy = createHmac("sha256", salt).update("old-password").digest("hex");

  assert.equal(isLegacyHash(legacy), true);
  assert.equal(await verifyPassword("old-password", legacy, salt), true);
  assert.equal(await verifyPassword("not-it", legacy, salt), false);

  const { hash } = await hashPassword("old-password");
  assert.equal(isLegacyHash(hash), false, "scrypt hashes must not look legacy");
});

test("scrypt is slow enough to be worth something", async () => {
  const { salt, hash } = await hashPassword("timing-check");
  const started = process.hrtime.bigint();
  await verifyPassword("timing-check", hash, salt);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // The point of scrypt is that it is NOT a fast hash. A single-round HMAC lands
  // in the microseconds; anything in that range means the work factor is gone.
  assert.ok(ms > 5, `expected a deliberately slow hash, took ${ms.toFixed(2)}ms`);
});
