#!/usr/bin/env bash
# Run the REAL halo-engine over a chat-completions transport so it works against
# DeepSeek / any OpenAI-compatible chat backend (the Agents SDK otherwise
# defaults to the Responses API, which those backends don't serve). Transport
# only — halo's analysis is unchanged. See halo_chat.py.
# Requires HALO_VENV_PY = the halo-engine venv python.
exec "${HALO_VENV_PY:?set HALO_VENV_PY to the halo-engine venv python}" \
  "$(dirname "$0")/halo_chat.py" "$@"
