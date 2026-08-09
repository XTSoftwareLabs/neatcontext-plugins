---
description: Disconnect the NeatContext context from this session
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs":*)
---

Disconnect the context currently connected to this session.

!`node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" disconnect`

Relay the result verbatim. Do not run a status command afterward. This affects
only the current session. On hosts without a session identity, the selection is
shared by sessions opened in the same workspace.
