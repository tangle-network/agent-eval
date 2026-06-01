#!/usr/bin/env python
"""Launch the REAL halo-engine over a chat-completions transport.

halo runs on the OpenAI Agents SDK, which defaults to the Responses API
(`/v1/responses`). DeepSeek — and most OpenAI-compatible backends — serve only
chat-completions, so the default transport 404s. This launcher flips the SDK to
its first-class `chat_completions` mode and disables the Agents tracing client
(which otherwise tries to ship telemetry to platform.openai.com and 401s on a
non-OpenAI key). NOTHING about halo's analysis — its prompts, hierarchy, tools,
or model — is changed; only the HTTP transport and telemetry sink.

Invoke with halo's own venv python (it carries halo's native deps):
  HALO_VENV_PY=/path/to/halo-engine/bin/python
  $HALO_VENV_PY halo_chat.py <TRACE_PATH> -p "<prompt>" -m <model> ...
Reads OPENAI_BASE_URL / OPENAI_API_KEY from the env like the halo CLI does.
"""

import sys

from agents import set_default_openai_api, set_tracing_disabled

set_default_openai_api("chat_completions")
set_tracing_disabled(True)

from halo_cli.main import app  # noqa: E402  (must follow the SDK config above)

if __name__ == "__main__":
    sys.exit(app())
