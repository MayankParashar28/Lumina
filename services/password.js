// 🔐 Password hashing.
//
// Uses scrypt (built into Node, no extra dependency), which is deliberately slow
// and memory-hard, so a leaked database can't be brute-forced at GPU speed. This
// replaces the original single-round HMAC-SHA256 hashing.
//
// Legacy accounts are not broken: `verifyPassword` still recognises the old
// format, and `isLegacyHash` lets the login path transparently re-hash a user's
// password to scrypt the next time they sign in successfully.
const { randomBytes, scrypt, timingSafeEqual, createHmac } = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(scrypt);

// N=16384 needs 128 * N * r = 16MB of memory per hash and lands around
// 50-100ms on typical hardware: expensive to attack in bulk, cheap enough for
// a single login request.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const PREFIX = "scrypt$";

// Stored format: scrypt$<N>$<r>$<p>$<derived-key-hex>, with the salt kept in the
// existing `salt` column so the user schema doesn't change shape.
async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(String(password), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  });
  return {
    salt,
    hash: `${PREFIX}${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${derived.toString("hex")}`,
  };
}

// True for hashes written before the scrypt migration.
function isLegacyHash(stored) {
  return typeof stored === "string" && stored.length > 0 && !stored.startsWith(PREFIX);
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), "hex");
  const bufB = Buffer.from(String(b), "hex");
  // timingSafeEqual throws on a length mismatch, so compare lengths first. The
  // length of a hash isn't secret, only its contents.
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function verifyPassword(password, stored, salt) {
  if (!stored || !salt) return false;

  if (isLegacyHash(stored)) {
    const legacy = createHmac("sha256", salt).update(String(password)).digest("hex");
    return safeEqualHex(legacy, stored);
  }

  const [, n, r, p, hex] = stored.split("$");
  if (!hex) return false;
  try {
    const derived = await scryptAsync(String(password), salt, Buffer.from(hex, "hex").length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return safeEqualHex(derived.toString("hex"), hex);
  } catch (_) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, isLegacyHash };
