"""Serve the game and proxy model decisions on localhost."""

import argparse
import json
import math
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from time import monotonic, time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import llm_control
from jev_runs import Runs, valid_state

ROOT = Path(__file__).resolve().parent
JEV_URL = "https://api.typesafe.ai/v1/systemone"
DIRECTIONS = {
    "up": "Slide and merge tiles towards the top edge.",
    "right": "Slide and merge tiles towards the right edge.",
    "down": "Slide and merge tiles towards the bottom edge.",
    "left": "Slide and merge tiles towards the left edge.",
}
LOCAL_STRATEGIES = {
    "greedy": (1,),
    "heuristic": (1,),
    "expectimax": (2,),
    "expectimax_deep": (2, 3),
    "expectimax_10": range(1, 11),
}
MODEL_STRATEGIES = {"jev": "TypeSafe API", "llm": "LLM API"}
STATIC_FILES = {"/", "/index.html", "/manifest.json", "/favicon.ico"}
STATIC_DIRS = {"js", "style", "meta"}
RUNS = Runs(ROOT / "jev-runs")
RUN_LOCK = Lock()
MODEL_LOCK = Lock()
RUN_ROUTE = re.compile(r"/api/(?:jev/)?runs(?:/([0-9a-f]{32})(?:/(decision|result|resume))?)?")


def get_api_key():
    api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if api_key:
        return api_key

    try:
        api_key = (ROOT / "API_KEYS").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return ""
    return api_key if re.fullmatch(r"[A-Za-z0-9_.-]+", api_key) else ""


def decision_request(state, candidates):
    return {
        "model": os.environ.get("JEV_MODEL", "jev-latest"),
        "state": state,
        "questions": {
            "move": {
                "type": "choice",
                "instructions": (
                    "Choose the move most likely to help reach 2048 and avoid a full board. "
                    "The board lists rows top to bottom, each row left to right. "
                    "Null is empty, 0 is sticky garbage, and 1 is a relationship tile. "
                    "Two garbage tiles can cancel. A relationship tile can double a tile "
                    "it has not helped yet. An expired relationship tile can halve tiles. "
                    "Benefited coordinates are zero-based [column, row]."
                ),
                "criteria": {direction: DIRECTIONS[direction] for direction in candidates},
            }
        },
    }

def decide(api_key, payload, candidates):
    request = Request(
        JEV_URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urlopen(request, timeout=20) as response:
        result = json.load(response)
    direction = result["answers"]["move"]["choice"]
    if direction not in candidates:
        raise ValueError("Jev selected a direction outside the candidate list")
    answer = result["answers"]["move"]
    return {
        "direction": direction,
        "model": result.get("model"),
        "confidence": answer.get("confidence"),
        "probabilities": answer.get("probabilities"),
        "usage": result.get("usage"),
    }


def local_decision(result, strategy, candidates):
    if not isinstance(result, dict):
        raise ValueError
    direction = result.get("direction")
    values = result.get("values")
    depth = result.get("depth")
    delay = result.get("stepMs")
    if (
        direction not in candidates or not isinstance(values, dict)
        or set(values) != set(candidates)
        or any(type(value) not in (int, float) or not math.isfinite(value) for value in values.values())
        or values[direction] + 1e-8 < max(values.values())
        or type(delay) is not int or not 0 <= delay <= 60000
        or type(depth) is not int or depth not in LOCAL_STRATEGIES[strategy]
    ):
        raise ValueError
    answer = {"direction": direction, "values": values, "depth": depth, "stepMs": delay}
    if strategy == "expectimax_10":
        stats = result.get("stats")
        if not isinstance(stats, dict):
            raise ValueError
        elapsed = stats.get("elapsedMs")
        fields = ("hits", "lookups", "visits", "cacheSize", "simulationStepMs")
        if (
            type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0
            or any(type(stats.get(field)) is not int or stats[field] < 0 for field in fields)
            or stats["hits"] > stats["lookups"]
            or stats["cacheSize"] > 50000
            or stats["simulationStepMs"] > 60000
        ):
            raise ValueError
        answer["stats"] = {"elapsedMs": elapsed, **{field: stats[field] for field in fields}}
    return answer


def model_state(state):
    cells = state["grid"]["cells"]
    relationship = state["relTime"]
    return {
        "board": [[None if cells[x][y] is None else cells[x][y]["value"]
                   for x in range(4)] for y in range(4)],
        "score": state["score"],
        "maxTile": state["maxTile"],
        "garbageCount": state["garbCount"],
        "karma": state["karma"],
        "relationshipSeconds": max(0, (relationship + 10000) / 1000 - time()) if relationship else None,
        "benefited": [[x, y] for x, column in enumerate(cells) for y, tile in enumerate(column)
                      if relationship and tile and tile.get("benefitedFrom") == relationship],
    }


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        path = urlsplit(self.path).path
        file_path = Path(self.translate_path(path)).resolve()
        relative = file_path.relative_to(ROOT) if ROOT in file_path.parents else None
        if path not in STATIC_FILES and (
            not relative or relative.parts[0] not in STATIC_DIRS or not file_path.is_file()
        ):
            self.send_error(404)
            return None
        return super().send_head()

    def send_json(self, status, **body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def require_local(self):
        host = self.headers.get("Host")
        allowed = {f"{name}:{self.server.server_port}" for name in ("localhost", "127.0.0.1")}
        if host not in allowed or self.headers.get("Origin", f"http://{host}") != f"http://{host}":
            raise ApiError(403, "请从本地游戏页面发起请求")

    def read_body(self):
        size = int(self.headers.get("Content-Length", 0))
        if self.headers.get_content_type() != "application/json" or not 0 < size <= 8192:
            raise ValueError
        body = json.loads(self.rfile.read(size))
        if not isinstance(body, dict):
            raise ValueError
        return body

    def do_GET(self):
        path = urlsplit(self.path).path
        match = RUN_ROUTE.fullmatch(path)
        if not match:
            super().do_GET()
            return

        try:
            self.require_local()
            with RUN_LOCK:
                if match[1]:
                    if match[2]:
                        raise FileNotFoundError
                    self.send_json(200, events=RUNS.read(match[1]))
                else:
                    self.send_json(200, runs=RUNS.list())
        except ApiError as error:
            self.send_json(error.status, error=str(error))
        except FileNotFoundError:
            self.send_json(404, error="轨迹不存在")
        except (OSError, ValueError):
            self.send_json(500, error="无法读取轨迹文件")

    def do_POST(self):
        try:
            self.require_local()
            match = RUN_ROUTE.fullmatch(self.path)
            if match and not match[1]:
                body = self.read_body()
                state = body.get("state")
                strategy = body.get("strategy", "jev")
                if not valid_state(state) or strategy not in (*LOCAL_STRATEGIES, *MODEL_STRATEGIES):
                    raise ValueError
                with RUN_LOCK:
                    run_id = RUNS.start(state, strategy)
                self.send_json(201, id=run_id, revision=0)
            elif match and match[2]:
                data = self.read_body()
                if match[2] == "decision":
                    self.run_decision(match[1], data)
                else:
                    self.finish_or_resume(match[1], match[2], data)
            else:
                raise FileNotFoundError
        except ApiError as error:
            self.send_json(error.status, error=str(error))
        except FileNotFoundError:
            self.send_json(404, error="轨迹或接口不存在")
        except (ValueError, KeyError, TypeError):
            self.send_json(400, error="棋盘状态或轨迹请求无效")
        except OSError:
            self.send_json(500, error="无法写入轨迹文件")

    def check_revision(self, events, data):
        if type(data.get("revision")) is not int or data["revision"] != events[-1]["revision"]:
            raise ApiError(409, "轨迹已更新，请重新打开后再续跑")

    def run_decision(self, run_id, data):
        state, candidates = data["state"], data["candidates"]
        if (
            not valid_state(state)
            or not isinstance(candidates, list)
            or not 1 <= len(candidates) <= len(DIRECTIONS)
            or any(not isinstance(option, str) or option not in DIRECTIONS for option in candidates)
            or len(set(candidates)) != len(candidates)
        ):
            raise ValueError

        # One upstream request at a time, even when the game is open in multiple tabs.
        with MODEL_LOCK:
            with RUN_LOCK:
                events = RUNS.read(run_id)
                self.check_revision(events, data)
                if events[-1]["type"] == "decision" or (
                    events[-1]["type"] == "answer" and not events[-1]["error"]
                ):
                    raise ApiError(409, "上一条决策尚未保存执行结果")
                strategy = events[0].get("strategy", "jev")
                source = "forced" if len(candidates) == 1 else strategy
                result = (local_decision(data.get("local"), source, candidates)
                          if source in LOCAL_STRATEGIES else None)
                request = None
                if source == "jev":
                    request = decision_request(model_state(state), candidates)
                elif source == "llm":
                    request = llm_control.decision_request(model_state(state), candidates)
                decision = RUNS.append(run_id, events, "decision", state=state,
                                       candidates=candidates, source=source, request=request)
            started = monotonic()
            error = None
            if source == "forced":
                result = {"direction": candidates[0]}
            elif source in MODEL_STRATEGIES:
                service = MODEL_STRATEGIES[source]
                try:
                    if source == "llm":
                        result = llm_control.decide(request, candidates)
                    elif api_key := get_api_key():
                        result = decide(api_key, request, candidates)
                    else:
                        error = "请在 API_KEYS 文件中放入 TypeSafe 密钥，或设置 TYPESAFE_API_KEY"
                except HTTPError as exc:
                    error = f"{service} 返回 HTTP {exc.code}"
                    if source == "llm" and exc.code in (401, 403):
                        error += "，请检查服务端 LLM_API_KEY"
                except (URLError, TimeoutError, OSError):
                    error = f"连接 {service} 失败或超时"
                except (ValueError, KeyError, IndexError, TypeError):
                    error = f"{service} 返回了无效的决策或配置"
            with RUN_LOCK:
                event = RUNS.append(run_id, events, "answer", decision=decision["revision"],
                                    result=result, error=error,
                                    latencyMs=round((monotonic() - started) * 1000))
            if error:
                self.send_json(502, error=error, revision=event["revision"])
            else:
                self.send_json(200, direction=result["direction"], revision=event["revision"])

    def finish_or_resume(self, run_id, action, data):
        # A resume can reconcile an unfinished decision only after its upstream call has completed.
        with MODEL_LOCK, RUN_LOCK:
            events = RUNS.read(run_id)
            last = events[-1]
            answer_arrived_while_waiting = (
                action == "resume" and last["type"] == "answer"
                and data.get("revision") == last["decision"]
            )
            if not answer_arrived_while_waiting:
                self.check_revision(events, data)
            if action == "resume":
                if last["type"] == "decision" or (last["type"] == "answer" and not last["error"]):
                    decision = last.get("decision", last["revision"])
                    RUNS.append(run_id, events, "outcome", decision=decision, status="interrupted")
                frame = next(event for event in reversed(events) if "step" in event)
                last = RUNS.append(run_id, events, "resume", fromStep=frame["step"],
                                   fromRevision=frame["revision"])
                self.send_json(200, revision=last["revision"], frame=frame,
                               strategy=events[0].get("strategy", "jev"))
                return

            state, status = data["state"], data["status"]
            if not valid_state(state) or status not in ("applied", "no-op", "stale", "paused"):
                raise ValueError
            if last["type"] != "answer" or last["error"]:
                raise ApiError(409, "没有等待执行的决策")
            fields = {"decision": last["decision"], "status": status, "state": state}
            if status == "applied":
                frame = next(event for event in reversed(events) if "step" in event)
                fields["step"] = frame["step"] + 1
            event = RUNS.append(run_id, events, "outcome", **fields)
            self.send_json(200, revision=event["revision"], step=event.get("step"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=2048)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"PhD 2048 is running at http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
