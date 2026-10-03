# privacy-mask: Claude Code mod design

Date: 2026-10-03
Target: Claude Code v2.1.288 (mods API)

## Goal

A Claude Code mod that pseudonymizes sensitive text before the model reads it and
restores the original text in what the user sees and in what local tools execute.

Success criteria:

- The model (Anthropic API) only ever receives masked text for every source the mod covers.
- The user sees original values in the terminal / Desktop transcript.
- Files written and commands run by tools contain original values.
- The stored session transcript (`.jsonl`) contains only masked text.

## Decisions

| Topic | Decision |
|---|---|
| Replacement style | Terms: user-declared pairs `original -> replacement`. Regex rules: deterministic placeholders `NAME_<10 hex of HMAC-SHA256(secret, value)>`, e.g. `IP_7f3a9c21b0`. |
| Prompt cache | Masking is a deterministic function of (config, secret, text), so request prefixes stay byte-identical across requests and sessions. |
| Supported surfaces | Terminal CLI and Desktop Code tab. Unmasking happens at the render layer. `claude -p` and the VS Code chat panel show placeholders (known limitation). |
| Config location | `~/.claude/privacy-mask.json` (global) merged with `<project>/.claude/privacy-mask.json` (project wins on conflict). |
| Approach | Mask at every source that feeds the model; unmask at tool input and at the render layer. `session.append` as defense-in-depth if verified. |
| Failure policy | Fail closed for every masking hook. |

Rejected approaches:

- Single choke point via `session.append` only: not in public types (2.1.277); unclear whether the user prompt row is appended before the first request of a turn.
- Local HTTP proxy via `ANTHROPIC_BASE_URL`: full coverage, but not a mod, needs a separate process and SSE handling.

## Key constraint from the mods API

`turn.step` input pins the request messages (`messageCount` only; "the messages are the
engine's"). A mod cannot rewrite the outgoing request in one place, so it must mask each
source of text that enters the conversation or the system prompt.

## Plugin layout

```
privacy-mask/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json        "modules": ["./register.js"]
│   ├── register.js       wires hooks; all $ calls (fs, store, ui, command) live here
│   ├── config.js         pure: parse, validate, merge configs
│   └── masker.js         pure: mask, unmask, deepMask, deepUnmask
└── tests/*.test.ts
```

The mods validator forbids passing `$` to a function imported from another file, so
`config.js` and `masker.js` contain only pure functions without I/O.

## Config format

```json
{
  "terms": {
    "Acme Corp": "Contoso",
    "khiemnnm": "user1"
  },
  "regex": [
    { "name": "EMAIL", "pattern": "[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+" },
    { "name": "IP", "pattern": "\\b\\d{1,3}(\\.\\d{1,3}){3}\\b", "flags": "" }
  ]
}
```

Merge rules:

- `terms`: union of both files; on the same original key, the project value wins.
- `regex`: union by `name`; on the same `name`, the project rule wins. Global rules keep
  their order, then project-only rules follow in their file order.

Validation errors (config enters blocked mode):

- Invalid JSON.
- `terms` not an object of non-empty string to non-empty string.
- Regex rule without `name` matching `^[A-Z][A-Z0-9_]*$`, or without `pattern`.
- Pattern or flags that do not compile. The `g` flag is always added by the masker.
- Two terms mapping to the same replacement (would make unmask ambiguous).

Validation warnings (shown, not blocking):

- A replacement value equal to some term's original.

## Mask engine (`masker.js`)

Inputs: the merged config, a local secret key, and a reverse table
`{ [placeholder]: original }` used only for unmasking.

Placeholder for a regex match: `NAME_` + the first 10 lowercase hex characters of
`HMAC-SHA256(secret, NAME + "\0" + value)`. A keyed HMAC is required: a plain hash of a
small value space (IPv4 has 2^32 values) could be brute-forced back to the original.

`mask(text)`:

1. Terms: one alternation regex of all term originals, escaped, sorted longest first,
   case-sensitive; replace each match with its replacement in a single pass.
2. Regex rules, in config order: replace each match with its HMAC placeholder and add
   `placeholder -> match` to the reverse table. If the reverse table already maps that
   placeholder to a different original (HMAC collision), throw so the hook fails closed.

`unmask(text)`:

1. Regex rules in reverse config order: replace `\bNAME_[0-9a-f]{10}\b` tokens that exist
   in the reverse table with their original; unknown tokens stay unchanged.
2. Terms: one alternation of replacements, longest first, single pass, back to originals.

Properties:

- `mask` is deterministic: the same config, secret, and input always give the same output,
  in any session, with or without a stored reverse table.
- `unmask(mask(x)) === x` when `x` contains no literal replacement value or placeholder.
- Nested cases (a regex matching a term replacement) round-trip because unmask runs in
  exact reverse order.

HMAC implementation: the hooks module may only import files inside the plugin, so
`node:crypto` is not available. The plan must verify whether `globalThis.crypto.subtle`
works in the mods runtime; if it does not, the plugin ships a small pure-JS SHA-256/HMAC
in `hooks/hmac.js`. If `crypto.subtle` is used, `mask` becomes async.

`deepMask(value)` / `deepUnmask(value)`: walk plain objects and arrays, apply to every
string value, return a new structure; non-string leaves are returned as is.

Known limitation: if real text already contains a string equal to a replacement value or
an issued placeholder, unmask rewrites it to the original.

## Secret and reverse table persistence

- Secret: 32 random bytes from `crypto.getRandomValues`, hex-encoded, stored in `$.store`
  under `privacy-mask:secret`; created once, shared by every session on the machine, never
  rotated by the mod. It never leaves the machine.
- Reverse table: stored in `$.store` under `privacy-mask:reverse:<project root>`
  (`$.session.root()`). Loaded at `session.start`, written after a mask call that added
  entries. Entries are only ever added, and two sessions can only add identical entries
  for the same placeholder, so concurrent sessions do not conflict.
- `$.store` is capped at 4 MiB shared; entries are tens of bytes, so this is accepted.

## Prompt cache

The Claude API caches a request prefix only when it is byte-identical to an earlier one.
Rules the implementation must keep:

- Masking is deterministic (see the mask engine); no counters or other session state
  influence the masked text.
- The mod never adds dynamic text (timestamps, counts, status) to the system prompt,
  context, tool descriptions, or prompts.
- History is masked once, when it enters the conversation, and never re-masked.
- Unmasking happens only at the render layer and at tool input, neither of which is part
  of a request.
- Changing the config (adding or removing a term or rule, reordering rules) changes the
  masked system prompt and causes one cache miss; this is accepted and documented.
- Losing the reverse table does not change any masked output; it only means older
  placeholders show unresolved on screen.

## Hooks

### Outbound (mask what the model reads)

| Event | Behavior |
|---|---|
| `prompt.submit` | `next({ ...e, text: mask(e.text), context: e.context?.map(mask) })` |
| `tool.call` (after `next`) | deepMask `result`, `context`, and `deny`; return without core's `ref` and `text` so core re-maps the masked `result` (must be verified, see below) |
| `prompt.section` | `await next(e)`, return `{ text: mask(text) }` (null stays null) |
| `prompt.context` | mask every block |
| `prompt.attachment` | mask `text` |
| `skill.prompt` | mask `text` |
| `tool.describe` | mask `description` |
| `session.append` | deepMask the row content before storage, only if local 2.1.288 types confirm the event semantics |

### Inbound (unmask what the user sees and tools execute)

| Event | Behavior |
|---|---|
| `tool.call` (before `next`) | deepUnmask all tool arguments except reserved `tool`, `tool_use_id`, `agentId`, `consent` |
| `ui.render` `AssistantMessage` | unmask `props.text` |
| `ui.render` `UserMessage` | unmask `props.text` |
| `ui.render` `ToolUse`, `ToolResult` | deepUnmask `props` |

Render rewrites change only the drawing; stored messages stay masked.

### Verification gate: `tool.call` result `ref`

Core's result is `{ ref, result, text }`, where `ref` names core's own messages. If core
reuses those messages instead of the hook's returned `result`, original tool output would
reach the model. Before shipping, a test (and the manual smoke test) must prove the model
receives the masked output. If it cannot be proven, stop and report instead of shipping.

## Error handling

- No config file found: pass-through mode; one notice at `session.start`.
- Config invalid: blocked mode; `prompt.submit` returns `{ drop: 'privacy-mask: config error in <file>: <reason>' }` until the config is fixed and `/reload-plugins` is run.
- Each masking hook has a `.catch` that fails closed:
  - `prompt.submit` -> `{ drop: reason }`
  - `tool.call` -> `{ deny: reason }`
  - `prompt.section`, `prompt.attachment`, `skill.prompt` -> `{ text: null }`
  - `prompt.context` -> `{ blocks: [] }`
  - `tool.describe` -> `{ description: '' }`
- Render-layer unmask hooks have no `.catch`: a failure only affects display and leaves the
  model side masked.

## Command

`/privacy-mask` (runs without a Claude turn) prints: loaded config files, term count,
regex rule count, reverse table size for the project, current mode (active / pass-through /
blocked) and any config errors or warnings.

## Testing

Run with `claude plugin test`.

- `masker`: round-trip; longest term wins; repeated originals share one placeholder;
  term/regex nesting round-trips; deepMask/deepUnmask on nested objects and arrays;
  unknown placeholders untouched.
- Prompt cache determinism: the same input masks to the same output across two masker
  instances with the same secret and an empty reverse table; HMAC output matches a known
  test vector; a forced collision throws.
- `config`: merge precedence; invalid JSON, bad regex, bad rule name, duplicate
  replacement errors; replacement-equals-original warning.
- Hooks: `prompt.submit` masks; `tool.call` unmasks input before the tool and masks the
  result after it; `ref` verification test; `ui.render` unmasks all four sites; invalid
  config drops prompts; a throwing hook fails closed.
- Manual smoke test: `claude --plugin-dir ./privacy-mask`, ask Claude to read a file with
  an IP and an email and edit it; confirm the screen shows originals, the file on disk has
  originals, and the session `.jsonl` contains only placeholders.

## Out of scope

- Images and other non-text attachments.
- Masking calls other mods make through `$.model`.
- Unmasking in `claude -p` and the VS Code chat panel.
- Toggle, reset-reverse-table, or rotate-secret commands.
