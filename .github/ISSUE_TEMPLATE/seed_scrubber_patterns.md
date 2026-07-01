---
name: '[seed] Add more secret patterns to the scrubber'
about: 'Good first issue — extend the pattern bank with common cloud/provider secrets.'
title: 'Extend scrubber pattern bank (GCP / Azure / Twilio / npm tokens)'
labels: ['good-first-issue', 'help-wanted', 'scrubber', 'security']
assignees: ''
---

## Background

The Layer-1 pattern bank in [packages/daemon/src/scrubber/patterns.ts](../../packages/daemon/src/scrubber/patterns.ts) catches the highest-confidence secret formats. The entropy fallback (Layer 3) catches most of what Layer 1 misses, but it's also the layer most likely to false-positive on long innocuous tokens. Every pattern we add to Layer 1 is one less thing the entropy layer has to handle.

## Goal

Add patterns + adversarial test cases for four common credential formats:

- **GCP service-account JSON blobs** — match the wrapping JSON (look for the `"private_key": "-----BEGIN PRIVATE KEY-----` shape).
- **Azure storage connection strings** — `DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=...`.
- **Twilio auth tokens** — 32-char hex following `AC` account SID and a separator.
- **npm tokens** — `npm_` + 36 base62 chars (modern fine-grained tokens).

## Acceptance criteria

- [ ] Each pattern lives in `SECRET_PATTERNS` with a stable `name`.
- [ ] For each new pattern: at least 2 positive tests (one tight, one in flowing text) and at least 1 negative test (something that _looks_ similar but isn't a secret — e.g., a legitimate Azure docs URL for the connection-string one).
- [ ] `docs/privacy.md` table is updated with the new pattern names.
- [ ] No regressions in `packages/daemon/src/scrubber/scrubber.test.ts`.

## Implementation hints

- Match formats end-to-end where possible (don't just match `AccountKey=...` in isolation — match the surrounding `=...;` so a stray query-string param doesn't trigger it).
- For the GCP JSON case: matching the OpenSSL header alone may already be enough (the existing `private_key_block` pattern). If so, contribute a test case that proves it and skip the GCP-specific regex.
- Run the adversarial fixtures in `scrubber.test.ts` before and after to confirm you didn't regress entropy-layer behavior.

## Out of scope

- A pluggable, file-based pattern registry. Stick with the in-source array for now — additions are cheap and reviews catch malformed patterns.
