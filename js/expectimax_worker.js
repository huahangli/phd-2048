importScripts("grid.js", "tile.js", "game_manager.js", "local_strategies.js");

const searchCache = new Map();
let currentRunId;

self.onmessage = ({ data: { runId, state, directions, now, stepMs } }) => {
  if (currentRunId !== runId) {
    searchCache.clear();
    currentRunId = runId;
  }
  try {
    const choice = chooseLocalMove(state, "expectimax_10", directions, {
      now, stepMs: stepMs || searchBudgetMs, searchCache
    });
    self.postMessage({ choice });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
