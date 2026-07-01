---
name: '[seed] Add Ollama drafter provider'
about: 'Good first issue — implement the LLMProvider interface for Ollama.'
title: 'Implement Ollama provider for the drafter'
labels: ['good-first-issue', 'help-wanted', 'drafter']
assignees: ''
---

## Background

The drafter accepts any implementation of the `LLMProvider` interface (see [packages/daemon/src/drafter/providers/](../../packages/daemon/src/drafter/providers/) and the `provider` field of `RemembugConfig`). Anthropic is the only provider shipped in v0.1. Ollama gives users a local, no-network-required option.

## Goal

Add `OllamaProvider` implementing `LLMProvider.complete({ systemPrompt, userPrompt, temperature })`.

## Acceptance criteria

- [ ] `OllamaProvider` lives at `packages/daemon/src/drafter/providers/ollama.ts` and is exported from the drafter index.
- [ ] It talks to Ollama's `/api/chat` endpoint (default `http://127.0.0.1:11434`).
- [ ] Base URL is configurable via `RemembugConfig.llm` — a new optional field `base_url` is acceptable.
- [ ] Refuses non-200 responses with a clear error; never silently returns empty text.
- [ ] Vitest unit tests against a mocked fetch verifying:
  - happy path returns the expected `text` field;
  - non-200 → thrown error with the status code in the message;
  - request body wires through `temperature` and concatenates system + user prompts as Ollama expects.
- [ ] `docs/quickstart.md` gets a short "Using Ollama instead" subsection.

## Implementation hints

- `AnthropicProvider` is the reference. Mirror its shape: pure class with a `complete()` async method, no module-level state.
- Ollama returns `{ message: { content: string } }` for `/api/chat`. Map that to the provider's `{ text }` return.
- Default model: `llama3.1:8b-instruct-q5_K_M` is a reasonable starting point; document it.

## Stretch

A live smoke test that runs only when `REMEMBUG_OLLAMA_SMOKE=1` is set. Gate it on Ollama being reachable so CI stays green when it's not.
