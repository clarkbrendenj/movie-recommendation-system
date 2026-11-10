/** App-owned password and session primitives, using the Workers WebCrypto API. */
export const PASSWORD_ITERATIONS = 100_000;
export const SESSION_COOKIE = "afterglow_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

/** @param {Uint8Array} bytes */
function hex(bytes) { return [...bytes].map(value => value.toString(16).padStart(2, "0")).join(""); }
/** @param {string} value */
function unhex(value) { return Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16)); }

/** @param {number} [length] */
export function randomToken(length = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(length)));
}

/** @param {string} value */
export async function hashToken(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

/** @param {unknown} value */
export function normalizeUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return /^[a-z0-9_]{3,32}$/.test(username) ? username : null;
}

/** @param {unknown} value */
export function validPassword(value) {
  return typeof value === "string" && value.length >= 10 && value.length <= 128;
}

/** @param {string} password @param {Uint8Array} salt @param {number} iterations */
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** Fresh salt for each password; self-describing digest permits future upgrades. @param {string} password */
export async function hashPassword(password) {
  if (!validPassword(password)) throw new RangeError("Password must contain 10–128 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${hex(salt)}$${hex(await derive(password, salt, PASSWORD_ITERATIONS))}`;
}

export const DUMMY_PASSWORD_DIGEST = `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${"0".repeat(32)}$${"0".repeat(64)}`;

/** Same KDF work for nonexistent accounts; no digest or credential is returned to clients. @param {string} password @param {string} digest */
export async function verifyPassword(password, digest) {
  const parts = digest.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256" || !/^\d+$/.test(parts[1])
      || !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < PASSWORD_ITERATIONS || iterations > 100_000 || !validPassword(password)) return false;
  const actual = await derive(password, unhex(parts[2]), iterations);
  const expected = unhex(parts[3]);
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < actual.length; index++) mismatch |= actual[index] ^ expected[index];
  return mismatch === 0;
}

/** @param {string|null} cookieHeader */
export function sessionToken(cookieHeader) {
  if (!cookieHeader || cookieHeader.length > 16384) return null;
  const pair = cookieHeader.split(";").map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`));
  const value = pair?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/** @param {string} token @param {string} url @param {boolean} [expired] */
export function sessionCookie(token, url, expired = false) {
  if (!expired && !/^[a-f0-9]{64}$/.test(token)) throw new RangeError("Invalid session token.");
  const secure = new URL(url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${expired ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : SESSION_SECONDS}${secure}`;
}
