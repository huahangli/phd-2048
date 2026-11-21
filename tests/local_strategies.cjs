const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");

const gameCode = vm.createContext({ performance });
for (const filename of ["grid.js", "tile.js", "game_manager.js", "local_strategies.js"]) {
  const file = path.join(__dirname, "../js", filename);
  vm.runInContext(readFileSync(file, "utf8"), gameCode, { filename: file });
}

const { GameManager, Grid, Tile, chooseLocalMove, slideOutcomes, spawnExpectation } = gameCode;
const strategies = ["greedy", "heuristic", "expectimax", "expectimax_deep"];
const stepMs = 800;

function headless(rows = Array.from({ length: 4 }, () => Array(4).fill(null))) {
  const grid = new Grid(4);
  rows.forEach((row, y) => row.forEach((value, x) => {
    if (value !== null) grid.insertTile(new Tile({ x, y }, value));
  }));
  const position = GameManager.fromState({
    grid: grid.serialize(),
    score: 0,
    over: false,
    won: false,
    keepPlaying: true,
    maxTile: 4,
    garbCount: 0,
    karma: 0,
    relTime: null
  });
  position.setTimer = position.actuate = () => {};
  return position;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function verifyRules() {
  const game = headless([
    [2, 2, 4, null],
    [null, null, 4, null],
    [null, null, null, null],
    [null, null, null, null]
  ]);
  const before = game.serialize();
  const legal = game.availableDirections();
  const greedy = chooseLocalMove(before, "greedy", legal);
  assert.equal(greedy.values[0], 8);
  assert.equal(greedy.values[3], 4);
  for (const strategy of strategies) {
    const result = chooseLocalMove(before, strategy, legal, { now: 1234, stepMs });
    assert.ok(legal.includes(result.direction));
    assert.equal(result.depth, strategy.startsWith("expectimax") ? 2 : 1);
    assert.deepEqual(game.serialize(), before);
  }
  const garbage = headless([[8, 8, null, null], ...Array(3).fill(Array(4).fill(null))]);
  const outcomes = slideOutcomes(garbage.serialize(), 3);
  assert.deepEqual(Array.from(outcomes, outcome => outcome.game.score), [16, 0]);
  assert.ok(Math.abs(outcomes[0].probability - 0.8) < 1e-12);
  assert.ok(Math.abs(outcomes[1].probability - 0.2) < 1e-12);

  const spawn = headless([
    [2, 4, 8, 16],
    [32, 64, 2, 4],
    [null, null, null, null],
    [null, null, null, null]
  ]);
  const spawnState = spawn.serialize();
  const relationshipChance = spawnExpectation(spawn, 1000, branch => Number(branch.relTime === 1000));
  assert.ok(Math.abs(relationshipChance - 0.03) < 1e-12);
  assert.deepEqual(spawn.serialize(), spawnState);
  const crowded = headless([
    [2, 4, 8, 16],
    [32, 64, 2, 2],
    [null, null, null, null],
    [null, null, null, null]
  ]);
  const crowdedState = crowded.serialize();
  const deepCandidates = crowded.availableDirections();
  assert.ok(deepCandidates.length > 1);
  const deep = chooseLocalMove(crowdedState, "expectimax_deep", deepCandidates);
  assert.equal(deep.depth, 3);
  assert.ok(deepCandidates.includes(deep.direction));
  assert.deepEqual(crowded.serialize(), crowdedState);
  const searchCache = new Map();
  let ticks = 0;
  const options = { now: 1000, stepMs, searchCache, budgetMs: 20, clock: () => ticks++ };
  const bounded = chooseLocalMove(crowdedState, "expectimax_10", deepCandidates, options);
  assert.ok(deepCandidates.includes(bounded.direction));
  assert.ok(bounded.depth >= 1 && bounded.depth <= 10);
  assert.ok(bounded.stats.elapsedMs <= options.budgetMs + 1);
  assert.ok(searchCache.size > 0);
  const repeated = chooseLocalMove(crowdedState, "expectimax_10", deepCandidates, options);
  assert.ok(repeated.stats.hits > 0, "expected reuse across decisions");
  assert.deepEqual(crowded.serialize(), crowdedState);
  console.log("Passed legal moves, scoring, random branches, and non-mutating search.");
}

function play(strategy, seed) {
  const game = headless();
  const random = seededRandom(seed);
  let now = 1000;
  let turns = 0;
  let decisions = 0;
  let thinkMs = 0;
  const timings = [];
  const depths = {};
  const searchCache = new Map();
  let hits = 0;
  let lookups = 0;
  function result() {
    return {
      seed, score: game.score, largest: game.maxTile, turns, thinkMs, decisions,
      timings, depths, hits, lookups
    };
  }
  game.addRandomTile(random, now);
  game.addRandomTile(random, now);
  for (let attempt = 0; attempt < 30000 && !game.isGameTerminated(); attempt++) {
    if (game.relTime && now - game.relTime >= GameManager.relationshipDurationMs) game.unsetTimer();
    const legal = game.availableDirections();
    if (legal.length) {
      let direction = legal[0];
      if (legal.length > 1) {
        const start = performance.now();
        const choice = chooseLocalMove(game.serialize(), strategy, legal, { now, stepMs, searchCache });
        direction = choice.direction;
        const elapsed = performance.now() - start;
        timings.push(elapsed);
        thinkMs += elapsed;
        depths[choice.depth] = (depths[choice.depth] || 0) + 1;
        hits += choice.stats?.hits ?? 0;
        lookups += choice.stats?.lookups ?? 0;
        decisions++;
      }
      assert.ok(legal.includes(direction));
      if (game.move(direction, random, now)) turns++;
    } else if (!game.relTime) {
      return result();
    }
    now += stepMs;
  }
  assert.ok(game.isGameTerminated(), "game exceeded the attempt limit");
  return result();
}

verifyRules();
const count = Number(process.argv[2] ?? 0);
assert.ok(Number.isInteger(count) && count >= 0);
if (count) {
  const rows = [];
  const selected = process.argv.slice(3);
  assert.ok(selected.every(strategy => strategy === "expectimax_10" || strategies.includes(strategy)));
  const firstSeed = Number(process.env.PHD_2048_FIRST_SEED ?? 1);
  assert.ok(Number.isSafeInteger(firstSeed) && firstSeed > 0);
  for (const strategy of selected.length ? selected : strategies) {
    const games = Array.from({ length: count }, (_, index) => play(strategy, firstSeed + index));
    const sum = key => games.reduce((total, game) => total + game[key], 0);
    const timings = games.flatMap(game => game.timings).sort((a, b) => a - b);
    const depths = {};
    for (const game of games) {
      for (const [depth, count] of Object.entries(game.depths)) {
        depths[depth] = (depths[depth] || 0) + count;
      }
    }
    rows.push({
      strategy,
      games: count,
      meanScore: Math.round(sum("score") / count),
      bestScore: Math.max(...games.map(game => game.score)),
      largestTile: Math.max(...games.map(game => game.largest)),
      meanDecisionMs: (sum("thinkMs") / sum("decisions")).toFixed(3)
    });
    console.log(strategy, "scores", games.map(game => game.score).join(", "));
    console.log("benchmark", JSON.stringify({
      strategy, seeds: games.map(game => game.seed), scores: games.map(game => game.score),
      depths, hits: sum("hits"), lookups: sum("lookups"),
      decisions: sum("decisions"), thinkMs: sum("thinkMs"),
      p95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
      maxMs: timings[timings.length - 1]
    }));
  }
  console.table(rows);
}
