# Health OS

**A local, CLI-first foundation for a personal health operating system.**

Health OS gives people and AI agents a durable workspace for health context: goals, daily observations, wearable data, documents, and history. It connects what you report, what your devices measure, and what happened over time so that each next action can build on that context.

Any agent that can run a command can use Health OS through its versioned JSON interface. The agent handles conversation and interpretation; Health OS provides structured records, source provenance, explainable calculations, and retrievable memory. Your data lives in a separate private workspace under your control.

## A complete health workflow

Consider a day when you report low energy before a planned workout:

1. **Capture the observation.** An agent records how you feel as a dated event, preserving its source and uncertainty.
2. **Bring the context together.** Health OS combines your profile, sleep and recovery data, recent training, subjective events, and reviewed memory.
3. **Prepare the next action.** The CLI returns a training card with reasons, sources, and explicit data gaps. The agent uses that context to explain the options.
4. **Close the loop.** Record the completed session and how it felt, then review the week's evidence. An agent can maintain sourced health notes for future decisions.

Training and recovery are the first implemented decision workflow. The broader foundation—profile, events, observations, documents, timeline, and memory—can support additional health workflows as they are developed. Oura is the built-in wearable connector; other providers can be added through explicit connector implementations.

## Quick start

Requires **Node.js 22.13.0 or newer** and Git. The CLI uses Node built-ins and runs without a model API key or wearable account.

```bash
git clone https://github.com/bknstn/health-os.git
cd health-os

export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
node src/cli.js init-workspace --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js profile-show --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js prepare-training --workspace "$HEALTH_OS_WORKSPACE" \
  --as-of "$(date -u +%F)" --json
```

Personalize the profile and training configuration using the [getting started guide](docs/getting-started.md). A new workspace contains neutral defaults; preparation reports missing recovery data and marks its card as scheduled-only. Use `--json` with any command for machine-readable output, and `capabilities --json` to discover the available contract.

Health OS is early-stage, single-user software. Workspace files are unencrypted; see [security and privacy](SECURITY.md) for storage and access guidance.

## Documentation

- [Getting started and the training/recovery walkthrough](docs/getting-started.md)
- [Agent integration](docs/agent-integration-runbook.md) and [CLI reference](docs/cli-reference.md)
- [All documentation](docs/README.md), including architecture, connectors, memory, and development

## License

[MIT](LICENSE).
