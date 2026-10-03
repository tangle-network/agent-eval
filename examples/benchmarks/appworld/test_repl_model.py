import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

# Isolate only optional execution dependencies; exercise the actual worker functions.
with patch.dict(sys.modules, {
    "openai": SimpleNamespace(OpenAI=object, RateLimitError=type("RateLimitError", (Exception,), {})),
    "appworld": SimpleNamespace(AppWorld=object),
}):
    import repl_agent

class ModelContractTest(unittest.TestCase):
    def test_terra_direct_request_contract(self):
        create = MagicMock(return_value="response")
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        self.assertEqual(repl_agent.chat_with_backoff(client, rate_limit_budget=0,
            model="gpt-5.6-terra", messages=[], max_tokens=256, temperature=0.7, seed=3), "response")
        sent = create.call_args.kwargs
        self.assertEqual(sent["max_completion_tokens"], 256)
        self.assertEqual(sent["reasoning_effort"], "none")
        self.assertEqual(sent["seed"], 3)
        self.assertNotIn("temperature", sent)
        self.assertNotIn("max_tokens", sent)

    def test_unrelated_provider_request_is_unchanged(self):
        create = MagicMock()
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        repl_agent.chat_with_backoff(client, rate_limit_budget=0,
            model="gpt-4o-mini", max_tokens=256, temperature=0.7)
        self.assertEqual(create.call_args.kwargs["max_tokens"], 256)
        self.assertEqual(create.call_args.kwargs["temperature"], 0.7)

    def test_cost_estimate_context_boundary_and_unknown(self):
        self.assertAlmostEqual(repl_agent.price("gpt-5.6-terra", 272000, 100), 0.5452)
        self.assertAlmostEqual(repl_agent.price("gpt-5.6-terra", 272001, 100), 1.089804)
        self.assertIsNone(repl_agent.price("unknown", 100, 100))
        self.assertAlmostEqual(repl_agent.price("gpt-5.1", 100, 100), 0.001125)

if __name__ == "__main__":
    unittest.main()
