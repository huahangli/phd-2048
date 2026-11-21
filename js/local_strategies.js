const strategyLabels = {
  jev: "Jev",
  llm: "LLM",
  greedy: "即时得分贪心",
  heuristic: "一步棋盘评估",
  expectimax: "Expectimax",
  expectimax_deep: "Expectimax 深搜",
  expectimax_10: "Expectimax 最多 10 步"
};

const maxSearchDepth = 10;
const searchBudgetMs = 50;
const maxSearchCacheEntries = 50000;

function evaluatePosition(game) {
  let empty = 0;
  let garbage = 0;
  let largest = 0;
  let corner = 0;
  let pairs = 0;
  let disorder = 0;
  let roughness = 0;
  const size = game.size;
  const ranks = game.grid.cells.map(column => column.map(tile => {
    if (!tile) {
      empty++;
      return 0;
    }
    if (tile.value === 0) garbage++;
    const rank = tile.value >= 2 ? Math.log2(tile.value) : -1;
    largest = Math.max(largest, rank);
    return rank;
  }));

  function measureLine(line) {
    let previous = 0;
    let increasing = 0;
    let decreasing = 0;
    for (const rank of line) {
      if (rank < 0) {
        previous = 0;
        continue;
      }
      if (!rank) continue;
      if (previous) {
        const difference = rank - previous;
        if (!difference) pairs++;
        if (difference > 0) increasing += difference;
        else decreasing -= difference;
        roughness += Math.abs(difference);
      }
      previous = rank;
    }
    disorder += Math.min(increasing, decreasing);
  }

  for (let index = 0; index < size; index++) {
    measureLine(ranks[index]);
    measureLine(ranks.map(column => column[index]));
    if (index === 0 || index === size - 1) {
      corner = Math.max(corner, ranks[index][0], ranks[index][size - 1]);
    }
  }

  const quality = 24 + 14 * empty + 5 * pairs - 12 * disorder
    - 0.8 * roughness - 12 * garbage - 28 * (largest - corner);
  return Math.max(0, quality) * Math.max(2, 2 ** largest / 16);
}

// Replay the real slide rule at each random branch, carrying its exact probability.
function slideOutcomes(state, direction, checkBudget) {
  const outcomes = [];
  const rolls = [];
  const branch = {};
  let cutoff;
  function visit(probability) {
    if (checkBudget) checkBudget();
    const game = GameManager.fromState(state);
    let index = 0;
    try {
      const moved = game.slide(direction, threshold => {
        if (index < rolls.length) return rolls[index++];
        cutoff = threshold;
        throw branch;
      });
      outcomes.push({ game, moved, probability });
    } catch (error) {
      if (error !== branch) throw error;
      const less = cutoff;
      rolls.push(0);
      visit(probability * less);
      rolls[rolls.length - 1] = 1;
      visit(probability * (1 - less));
      rolls.pop();
    }
  }
  visit(1);
  return outcomes;
}

function spawnExpectation(game, now, evaluate, sampleLimit = Infinity) {
  const cells = game.grid.availableCells();
  if (!cells.length) return evaluate(game);
  const originalRelationship = game.relTime;
  const p = game.relationshipChance(cells.length);
  const distribution = p ? [[2, 0.9 - 9 * p], [4, 0.1 - p], [1, 10 * p]]
    : [[2, 0.9], [4, 0.1]];
  let total = 0;
  // Group equally likely positions into strata when searching deeper in the tree.
  const groups = Math.min(cells.length, sampleLimit);
  for (let group = 0; group < groups; group++) {
    const first = Math.floor(group * cells.length / groups);
    const end = Math.floor((group + 1) * cells.length / groups);
    const cell = cells[Math.floor((first + end - 1) / 2)];
    for (const [value, probability] of distribution) {
      game.grid.insertTile(new Tile(cell, value));
      game.relTime = value === 1 ? now : originalRelationship;
      total += (end - first) * probability * evaluate(game);
    }
    game.grid.removeTile(cell);
  }
  game.relTime = originalRelationship;
  return total / cells.length;
}

function expireSimulatedRelationship(state, now) {
  if (!state.relTime || now - state.relTime < GameManager.relationshipDurationMs) return state;
  const game = GameManager.fromState(state);
  game.actuate = function () {};
  game.unsetTimer();
  return game.serialize();
}

function chooseLocalMove(state, strategy, directions, {
  now = Date.now(), stepMs = 800, searchCache, budgetMs = searchBudgetMs,
  clock = () => performance.now()
} = {}) {
  const iterative = strategy === "expectimax_10";
  const deep = strategy === "expectimax_deep";
  const fallbackDepth = strategy === "expectimax" || deep ? 2 : 1;
  const budgetExhausted = Symbol("search budget");
  let remainingSlides = Infinity;
  let cache;
  let deadline = Infinity;
  let visits = 0;
  let hits = 0;
  let lookups = 0;

  function checkBudget() {
    if ((++visits & 15) === 0 && clock() >= deadline) throw budgetExhausted;
  }

  function store(key, value) {
    if (iterative && cache.size >= maxSearchCacheEntries) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, value);
  }

  function bestContinuation(state, depth, time) {
    if (state.over || (state.won && !state.keepPlaying)) return 0;
    let key;
    let positionKey;
    if (cache) {
      const cells = state.grid.cells.map(column => column.map(tile => {
        if (!tile) return "";
        return tile.benefitedFrom === state.relTime && state.relTime ? tile.value + "b" : tile.value;
      }).join(",")).join("/");
      const relationship = iterative && state.relTime ? time - state.relTime : state.relTime;
      positionKey = [state.maxTile, state.garbCount % 2, state.karma, relationship, cells].join("|");
      if (iterative) {
        positionKey = stepMs + "|" + Number(state.keepPlaying) + "|" + positionKey;
        lookups++;
      }
      key = depth + "|" + positionKey;
      if (cache.has(key)) {
        const cached = cache.get(key);
        if (iterative) hits++;
        return cached;
      }
    }
    let best = 0;
    let actions = [0, 1, 2, 3];
    if (iterative && depth >= 2) {
      // The shallow ranking is reused while deepening this same position.
      const ranksKey = "order|" + positionKey;
      actions = cache.get(ranksKey);
      if (!actions) {
        const ranked = [0, 1, 2, 3].map(action => ({
          action, value: valueForDirection(state, action, 1, time)
        })).filter(entry => entry.value !== null);
        ranked.sort((a, b) => b.value - a.value || a.action - b.action);
        actions = ranked.slice(0, 2).map(entry => entry.action);
        store(ranksKey, actions);
      }
    }
    for (const action of actions) {
      best = Math.max(best, valueForDirection(state, action, depth, time) ?? 0);
    }
    if (cache) store(key, best);
    return best;
  }

  function valueForDirection(position, direction, remaining, time, root = false) {
    let weighted = 0;
    let possible = false;
    if (--remainingSlides < 0) throw budgetExhausted;
    for (const outcome of slideOutcomes(position, direction, iterative ? checkBudget : undefined)) {
      const { game, moved, probability } = outcome;
      possible ||= moved;
      const gain = game.score - position.score;
      if (strategy === "greedy") {
        weighted += probability * gain;
      } else if (remaining === 1) {
        weighted += probability * (gain + (game.movesAvailable() ? evaluatePosition(game) : 0));
      } else {
        const continuation = nextGame => {
          const nextTime = time + stepMs;
          const next = expireSimulatedRelationship(nextGame.serialize(), nextTime);
          return bestContinuation(next, remaining - 1, nextTime);
        };
        weighted += probability * (gain + (moved
          ? spawnExpectation(game, time, continuation,
            root ? Infinity : iterative ? 1 : deep ? 2 : Infinity)
          : continuation(game)));
      }
    }
    return possible ? weighted : null;
  }

  function search(depth) {
    const values = {};
    let best = -Infinity;
    let direction = null;
    for (const action of directions) {
      const value = valueForDirection(state, action, depth, now, true);
      if (value === null) continue;
      values[action] = value;
      if (value > best + 1e-8) {
        direction = action;
        best = value;
      }
    }
    return { direction, values, depth };
  }

  if (iterative) {
    const started = clock();
    cache = searchCache ?? new Map();
    let best = search(1);
    deadline = started + budgetMs;
    for (let depth = 2; depth <= maxSearchDepth && clock() < deadline; depth++) {
      try {
        best = search(depth);
      } catch (error) {
        if (error !== budgetExhausted) throw error;
        break;
      }
    }
    return {
      ...best,
      stats: {
        elapsedMs: clock() - started, hits, lookups, visits, cacheSize: cache.size,
        simulationStepMs: stepMs
      }
    };
  }

  const empty = state.grid.cells.flat().filter(tile => !tile).length;
  if (deep && empty <= 8) {
    remainingSlides = 3600;
    cache = new Map();
    try {
      return search(3);
    } catch (error) {
      if (error !== budgetExhausted) throw error;
      remainingSlides = Infinity;
      cache = undefined;
    }
  }
  return search(fallbackDepth);
}
