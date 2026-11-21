import json
import unittest

import llm_control


class LLMControlTests(unittest.TestCase):
    def test_request_constrains_the_model_to_the_available_directions(self):
        board = {"board": [[2, None, 4, None]] * 4}
        directions = ["down", "left"]
        request = llm_control.decision_request(board, directions)
        self.assertEqual(
            json.loads(request["messages"][1]["content"]),
            {"state": board, "candidates": directions},
        )
        schema = request["response_format"]["json_schema"]["schema"]
        self.assertEqual(schema["properties"]["direction"]["enum"], directions)
        self.assertFalse(schema["additionalProperties"])

    def test_only_a_finished_legal_choice_is_accepted(self):
        def response(content, reason="stop"):
            return {"model": "test", "choices": [{"finish_reason": reason, "message": {"content": content}}]}

        reply = llm_control.parse_answer(response('{"direction":"down"}'), ["down", "left"])
        self.assertEqual(reply["direction"], "down")
        self.assertEqual(reply["model"], "test")
        for bad_reply in (
            response('{"direction":"right"}'),
            response('{"direction":"down","extra":true}'),
            response('{"direction":"down"}', "length"),
            response("left"),
        ):
            with self.assertRaises(ValueError):
                llm_control.parse_answer(bad_reply, ["down", "left"])
