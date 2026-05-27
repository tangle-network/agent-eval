# Pilot Kit — customer handoff materials

What's here, in order of use:

| File | For | When |
|---|---|---|
| [one-pager.md](./one-pager.md) | Customer's first read | Send as initial pitch — what they get, why it's different, what it looks like, what it costs. Now includes intake-paths matrix for non-Tangle customers (LangChain / LlamaIndex / Anthropic SDK / OpenAI Assistants / OpenRouter / vLLM / Ollama / custom). |
| [integration-tangle-stack.md](./integration-tangle-stack.md) | Customer's engineer (Tangle-stack customers) | Send after one-pager when they want to see the code; full integration walkthrough for the canonical Tangle stack (sandbox + tcloud) |
| [integration-foreign-stack.md](./integration-foreign-stack.md) | Customer's engineer (non-Tangle customers) | Send after one-pager when they're on OTel, LangChain, LlamaIndex, Anthropic SDK, OpenAI Assistants, OpenRouter, vLLM, Ollama, or custom. Covers every path. |
| [sample-insight-report.json](./sample-insight-report.json) | Customer's team meeting | Concrete JSON they can show to demonstrate value pre-integration |
| [customer-checklist.md](./customer-checklist.md) | Pre-onboarding-call | Send 48h before the call; ensures the 90min slot is productive. Provider-agnostic — works for any stack. |

## How to use this kit

**For a Tangle customer asking for it RIGHT NOW:**

1. Reply with the one-pager (`one-pager.md`) inline + the sample InsightReport (`sample-insight-report.json`) attached. Their senior engineer reads this and decides if it's worth a call.
2. If they say yes, send the integration guide (`integration-tangle-stack.md`) + the checklist (`customer-checklist.md`). Schedule a 90-minute onboarding call.
3. On the call: walk through the integration, run a live `analyzeRuns()` against their existing sandbox sessions, render the deterministic packet, fire one small `selfImprove` cycle. By the end of the call they have a working pilot.

**For Drew handling the conversation himself:**

The whole kit is written in our voice (technical, direct, no marketing fluff). You can paste sections directly into Slack / email / a customer call. The one-pager is meant to read as YOUR pitch, not a generic SaaS handout.

## What this kit assumes

- Customer is on the Tangle stack (sandbox + tcloud) OR emits OTel traces
- Customer has an agent with a clear system-prompt addendum we can optimize
- Customer has at least 20 scenarios their agent handles
- Customer is willing to set a `maxUsd` budget for closed-loop campaigns

If any of those don't apply, the one-pager still works as a positioning piece. The integration doc gets adapted on the call.

## Where this maps in the substrate

- Substrate version: `@tangle-network/agent-eval@0.53.0` (npm), `agent-eval-rpc@0.53.0` (PyPI)
- agent-runtime version: `@tangle-network/agent-runtime@0.29.0`
- Key APIs: `fromTangleSandbox`, `fromOtelSpans`, `analyzeRuns`, `selfImprove`, `gepaDriver`, `defaultProductionGate`, `openAutoPr`
- All ship today; no version-blocking dependencies

## What this kit doesn't yet do

- No `npx @tangle-network/intelligence demo` command shipped yet (queued #115 — extend existing `tangle-intel` CLI in ADC with customer-zero-touch subcommands `init` / `demo` / `report` / `improve`)
- No `staging-intelligence.tangle.tools` live yet (queued #116 — matches existing `staging-{product}.tangle.tools` precedent like sandbox)
- No live demo video (queued #117 — recorded against legal-agent canonical real data)
- No screenshot dashboard (gated on Gate 2 task #109 — ADC intelligence frontend renders canonical InsightReport)
- No published case study with named numbers (Gate 3 task #112 — after first pilot completes 4+ cycles)

## Architectural decisions baked into this kit

- **Customer-facing CLI is `@tangle-network/intelligence`** (binary `tangle-intel`), NOT `agent-eval`. `agent-eval` is the substrate package; `intelligence` is the customer product that wraps it. The CLI already exists at `services/intelligence/src/cli/` in agent-dev-container — we extend it with `init` / `demo` / `report` / `improve` subcommands per task #115.
- **Hosted URL is `staging-intelligence.tangle.tools`** matching `staging-sandbox.tangle.tools` precedent. Production becomes `intelligence.tangle.tools` once Gate 2/3 close.
- **`agent-eval` mentioned only when customer wants direct programmatic access** (not the default path). 90%+ of customers stay at the CLI + hosted dashboard layer.

For the FIRST pilot conversation, the JSON sample is the dashboard substitute. After Gate 2 lands we replace it with live screenshots.

## Update cadence

This kit gets updated each time:
- A substrate version ships that customers should know about
- A real pilot completes and we have a case study to add
- A customer gives feedback that re-shapes how we pitch
