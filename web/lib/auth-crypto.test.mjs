import test from "node:test";
import assert from "node:assert/strict";
import { createHash, pbkdf2Sync } from "node:crypto";
import {
  hashPassword, verifyPassword, DUMMY_PASSWORD_DIGEST, PASSWORD_ITERATIONS,
  hashToken, randomToken, sessionToken, sessionCookie, SESSION_COOKIE, SESSION_SECONDS,
  normalizeUsername, validPassword,
} from "./auth-crypto.mjs";

test("usernames have a stable case-insensitive canonical identity", () => {
  assert.equal(normalizeUsername("  Clark_7  "), "clark_7");
  for (const value of ["ab", "a".repeat(33), "two names", "../admin", "José", "<script>", null, 7]) {
    assert.equal(normalizeUsername(value), null);
  }
  assert.equal(validPassword("a".repeat(10)), true);
  assert.equal(validPassword("a".repeat(128)), true);
  for (const value of ["a".repeat(9), "a".repeat(129), null, 10]) assert.equal(validPassword(value), false);
});

test("password digests use independent random salts and match an external PBKDF2 oracle", async () => {
  const password = "An example password 42!";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  const [algorithm, iterations, salt, digest] = first.split("$");
  assert.equal(algorithm, "pbkdf2-sha256");
  assert.equal(Number(iterations), PASSWORD_ITERATIONS);
  assert.equal(salt.length, 32);
  assert.equal(digest, pbkdf2Sync(password, Buffer.from(salt, "hex"), PASSWORD_ITERATIONS, 32, "sha256").toString("hex"));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("A different password!", first), false);
  assert.equal(await verifyPassword(password, DUMMY_PASSWORD_DIGEST), false);
});

test("invalid digest formats and unsupported iteration counts fail closed", async () => {
  for (const value of ["plain password", "pbkdf2-sha256$1$" + "0".repeat(32) + "$" + "0".repeat(64),
    "pbkdf2-sha256$100001$" + "0".repeat(32) + "$" + "0".repeat(64),
    DUMMY_PASSWORD_DIGEST.replace("pbkdf2-sha256", "md5"), DUMMY_PASSWORD_DIGEST.replace(/0$/, "z")]) {
    assert.equal(await verifyPassword("A valid length password!", value), false);
  }
  await assert.rejects(hashPassword("short"));
});

test("session tokens have strong entropy and are stored via an independently checked digest", async () => {
  const tokens = Array.from({ length: 100 }, () => randomToken());
  assert.equal(new Set(tokens).size, 100);
  assert.ok(tokens.every(token => /^[a-f0-9]{64}$/.test(token)));
  const digest = await hashToken(tokens[0]);
  assert.equal(digest, createHash("sha256").update(tokens[0]).digest("hex"));
  assert.notEqual(digest, tokens[0]);
});

test("session parsing rejects malformed, shadowed and oversized cookies", () => {
  const token = "a".repeat(64);
  assert.equal(sessionToken(`other=x; ${SESSION_COOKIE}=${token}; theme=dark`), token);
  for (const value of [null, "", `${SESSION_COOKIE}=short`, `${SESSION_COOKIE}=${"z".repeat(64)}`,
    `prefix_${SESSION_COOKIE}=${token}`, `${SESSION_COOKIE}=bad; ${SESSION_COOKIE}=${token}`, "x".repeat(20000)]) {
    assert.equal(sessionToken(value), null);
  }
});

test("session cookies are HttpOnly and same-site with Secure on HTTPS and an explicit revoke", () => {
  const token = "a".repeat(64);
  const secure = sessionCookie(token, "https://example.test");
  assert.ok(secure.startsWith(`${SESSION_COOKIE}=${token};`));
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /; Secure$/);
  assert.ok(secure.includes(`Max-Age=${SESSION_SECONDS}`));
  assert.ok(!sessionCookie(token, "http://127.0.0.1:5173").includes("Secure"));
  assert.match(sessionCookie("", "https://example.test", true), /afterglow_session=;.*Max-Age=0; Secure/);
  assert.throws(() => sessionCookie("bad", "https://example.test"));
});
