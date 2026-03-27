# pi-reviewer-extension

A dedicated TypeScript Pi extension workspace for building a stateful internal reviewer.

## Development

Install dependencies:

```bash
pnpm install
```

Run the validation commands:

```bash
pnpm test
pnpm typecheck
pnpm validate
```

## Local Pi loading

Quick-load the entrypoint file directly during development:

```bash
pi -e ./src/index.ts
```

Load the package/directory form to exercise `package.json -> pi.extensions`:

```bash
pi -e .
```

Optional convenience script:

```bash
pnpm smoke:pi
```

Use `pnpm smoke:pi` for a quick package-loading sanity check. Use the isolated RPC command in [docs/manual-smoke-checklist.md](./docs/manual-smoke-checklist.md) when you need to validate bridge behavior, same-session reviewer memory, or model-switch resets.

## Local install into `~/.pi/agent/extensions/`

For normal Pi usage and `/reload`, install the extension as a directory/package, not as a single entrypoint file.

Preferred helper script:

```bash
./scripts/link-extension.sh
```

That creates or updates this symlink:

```text
~/.pi/agent/extensions/pi-reviewer-extension -> /Users/andrey.oskin/ai/pi-reviewer-extension
```

Equivalent manual command:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn /Users/andrey.oskin/ai/pi-reviewer-extension ~/.pi/agent/extensions/pi-reviewer-extension
```

Notes:
- this links the whole package directory, so Pi loads `package.json` and the declared `pi.extensions` entrypoint
- this is the preferred local install model for this repo
- `pi -e ./src/index.ts` is still useful for quick iteration, but it does not exercise the auto-discovered package install path

## Reloading Pi after changes

After linking into `~/.pi/agent/extensions/`, reload Pi in one of these ways:

1. If Pi is already running interactively, run:

   ```text
   /reload
   ```

2. Or fully restart Pi:

   ```bash
   pi
   ```

`/reload` works for auto-discovered extensions under `~/.pi/agent/extensions/` or `.pi/extensions/`, which is why the directory symlink above is the recommended workflow.

## Validating the extension is active

Use one quick structural check and one functional check.

Structural check:
- start Pi after linking/reloading
- confirm the startup header lists the loaded extension

Functional check:
- ask Pi to use the internal reviewer bridge explicitly once, for example:

  ```text
  Use the reviewer_bridge tool to sanity-check whether the extension is loaded, then tell me what tool you used.
  ```

- confirm the run shows the `reviewer_bridge` tool execution and Pi returns a reviewer-backed answer

If you want an isolated package-loading smoke run outside your normal session, use:

```bash
pi --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --model github-copilot/gpt-5.4:high -e .
```

## Runtime validation

A real Pi RPC smoke run was completed on 2026-03-27 using:

```bash
pi --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --model github-copilot/gpt-5.4:high -e .
```

Validated outcomes:
- package/directory loading via `pi -e .`
- main-session bridge execution with visible `tool_execution_*` events for `reviewer_bridge`
- same-session reviewer memory across two bridge calls
- reviewer reset after switching the main model to `github-copilot/claude-sonnet-4.6` and restoring `high` thinking with `set_thinking_level`
- no-recursion / no-write behavior from a question-only reviewer probe

See `docs/manual-smoke-checklist.md` for exact prompts, commands, and observations.

## Architecture and runtime notes

- [docs/architecture.md](./docs/architecture.md) explains the internal bridge design, reviewer isolation, model policy, and v1.1 persistence direction.
- [docs/runtime-behavior.md](./docs/runtime-behavior.md) summarizes lifecycle expectations, reset/compaction behavior, tradeoffs, and when the main agent should consult the reviewer.

## Using `reviewer_bridge` well

The tool accepts:
- `question` (required)
- `context` (optional)
- `focus` (optional)
- `resetSession` (optional)

Use `resetSession: true` when the next review is about an unrelated topic, or when prior reviewer memory would likely bias or confuse the answer.

Important: `resetSession` is **not** a reset-only mode. It starts a fresh reviewer session and asks the new question in the same tool call.

If the new review is part of the same thread of work, omit `resetSession` so the reviewer can keep useful same-session context.

## Notes

- The extension entrypoint lives in `src/index.ts`.
- `REVIEWER_EXTENSION_ID` is the stable extension identity exported for registration/tests; it is not a runtime routing knob.
- `package.json` declares `pi.extensions` so the package can be loaded as a Pi extension directory.
- Directory/package loading is the preferred bootstrap validation path because it exercises the package manifest shape, not just the raw entrypoint file.
- No build step is required in v1. Pi loads the TypeScript entrypoint directly via its TypeScript runtime.
- Runtime caveat: for RPC model switching, `set_model` changed the model but I still used a separate `set_thinking_level` call to keep `high` thinking explicit.
- Runtime caveat: reviewer “memorize this token” probes were treated as prompt injection; use legitimate review artifacts for persistence smoke checks.
- Runtime caveat: for reviewer isolation probes, keep the bridge call question-only when possible; the main agent may otherwise add helpful-but-misleading context of its own.
