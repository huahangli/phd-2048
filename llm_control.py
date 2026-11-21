"""Choose a PhD 2048 move using an OpenAI-compatible model."""

import json
import os
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def decision_request(state, candidates):
    return {
        "model": os.environ.get("LLM_MODEL"),
        "messages": [
            {
                "role": "system",
                "content": (
                    "Choose one legal move for this PhD 2048 board. Aim to reach 2048 "
                    "and maximize the long-term score. Prefer open cells, useful merges, "
                    "and keeping the largest tiles together. The board is row-major, "
                    "null is empty, 0 is sticky garbage, and 1 is a relationship tile. "
                    "Two garbage tiles cancel. An active relationship can double a tile "
                    "once. An expired relationship can halve a tile. Benefited entries "
                    "are zero-based [column, row]. Return only a JSON object with direction."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"state": state, "candidates": candidates}, separators=(",", ":")),
            },
        ],
        "max_completion_tokens": 512,
        "reasoning_effort": "low",
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "phd_2048_move",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {"direction": {"type": "string", "enum": candidates}},
                    "required": ["direction"],
                    "additionalProperties": False,
                },
            },
        },
    }


def parse_answer(response, candidates):
    choice = response["choices"][0]
    if not isinstance(choice, dict) or choice.get("finish_reason") != "stop":
        raise ValueError("The model did not finish its decision")
    answer = json.loads(choice["message"]["content"])
    if not isinstance(answer, dict) or set(answer) != {"direction"} or answer["direction"] not in candidates:
        raise ValueError("The model selected a direction outside the candidate list")
    return {
        "direction": answer["direction"],
        "model": response.get("model"),
        "usage": response.get("usage"),
    }


def decide(payload, candidates):
    base_url = os.environ.get("LLM_BASE_URL").rstrip("/")
    endpoint = urlsplit(base_url)
    if (endpoint.scheme not in ("http", "https") or not endpoint.hostname
            or endpoint.username is not None or endpoint.query or endpoint.fragment):
        raise ValueError("LLM_BASE_URL must be an HTTP(S) API base URL")
    request = Request(base_url + "/chat/completions", data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"})
    api_key = os.environ.get("LLM_API_KEY", "").strip()
    if api_key:
        request.add_unredirected_header("Authorization", f"Bearer {api_key}")
    with urlopen(request, timeout=45) as response:
        return parse_answer(json.load(response), candidates)
