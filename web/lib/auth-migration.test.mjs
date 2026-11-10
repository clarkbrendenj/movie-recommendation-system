import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("the appended schema migration preserves legacy ratings and permits only exact display tenths", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(new URL("../drizzle/0000_mushy_bloodstrike.sql", import.meta.url), "utf8"));
    db.prepare("INSERT INTO ratings(user_id,movie_id,rating,updated_at) VALUES (?,?,?,?)").run("legacy_owner", 1, 4.5, 12345);
    db.exec(readFileSync(new URL("../drizzle/0001_massive_luminals.sql", import.meta.url), "utf8"));
    const row = db.prepare("SELECT * FROM ratings WHERE user_id='legacy_owner'").get();
    assert.deepEqual({ ...row }, { user_id: "legacy_owner", movie_id: 1, rating: 4.5, updated_at: 12345 });
    const insert = db.prepare("INSERT INTO ratings(user_id,movie_id,rating,updated_at) VALUES ('legacy_owner',?,?,1)");
    insert.run(2, 3.55); // 7.1/10 display score.
    insert.run(3, 4.95); // 9.9/10 display score.
    insert.run(4, .5);
    insert.run(5, 5);
    for (const rating of [3.555, .49, 5.05]) assert.throws(() => insert.run(20, rating));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(value => value.name);
    for (const expected of ["users", "auth_sessions", "auth_rate_limits", "friendships", "lists", "list_members", "list_items", "rating_queue_statuses"]) {
      assert.ok(tables.includes(expected));
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
