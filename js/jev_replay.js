function setupJevReplay({ beforeOpen, delay, resume }) {
  const get = id => document.getElementById(id);
  const dialog = get("jev-replay");
  const list = get("jev-run-list");
  const feedback = get("jev-replay-status");
  const content = get("jev-replay-content");
  const board = get("jev-replay-board");
  const slider = get("jev-replay-slider");
  const number = get("jev-replay-step");
  const previous = get("jev-replay-prev");
  const next = get("jev-replay-next");
  const play = get("jev-replay-play");
  const resumeButton = get("jev-resume");
  let frames = [];
  let events = [];
  let position = 0;
  let playback;
  let load = 0;

  function stop() {
    clearTimeout(playback);
    playback = undefined;
    play.textContent = "播放";
  }

  function show(index) {
    position = Math.max(0, Math.min(index, frames.length - 1));
    const frame = frames[position];
    const state = frame.state;
    const cells = state.grid.cells;
    const tiles = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const tile = cells[x][y];
        const cell = document.createElement("div");
        cell.className = "jev-replay-cell";
        if (tile) {
          cell.classList.add("tile", "tile-" + tile.value);
          if (tile.value > 2048) cell.classList.add("tile-super");
          const inner = document.createElement("div");
          inner.className = "tile-inner";
          inner.innerHTML = val2caption(tile.value, state);
          cell.appendChild(inner);
        }
        tiles.push(cell);
      }
    }
    board.replaceChildren(...tiles);
    slider.value = number.value = frame.step;
    previous.disabled = position === 0;
    next.disabled = position === frames.length - 1;
    play.disabled = frames.length < 2;
    const decision = events[frame.decision];
    const answer = decision && events[frame.decision + 1];
    const direction = answer?.result?.direction;
    const search = answer?.result?.stats;
    get("jev-replay-meta").textContent = "分数 " + state.score
      + (direction ? " · " + jevArrows[direction] + " · " +
        (answer.result.model || (decision.source === "forced" ? "唯一可行方向"
          : strategyLabels[decision.source] || "Jev")) : "")
      + (search ? " · " + answer.result.depth + "/10 步 · " + search.elapsedMs.toFixed(1) + " ms" : "");
    const from = position === 0 ? 0 : frames[position - 1].revision + 1;
    const end = position === frames.length - 1 ? events.length : frame.revision + 1;
    get("jev-replay-json").textContent = events.slice(from, end)
      .map(event => JSON.stringify(event, null, 2)).join("\n\n");
  }

  async function selectRun() {
    const request = ++load;
    const id = list.value;
    stop();
    content.hidden = true;
    feedback.textContent = "正在读取轨迹…";
    try {
      const result = await jevRequest("/" + id);
      if (request !== load || !dialog.open) return;
      events = result.events;
      frames = events.filter(event => Number.isInteger(event.step));
      slider.max = number.max = frames.length - 1;
      get("jev-replay-total").textContent = "/ " + (frames.length - 1);
      get("jev-replay-file").textContent = id + ".jsonl";
      const last = frames[frames.length - 1].state;
      resumeButton.disabled = last.over || (last.won && !last.keepPlaying);
      resumeButton.title = resumeButton.disabled ? "这条轨迹已结束" : "";
      show(0);
      feedback.textContent = "";
      content.hidden = false;
    } catch (error) {
      if (request === load) feedback.textContent = error.message;
    }
  }

  get("jev-history").addEventListener("click", async () => {
    const unfinished = beforeOpen();
    const request = ++load;
    const selected = list.value;
    list.disabled = true;
    content.hidden = true;
    feedback.textContent = unfinished ? "正在等待当前请求收尾…" : "正在读取轨迹…";
    dialog.showModal();
    try {
      await unfinished;
      if (request !== load) return;
      const { runs } = await jevRequest("");
      if (request !== load || !dialog.open) return;
      list.replaceChildren(...runs.map(run => {
        const date = new Date(run.createdAt).toLocaleString();
        return new Option((strategyLabels[run.strategy] || "Jev") + " · " + date
          + " · " + run.step + " 步 · 分数 " + run.score
          + " · " + run.id.slice(0, 6), run.id);
      }));
      if (!runs.length) {
        feedback.textContent = "还没有运行轨迹。开始一次 Jev 运行后就会出现在这里。";
        return;
      }
      if (runs.some(run => run.id === selected)) list.value = selected;
      list.disabled = false;
      await selectRun();
    } catch (error) {
      if (request === load) feedback.textContent = error.message;
    }
  });

  function jump(value) {
    stop();
    show(value);
  }

  function advance() {
    show(position + 1);
    if (position < frames.length - 1) playback = setTimeout(advance, delay());
    else stop();
  }

  dialog.addEventListener("close", () => { load++; stop(); });
  list.addEventListener("change", selectRun);
  previous.addEventListener("click", () => jump(position - 1));
  next.addEventListener("click", () => jump(position + 1));
  slider.addEventListener("input", () => jump(slider.valueAsNumber));
  number.addEventListener("change", () => jump(Number.isInteger(number.valueAsNumber)
    ? number.valueAsNumber : position));
  play.addEventListener("click", () => {
    if (playback !== undefined) {
      stop();
    } else {
      if (position === frames.length - 1) show(0);
      play.textContent = "暂停播放";
      playback = setTimeout(advance, delay());
    }
  });
  resumeButton.addEventListener("click", () => {
    dialog.close();
    resume(list.value, events[events.length - 1].revision);
  });
}
