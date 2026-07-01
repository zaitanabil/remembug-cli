# Contributing to Remembug

Remembug is a young project. The bar for contribution is "don't make it worse" and "tell us what you're doing."

See [docs/contributing.md](docs/contributing.md) for development setup details.

## How to contribute

1. **Pick an issue.** Look for `good-first-issue` and `help-wanted` labels.
2. **Open a draft PR early.** A 3-line "I'm planning to do X" PR description is enough — it stops two people from working on the same thing.
3. **Run `pnpm build && pnpm test && pnpm lint` before requesting review.** CI will run them anyway, but failing locally first is faster.
4. **Document anything user-visible.** A new CLI flag deserves a line in `docs/quickstart.md`. A new pattern in the scrubber deserves a sentence in `docs/privacy.md`.

## What we will say no to

- Cleanups across unrelated files. Small, focused PRs only.
- Refactors that make the code "more idiomatic" without changing behavior or testability.
- Dependencies for things we can do in 20 lines of Node.

## Code of conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Don't be a jerk.

## Security issues

Do **not** open a GitHub issue. See [SECURITY.md](SECURITY.md).
