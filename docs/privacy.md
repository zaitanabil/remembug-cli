# Privacy

This document is about **what leaves your machine, what reaches the LLM, and what lands on disk**. If anything here is unclear or wrong, please open an issue — privacy posture only matters if it's documented and verifiable.

## TL;DR

1. **Hooks are loopback-only.** They POST to `127.0.0.1`. The daemon's listener is bound to `127.0.0.1` explicitly; there is no LAN- or internet-reachable port.
2. **Transcripts are scrubbed before they ever touch the drafter.** Three independent passes (patterns → env lines → entropy) reduce known secrets to `[REDACTED:type]` markers.
3. **The drafter has a tripwire.** If the scrubbed transcript still contains anything matching the secret-pattern bank, the drafter refuses and the entry is dropped.
4. **The LLM only sees scrubbed text.** The unscrubbed original never reaches Anthropic (or any provider) and is not persisted to disk.
5. **No telemetry.** There is no metrics endpoint, no opt-in analytics, no crash reporter. The dependencies don't phone home either (audited list below).
6. **One outbound destination by default.** The Anthropic API, when drafting. That's it. Configure another provider and you've replaced the destination.

## What gets stored

`~/.remembug/` is the only on-disk surface area, with this structure:

```
~/.remembug/
  config.json          ← provider name + model name + port + thresholds. NO keys.
  remembug.db             ← SQLite DB (entries, projects, feedback, raw_transcripts).
  logs/
    daemon.log         ← rotated, debug-level when REMEMBUG_LOG=debug.
    scrubber.log       ← redaction counts (types only, never values).
```

`raw_transcripts.scrubbed_content` retains the **scrubbed** span text for audit. The unscrubbed original is not written, anywhere.

## The scrubber

Three layers in [packages/daemon/src/scrubber/index.ts](../packages/daemon/src/scrubber/index.ts):

### Layer 1 — pattern bank

Known secret formats with low false-positive rates:

| Type                      | Pattern shape                                             |
| ------------------------- | --------------------------------------------------------- |
| `aws_access_key`          | `AKIA` + 16 uppercase alphanumerics                       |
| `github_token`            | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` + ≥36 chars        |
| `github_fine_grained_pat` | `github_pat_` + 82 chars                                  |
| `jwt`                     | three dot-separated base64url segments                    |
| `private_key_block`       | `-----BEGIN [...] PRIVATE KEY-----` … `-----END ...-----` |
| `openssh_private_key`     | OpenSSH-format private key block                          |
| `slack_token`             | `xox[a-s]-` family                                        |
| `stripe_key`              | `sk_/pk_/rk_` + `test/live`                               |
| `openai_key`              | `sk-` (not `sk-ant-`) + ≥20 chars                         |
| `anthropic_key`           | `sk-ant-` + ≥20 chars                                     |
| `google_api_key`          | `AIza` + 35 chars                                         |

AWS _secret_ access keys are deliberately not pattern-matched — they're 40 random base64 chars with no reliable prefix, indistinguishable from arbitrary data. Layer 3 catches the real ones via entropy without flagging hex commit SHAs as a side effect.

### Layer 2 — env-style lines

Lines matching `^KEY=value$` are redacted when:

- the value is ≥12 chars, or
- the line references a known secret path (`.env`, `secrets/`, `credentials/`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`), or
- the value's Shannon entropy is ≥ `entropy_threshold` (default 4.5 bits/char).

### Layer 3 — entropy catch-all

Tokens ≥20 chars with Shannon entropy ≥4.5 bits/char are redacted, with one exception: hash-like tokens (long runs of pure hex or pure alphanumerics matching commit-SHA shapes) pass through. This was a deliberate trade — git commit SHAs are valuable context to keep in a debugging entry, and they don't carry secret material.

### The tripwire

After scrubbing, `looksLikeSecretLeak()` reruns the Layer-1 pattern bank. If it fires, the drafter refuses to call the LLM at all and emits `{ kind: 'refused', reason: 'secrets' }`. This is defense-in-depth: it would only fail if Layer 1 somehow let something through (e.g., a pattern was disabled).

## What does NOT get scrubbed

By design:

- **Stack traces.** Function names and line numbers stay — they're the entire point.
- **Repo-relative file paths** _inside_ the transcript content (`src/auth/login.ts`). Absolute-path-like sequences (`/Users/...`, `C:\\Users\\...`) are canonicalized in the **fingerprint** but appear unchanged in stored content.
- **Tool-name, exit-code, error-name, common error messages.** All useful for retrieval.
- **Project structure inferred from `cwd`.**

If your codebase encodes secrets in source filenames, the scrubber will not catch that. Don't do that.

## What reaches the LLM

Exactly the contents of the user prompt assembled in [packages/daemon/src/drafter/prompt.ts](../packages/daemon/src/drafter/prompt.ts):

```
Project stack: {tokens like node@20, vite@5}
Initial trigger: {short summary}

Transcript (already scrubbed of secrets, lossy):

{scrubbedTranscript}

Draft the YAML now.
```

…plus the system prompt, which is static.

The drafter is also instructed to refuse with `REFUSE:secrets` if it sees credentials. Three layers, plus the tripwire, plus the model — four chances for something to not leak.

## Outbound network

Default install hits exactly one external endpoint:

- `https://api.anthropic.com/v1/messages` — the Anthropic API, when the daemon drafts an entry.

If you swap providers in `~/.remembug/config.json`:

- `provider: "openai"` → `https://api.openai.com`
- `provider: "ollama"` → whatever URL you configured locally (default `http://127.0.0.1:11434`)

The daemon's own HTTP server is bound to `127.0.0.1` and is not reachable from the LAN. The MCP server speaks stdio only — no socket of its own.

## Things to be paranoid about anyway

- **The `transcript_path` in hook payloads.** Claude Code's hook system sends a path to a transcript file on disk. Remembug reads only the events it's POSTed; it does not slurp the full transcript file. If you want to be extra cautious, audit `packages/daemon/src/hooks/post-tool-use.ts` — it should only consume `tool_input` / `tool_response` fields, never `transcript_path`.
- **`tool_input` payloads.** Some tool invocations contain literal secrets in their arguments (e.g. a curl command with `-H "Authorization: Bearer ..."`). The pattern bank handles common forms but is not exhaustive. The entropy layer is the backstop.
- **`tool_response.stdout/stderr`.** Same risk. Same backstop.
- **Your `~/.remembug/config.json`.** It contains the **name** of an env var to read, never the key value. The CLI's `config set anthropic-key` writes to the OS keychain on macOS, plain-text fallback otherwise — see the implementation in `packages/cli/src/commands/config.ts`.

## Reporting a leak

If you see a value in `remembug.db` that should have been scrubbed, that's a bug we want to fix. See [SECURITY.md](../SECURITY.md) for the disclosure process. Please include the **type** of secret (so we can write a pattern) but never the actual value.
