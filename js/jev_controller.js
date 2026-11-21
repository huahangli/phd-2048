async function jevRequest(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
  const response = await fetch("/api/runs" + path, options);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("请使用 python3 serve.py 启动游戏");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

const jevDirections = ["up", "right", "down", "left"];
const jevArrows = { up: "↑", right: "→", down: "↓", left: "←" };
const modelStrategies = new Set(["jev", "llm"]);

function setupJevController(game) {
  // The trajectory server listens only on loopback. Hosted pages run in the browser.
  const hasTrajectoryServer = ["127.0.0.1", "localhost"].includes(location.hostname);
  const toggle = document.querySelector("#jev-toggle");
  const strategyInput = document.querySelector("#auto-strategy");
  const interval = document.querySelector("#jev-interval");
  const status = document.querySelector("#jev-status");
  const metrics = document.querySelector("#search-metrics");
  const comparison = document.querySelector("#search-comparison");
  const history = document.querySelector("#jev-history");
  const startLabel = hasTrajectoryServer ? "新开轨迹" : "开始自动走棋";
  let delay = Math.round(Number(interval.value) * 1000);
  let run = null;
  let pending = null;
  let timer;
  let nextTurnFrom;
  let inputVersion = 0;
  let worker;
  let retryNotBefore = 0;
  const recentTimings = [];
  let totalHits = 0;
  let totalLookups = 0;

  if (!hasTrajectoryServer) {
    document.querySelector("#model-strategies").remove();
    history.hidden = true;
  } else {
    const requested = new URLSearchParams(location.search).get("strategy");
    if (modelStrategies.has(requested)) strategyInput.value = requested;
  }

  function resetMetrics() {
    recentTimings.length = 0;
    totalHits = totalLookups = 0;
    metrics.hidden = comparison.hidden = strategyInput.value !== "expectimax_10";
    metrics.textContent = "每步搜索预算 50 ms · 最多向前 10 步";
  }

  function showMetrics(choice) {
    const { elapsedMs, hits, lookups, cacheSize } = choice.stats;
    totalHits += hits;
    totalLookups += lookups;
    recentTimings.push(elapsedMs);
    if (recentTimings.length > 256) recentTimings.shift();
    const ordered = recentTimings.slice().sort((a, b) => a - b);
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];
    const hitRate = totalLookups ? (100 * totalHits / totalLookups).toFixed(1) + "%" : "—";
    metrics.textContent = "完成 " + choice.depth + "/10 步 · 本步 " + elapsedMs.toFixed(1)
      + " ms · P95 " + p95.toFixed(1) + " ms · 缓存 " + hitRate
      + " 命中（" + cacheSize.toLocaleString() + " 条）";
  }

  function chooseInWorker(runId, state, directions) {
    if (!worker) worker = new Worker("js/expectimax_worker.js");
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.error) reject(new Error(data.error));
        else resolve(data.choice);
      };
      worker.onerror = () => {
        worker.terminate();
        worker = undefined;
        reject(new Error("无法启动本地搜索"));
      };
      worker.postMessage({ runId, state, directions, now: Date.now(), stepMs: delay });
    });
  }

  function updateToggle() {
    const strategy = strategyInput.value;
    toggle.textContent = run ? "暂停" :
      modelStrategies.has(strategy) ? "启动 " + strategyLabels[strategy] : startLabel;
    toggle.disabled = !run && Boolean(pending);
    strategyInput.disabled = Boolean(run || pending);
  }

  function pause(message) {
    inputVersion++;
    run = null;
    clearTimeout(timer);
    timer = undefined;
    retryNotBefore = 0;
    updateToggle();
    if (message) status.textContent = message;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(step, Math.max(0, Math.max(nextTurnFrom + delay, retryNotBefore) - performance.now()));
  }

  function operate(task) {
    if (pending) return pending;
    // Keep the decision, move, and durable outcome together across tabs.
    const perform = () => hasTrajectoryServer && navigator.locks
      ? navigator.locks.request("phd-2048-jev-turn", task)
      : task();
    pending = Promise.resolve().then(perform).catch(error => {
      pause("已暂停 · " + error.message);
    }).finally(() => {
      pending = null;
      updateToggle();
      if (run) {
        nextTurnFrom = performance.now();
        schedule();
      }
    });
    updateToggle();
    return pending;
  }

  function step() {
    timer = undefined;
    retryNotBefore = 0;
    if (!run || pending) return;
    const currentRun = run;
    operate(async () => {
      if (run !== currentRun) return;
      if (game.isGameTerminated()) {
        pause(game.over ? "游戏结束" : "已达到 2048");
        return;
      }

      const directions = game.availableDirections();
      if (!directions.length) {
        if (game.relTime) {
          status.textContent = "等待恋爱倒计时结束…";
          retryNotBefore = performance.now()
            + Math.max(20, game.relTime + GameManager.relationshipDurationMs - Date.now());
        } else pause("没有可行方向");
        return;
      }

      const path = "/" + run.id;
      const grid = game.grid;
      const before = game.serialize();
      const candidates = directions.map(direction => jevDirections[direction]);
      const label = strategyLabels[currentRun.strategy];
      const unchanged = () => grid === game.grid
        && JSON.stringify(before) === JSON.stringify(game.serialize());
      const selecting = candidates.length === 1 ? "唯一可行方向 " + jevArrows[candidates[0]]
        : label + " 正在选择 " + candidates.map(candidate => jevArrows[candidate]).join(" ");
      status.textContent = currentRun.lastMove ? currentRun.lastMove + " · " + selecting : selecting;
      let local;
      if (!modelStrategies.has(currentRun.strategy) && directions.length > 1) {
        const stepMs = delay;
        const choice = currentRun.strategy === "expectimax_10"
          ? await chooseInWorker(currentRun.id, before, directions)
          : chooseLocalMove(before, currentRun.strategy, directions, { stepMs });
        if (currentRun !== run) return;
        if (!unchanged()) {
          status.textContent = "棋盘已更新，等待重新选择…";
          return;
        }
        local = {
          direction: jevDirections[choice.direction],
          values: Object.fromEntries(directions.map(index => [jevDirections[index], choice.values[index]])),
          depth: choice.depth,
          stepMs,
          stats: choice.stats
        };
        if (choice.stats) showMetrics(choice);
      }
      const decision = hasTrajectoryServer ? await jevRequest(path + "/decision", {
        revision: currentRun.revision, state: before, candidates, local
      }) : { direction: local?.direction ?? candidates[0] };

      let outcome = "paused";
      let after = before;
      if (currentRun === run) {
        if (!unchanged()) {
          outcome = "stale";
          after = game.serialize();
        } else {
          outcome = game.move(jevDirections.indexOf(decision.direction)) ? "applied" : "no-op";
          after = game.serialize();
        }
      }

      let saved;
      try {
        saved = hasTrajectoryServer ? await jevRequest(path + "/result", {
          revision: decision.revision, state: after, status: outcome
        }) : { step: currentRun.step + (outcome === "applied" ? 1 : 0) };
      } catch (error) {
        if (outcome === "applied" && currentRun === run && grid === game.grid
            && JSON.stringify(after) === JSON.stringify(game.serialize())) {
          game.restoreRunState(before);
        }
        throw error;
      }
      currentRun.revision = saved.revision;
      currentRun.step = saved.step ?? currentRun.step;
      if (currentRun !== run) return;
      if (outcome === "stale") {
        status.textContent = "棋盘已更新，等待重新选择…";
      } else if (outcome === "no-op") {
        status.textContent = jevArrows[decision.direction] + " 未改变棋盘，等待重试…";
      } else {
        const source = candidates.length === 1 ? "唯一可行方向 " : label + " 选择 ";
        status.textContent = source + jevArrows[decision.direction] + " · 第 " + saved.step + " 步";
        currentRun.lastMove = "第 " + saved.step + " 步 " + jevArrows[decision.direction];
        if (game.isGameTerminated()) {
          pause(status.textContent + (game.over ? " · 游戏结束" : " · 已达到 2048"));
        }
      }
    });
  }

  function begin(id, revision) {
    if (!interval.reportValidity() || pending) return;
    const strategy = strategyInput.value;
    if (!id && (game.over || (modelStrategies.has(strategy) && game.isGameTerminated()))) {
      status.textContent = hasTrajectoryServer ? "请先重开游戏，或选择可续跑的轨迹" : "请先重开游戏";
      return;
    }
    const version = inputVersion;
    operate(async () => {
      if (version !== inputVersion) return;
      if (id) {
        const resumed = await jevRequest("/" + id + "/resume", { revision });
        if (version !== inputVersion) return;
        game.restoreRunState(resumed.frame.state, resumed.frame.at);
        strategyInput.value = resumed.strategy;
        resetMetrics();
        run = { id, revision: resumed.revision, strategy: resumed.strategy, step: resumed.frame.step };
        status.textContent = "已恢复至第 " + resumed.frame.step + " 步";
      } else {
        const grid = game.grid;
        const state = game.serialize();
        if (!modelStrategies.has(strategy)) state.keepPlaying = true;
        const created = hasTrajectoryServer ? await jevRequest("", { state, strategy })
          : { id: version };
        if (version !== inputVersion || grid !== game.grid) return;
        if (!modelStrategies.has(strategy)) {
          game.keepPlaying = true;
          if (game.won) game.actuator.continueGame();
          game.actuate();
        }
        run = { id: created.id, revision: created.revision, strategy, step: 0 };
        resetMetrics();
        status.textContent = hasTrajectoryServer ? "新轨迹已创建 · 第 0 步" : "自动走棋 · 第 0 步";
      }
    });
  }

  toggle.addEventListener("click", () => {
    if (run) pause("已暂停，可手动操作");
    else begin();
  });

  interval.addEventListener("input", () => {
    if (!interval.validity.valid || !Number.isFinite(interval.valueAsNumber)) return;
    delay = Math.round(interval.valueAsNumber * 1000);
    if (timer !== undefined) schedule();
  });
  strategyInput.addEventListener("change", () => {
    resetMetrics();
    updateToggle();
  });
  resetMetrics();
  updateToggle();

  ["move", "restart", "keepPlaying"].forEach(event => game.inputManager.on(event, () => {
    if (run || pending) pause("已切换为手动模式");
  }));

  if (hasTrajectoryServer) setupJevReplay({
    beforeOpen() {
      if (run || pending) pause("已暂停，可手动操作");
      return pending;
    },
    delay: () => delay || 250,
    resume: begin
  });
}
