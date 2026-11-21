"""Append-only JSONL storage for Jev runs."""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def valid_state(state):
    if not isinstance(state, dict) or not isinstance(state.get("grid"), dict):
        return False
    grid = state["grid"]
    columns = grid.get("cells")
    if grid.get("size") != 4 or not isinstance(columns, list) or len(columns) != 4:
        return False
    for x, column in enumerate(columns):
        if not isinstance(column, list) or len(column) != 4:
            return False
        for y, tile in enumerate(column):
            if tile is not None and (
                not isinstance(tile, dict) or tile.get("position") != {"x": x, "y": y}
                or type(tile.get("value")) is not int or not 0 <= tile["value"] <= 2**30
                or (tile.get("benefitedFrom") is not None and type(tile["benefitedFrom"]) is not int)
            ):
                return False
    return (
        all(type(state.get(key)) is int for key in ("score", "maxTile", "garbCount", "karma"))
        and all(type(state.get(key)) is bool for key in ("over", "won", "keepPlaying"))
        and "relTime" in state and (state["relTime"] is None or type(state["relTime"]) is int)
    )


class Runs:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.records = {}

    def path(self, run_id):
        if not re.fullmatch(r"[0-9a-f]{32}", run_id):
            raise FileNotFoundError
        return self.directory / f"{run_id}.jsonl"

    def read(self, run_id):
        if run_id not in self.records:
            with self.path(run_id).open("rb+") as file:
                events = []
                while line := file.readline():
                    if not line.endswith(b"\n"):
                        file.truncate(file.tell() - len(line))
                        break
                    events.append(json.loads(line))
            if not events:
                raise FileNotFoundError
            self.records[run_id] = events
        return self.records[run_id]

    def append(self, run_id, events, kind, **fields):
        event = {"revision": len(events), "type": kind, "at": timestamp(), **fields}
        data = (json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n").encode()
        with self.path(run_id).open("ab+") as file:
            start = file.tell()
            try:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            except OSError:
                file.seek(start)
                file.truncate()
                raise
        events.append(event)
        return event

    def start(self, state, strategy="jev"):
        self.directory.mkdir(exist_ok=True)
        run_id = uuid4().hex
        events = []
        self.append(run_id, events, "start", schema=1, runId=run_id, step=0,
                    state=state, strategy=strategy)
        self.records[run_id] = events
        return run_id

    def list(self):
        runs = []
        for path in self.directory.glob("*.jsonl"):
            try:
                events = self.read(path.stem)
            except FileNotFoundError:
                continue
            last = next(event for event in reversed(events) if "step" in event)
            runs.append({
                "id": path.stem,
                "strategy": events[0].get("strategy", "jev"),
                "createdAt": events[0]["at"],
                "updatedAt": events[-1]["at"],
                "step": last["step"],
                "score": last["state"]["score"],
            })
        return sorted(runs, key=lambda run: run["updatedAt"], reverse=True)
