## Summary

<!-- 1–3 sentences. What and why. The diff shows how. -->

## Changes

<!-- Bullet list of the user-visible or architecturally-relevant changes. -->

-
-

## Test plan

<!-- Checklist of what you ran locally. CI re-runs all of this. -->

- [ ] `pnpm install`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm lint`

## Docs

<!-- Tick everything that applies. New CLI flag → docs/quickstart.md.
     New scrubber pattern → docs/privacy.md. New MCP tool / route →
     docs/claude-code-integration.md. -->

- [ ] No user-visible change; docs untouched.
- [ ] Updated `docs/`.
- [ ] Updated README.

## Privacy / security checklist

<!-- Tick if any of these apply. -->

- [ ] Touches the scrubber, drafter, or anything that consumes hook payloads.
- [ ] Adds an outbound network call.
- [ ] Adds a new on-disk file under `~/.remembug/`.

If any box above is ticked, please describe the threat model implications below.
