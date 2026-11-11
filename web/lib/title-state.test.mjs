import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { excludeWatched, validateTitleStatePatch } from './title-state-policy.mjs';

function migrate(db, name) { db.exec(readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8')); }

test('activity migration preserves all scores and backfills watched only for their real app-account owners', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, '0000_mushy_bloodstrike');
    migrate(db, '0001_massive_luminals');
    db.exec("INSERT INTO users(id,username,display_name,password_digest,friend_code,created_at) VALUES ('a','alice','Alice','test','friend-a',1),('b','bob','Bob','test','friend-b',1)");
    db.exec("INSERT INTO ratings(user_id,movie_id,rating,updated_at) VALUES ('a',1,1.5,123),('a',2,5,234),('b',1,4,345),('legacy_owner',1,4.5,456)");
    const previous = db.prepare('SELECT * FROM ratings ORDER BY user_id,movie_id').all();
    migrate(db, '0002_title_states');
    assert.deepEqual(db.prepare('SELECT * FROM ratings ORDER BY user_id,movie_id').all(), previous);
    assert.deepEqual(db.prepare('SELECT user_id,movie_id,liked,watched,updated_at FROM title_states ORDER BY user_id,movie_id').all().map(row => ({...row})), [
      {user_id:'a',movie_id:1,liked:0,watched:1,updated_at:123},
      {user_id:'a',movie_id:2,liked:0,watched:1,updated_at:234},
      {user_id:'b',movie_id:1,liked:0,watched:1,updated_at:345},
    ]);
    db.exec("UPDATE title_states SET liked=1 WHERE user_id='a' AND movie_id=1");
    assert.equal(db.prepare("SELECT rating FROM ratings WHERE user_id='a' AND movie_id=1").get().rating, 1.5);
    assert.equal(db.prepare("SELECT liked FROM title_states WHERE user_id='b' AND movie_id=1").get().liked, 0);
    const insert = db.prepare("INSERT INTO title_states(user_id,movie_id,liked,watched,updated_at) VALUES (?,?,?,?,1)");
    insert.run('a',3,1,0); // A like has no implicit watch or numeric score.
    insert.run('b',3,0,1); // Watched without rating.
    for (const values of [['a',4,2,0],['a',4,0,-1],['a',0,1,1],['missing-owner',4,0,1]]) assert.throws(() => insert.run(...values));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('activity patches reject coerced booleans and preserve omitted independent fields', () => {
  assert.deepEqual(validateTitleStatePatch({movieId:1,liked:true}), {liked:true});
  assert.deepEqual(validateTitleStatePatch({movieId:1,watched:false}), {watched:false});
  assert.deepEqual(validateTitleStatePatch({liked:false,watched:true}), {liked:false,watched:true});
  for (const patch of [{}, {liked:1}, {watched:'false'}, {liked:null}, {liked:true,watched:0}]) assert.throws(() => validateTitleStatePatch(patch), TypeError);
});

test('watched filtering fills the shelf without changing scores, rating counts, or independent likes', () => {
  const ranking = {movies:[{movieId:1,score:8},{movieId:2,score:7},{movieId:3,score:6},{movieId:4,score:5}],mode:'personalized',ratingsCount:1,likes:1};
  const states = [{movieId:1,watched:true,liked:false},{movieId:2,watched:false,liked:true}];
  const shelf = excludeWatched(ranking, states, 2);
  assert.deepEqual(shelf, {...ranking,movies:[ranking.movies[1],ranking.movies[2]]});
  assert.equal(shelf.movies[0], ranking.movies[1]);
  assert.equal(ranking.movies.length, 4);
});
