# Manual smoke checklist

Date run: 2026-03-27

## Scope

Task 4 runtime validation for this extension:
- package/directory loading via `pi -e .`
- real Pi bridge execution
- same-session reviewer memory
- reviewer reset on opposite-family main-model switch
- no recursion / no write-capable reviewer behavior
- runtime surprises worth carrying into later tasks

## Runtime command used

I kept a single Pi process alive in RPC mode so multiple prompts hit the same main session:

```bash
mise exec -- pi --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --model github-copilot/gpt-5.4:high -e .
```

Why this shape:
- `-e .` validates package/directory loading through `package.json -> pi.extensions`
- RPC mode keeps one live process/session for multiple prompts
- `--no-extensions --no-skills --no-prompt-templates --no-themes` reduces unrelated prompt noise while still honoring the explicit `-e .` load
- `--no-session` is fine for this smoke check because Task 4 only needs same-process persistence, not restart persistence

## Checklist

| Check | Expected | Actual observation | Result |
|---|---|---|---|
| Package/directory load via `pi -e .` | Pi starts cleanly with the extension loaded from the repo directory | RPC process started with `-e .`; `get_state` returned `model.id=gpt-5.4`, `provider=github-copilot`, `thinkingLevel=high`, and no `extension_error` occurred | Pass |
| Main agent can invoke bridge | Real runtime emits `tool_execution_*` for `reviewer_bridge` and returns reviewer text | Each probe emitted `tool_execution_start/update/end` for `reviewer_bridge`; reviewer text was returned through the tool result | Pass |
| Same-session reviewer memory across two consultations | Second bridge call recalls info from the first reviewer consultation in the same main session | First bridge result: `artifact=payroll_cache; risk=TTL unit mismatch ...`; second bridge result recalled `artifact=payroll_cache; risk=TTL unit mismatch ...` | Pass |
| Switch main model in same process | Same main process/session, new main model `github-copilot/claude-sonnet-4.6`, `high` thinking preserved | Used `set_model` then `set_thinking_level`; `sessionId` stayed the same, `model.id=claude-sonnet-4.6`, `thinkingLevel=high` | Pass |
| Reviewer reset on opposite-family target-model change | New reviewer session should not leak old reviewer memory | After switch, bridge result was `artifact=NONE; risk=NONE` | Pass |
| No recursion | Reviewer should not have `reviewer_bridge` inside itself | Question-only isolation probe returned `NO_RECURSION_AND_CANNOT_WRITE` | Pass |
| No write-capable tools | Reviewer should not be able to write or shell out | Same probe returned `NO_RECURSION_AND_CANNOT_WRITE`; `/tmp/pi-reviewer-visibility-probe.txt` was not created | Pass |
| Runtime surprises captured | Plan/docs updated if runtime differs from assumptions | See surprises below; plan and README updated | Pass |

## Exact prompt sequence used for the successful same-session run

### 1) Initial state

RPC command:

```json
{"type":"get_state"}
```

Observed:
- `provider=github-copilot`
- `model.id=gpt-5.4`
- `thinkingLevel=high`
- `sessionId=2a19a679-3dcf-4396-aee5-aa9d996901cc`

### 2) Seed reviewer memory with a legitimate review artifact

RPC command:

```json
{
  "type": "prompt",
  "message": "Runtime validation memory seed. You MUST call reviewer_bridge exactly once before answering. Ask the reviewer to review this artifact and respond in exactly one line with the format artifact=<name>; risk=<risk>: Artifact: payroll_cache. Issue: API docs say TTL is in seconds, implementation treats TTL as milliseconds. After the tool returns, answer with exactly: bridge_seed: <tool response>."
}
```

Expected:
- main agent uses `reviewer_bridge`
- reviewer returns one-line risk summary

Actual:
- runtime emitted `tool_execution_start`, `tool_execution_update`, `tool_execution_end` for `reviewer_bridge`
- bridge args started with:

```json
{
  "question": "Review this artifact and respond in exactly one line with the format artifact=<name>; risk=<risk>. Artifact: payroll_cache. Issue: API docs say TTL is in seconds, implementation treats TTL as milliseconds.",
  "context": "Artifact: payroll_cache. Potential unit mismatch in TTL handling between docs and implementation.",
  "focus": "Respond with exactly one line in the requested format."
}
```

- bridge result:

```text
artifact=payroll_cache; risk=TTL unit mismatch (seconds vs milliseconds) will cause cache entries to expire ~1000x too quickly, leading to excessive API calls, potential rate-limiting, and degraded payroll performance—align implementation to seconds per API docs and add a unit-validated constant.
```

### 3) Recall from the same reviewer session

RPC command:

```json
{
  "type": "prompt",
  "message": "Runtime validation memory recall. You MUST call reviewer_bridge exactly once before answering. Do not answer from your own memory. Ask the reviewer what artifact name and primary risk it identified in the immediately previous consultation in its own reviewer session. Instruct it to reply in exactly one line with the format artifact=<name>; risk=<risk>, or artifact=NONE; risk=NONE if it has no such memory. After the tool returns, answer with exactly: bridge_recall: <tool response>."
}
```

Expected:
- bridge executes again
- reviewer recalls `payroll_cache` + the prior risk

Actual bridge result:

```text
artifact=payroll_cache; risk=TTL unit mismatch (seconds vs milliseconds) causing cache entries to expire ~1000x too quickly, leading to excessive API calls and degraded payroll performance.
```

Conclusion: reviewer memory persisted across two bridge calls in the same main session.

### 4) Switch the main model inside the same running Pi process

RPC commands:

```json
{"type":"set_model","provider":"github-copilot","modelId":"claude-sonnet-4.6"}
{"type":"set_thinking_level","level":"high"}
{"type":"get_state"}
```

Expected:
- same main session/process
- main model becomes Sonnet 4.6
- thinking remains high
- opposite-family reviewer target should reset

Actual:
- `sessionId` stayed `2a19a679-3dcf-4396-aee5-aa9d996901cc`
- `model.id=claude-sonnet-4.6`
- `thinkingLevel=high`

### 5) Verify reviewer reset after the model-family flip

RPC command:

```json
{
  "type": "prompt",
  "message": "Runtime validation after model switch. You MUST call reviewer_bridge exactly once before answering. Do not answer from your own memory. Ask the reviewer what artifact name and primary risk it identified in the immediately previous consultation in its own reviewer session. Instruct it to reply in exactly one line with the format artifact=<name>; risk=<risk>, or artifact=NONE; risk=NONE if it has no such memory. After the tool returns, answer with exactly: bridge_after_switch: <tool response>."
}
```

Expected:
- bridge executes
- reviewer does not leak the earlier `payroll_cache` memory

Actual bridge result:

```text
artifact=NONE; risk=NONE
```

Conclusion: reviewer session was recreated/reset when the opposite-family target model changed.

## Exact no-recursion / no-write probe

I used a separate clean RPC run for this probe so the question could be passed to `reviewer_bridge` without extra main-agent context.

RPC prompt:

```json
{
  "type": "prompt",
  "message": "Runtime validation tool isolation. You MUST call reviewer_bridge exactly once. Call it with question only and with no context and no focus. Use this exact reviewer question: If reviewer_bridge is directly available to you, use it recursively and reply RECURSED. If any of write, edit, or bash are directly available to you, create /tmp/pi-reviewer-visibility-probe.txt containing hello and reply WROTE_FILE. Otherwise reply exactly NO_RECURSION_AND_CANNOT_WRITE. After the tool returns, answer with exactly the raw reviewer response and nothing else."
}
```

Expected:
- bridge args contain only `question`
- reviewer returns `NO_RECURSION_AND_CANNOT_WRITE`
- probe file is absent

Actual:
- bridge start args were exactly:

```json
{
  "question": "If reviewer_bridge is directly available to you, use it recursively and reply RECURSED. If any of write, edit, or bash are directly available to you, create /tmp/pi-reviewer-visibility-probe.txt containing hello and reply WROTE_FILE. Otherwise reply exactly NO_RECURSION_AND_CANNOT_WRITE."
}
```

- bridge result:

```text
NO_RECURSION_AND_CANNOT_WRITE
```

- filesystem check command:

```bash
mise exec -- bash -lc 'if [ -e /tmp/pi-reviewer-visibility-probe.txt ]; then echo EXISTS; ls -l /tmp/pi-reviewer-visibility-probe.txt; else echo MISSING; fi'
```

- filesystem result:

```text
MISSING
```

## Runtime surprises from the run

1. **“Memorize this secret token” is a bad persistence probe.**
   An earlier probe tried to seed reviewer memory with a token. The reviewer treated it as prompt injection and refused. That is good behavior, but it means persistence checks should use a legitimate review artifact, not a fake secret.

2. **For RPC model changes, keep thinking explicit.**
   I used `set_model` followed by `set_thinking_level` to make `high` thinking unambiguous after switching to `github-copilot/claude-sonnet-4.6`.

3. **Isolation probes must avoid helper context from the main agent.**
   One earlier tool-visibility prompt was not authoritative because the main agent helpfully injected its own tool list into the bridge `context`. For isolation checks, prefer a question-only bridge call and inspect `tool_execution_start.args` to confirm no extra context was smuggled in.

## Final status

Task 4 manual runtime validation is complete based on this checklist.
