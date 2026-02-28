# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2025-02-27

### Added

- `AgentWorker` with single-agent and multi-agent orchestration via BullMQ Flows
- `AgentClient` for sending prompts, confirming tool calls, and retrieving conversation history
- LLM-powered routing for multi-agent mode (automatic dispatch to relevant agents)
- Parallel agent execution with aggregator for multi-agent results
- Persistent sessions — conversations survive process restarts
- Tool confirmation flow with `autoExecuteTools` option
- TypeBox-based type-safe tool definitions
- Provider-agnostic LLM support via LangChain's `initChatModel`
- Redis-backed state using ZSCAN + pipelined HGET for efficient history reconstruction
- Example CLI applications for single-agent and multi-agent modes
