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
- The conversation rows stored in the session transcript (`.jsonl`) contain only masked text.
  Known limitation: Claude Code writes `queue-operation` bookkeeping rows with the raw prompt
  text before any hook runs, for every prompt in `claude -p` / SDK sessions and for prompts
  typed mid-turn in interactive sessions. No mods API hook covers them; they stay local and
  are never sent to the model (verified in the smoke test).
  Known limitation: an attachment row keeps the engine's raw payload (for example the
  content of an `@`-mentioned file) "stored as made"; the model reads the masked rendering
  (verified in the smoke test).
- Known limitation: in `auto` permission mode the engine's permission classifier, a model
  call the mod cannot hook, receives tool arguments after they were unmasked.

## Decisions

| Topic | Decision |
|---|---|
| Replacement style | Terms: user-declared pairs `original -> replacement`. Regex rules: deterministic placeholders `NAME_<10 hex of HMAC-SHA256(secret, value)>`, e.g. `IP_7f3a9c21b0`. |
| Prompt cache | Masking is a deterministic function of (config, secret, text), so request prefixes stay byte-identical across requests and sessions. |
| Supported surfaces | Terminal CLI and Desktop Code tab. Unmasking happens at the render layer. `claude -p` and the VS Code chat panel show placeholders (known limitation). |
| Config location | `~/.claude/privacy-mask.json` (global) merged with `<project>/.claude/privacy-mask.json` (project wins on conflict). |
| Approach | Mask at every source that feeds the model, with `session.append` masking every conversation row; unmask at tool input and at the render layer. |
| Failure policy | Fail closed for every masking hook. |

Rejected approaches:

- `session.append` alone: it covers conversation rows but not the system prompt, tool
  descriptions, or the structured tool record kept in the transcript file.
- Local HTTP proxy via `ANTHROPIC_BASE_URL`: full coverage, but not a mod, needs a separate process and SSE handling.

## Facts from the v2.1.288 mods API (verified against local types and probes)

- `turn.step` input pins the request messages (`messageCount` only; "the messages are the
  engine's"). A mod cannot rewrite the outgoing request in one place.
- `session.append` fires for every row a conversation keeps (doors: `prompt`, `command`,
  `response`, `tool-result`, `tool-message`, `delivery`, `attachment`, `hook-context`,
  `note`, `compaction`, `notice`). `message.role` says under which role a request carries
  the row. Rewritable: text blocks' `text`, and a `tool_result`'s `content` and
  `is_error`; thinking and `tool_use` blocks are put back by the engine.
- `tool.call`: "A hook that returns the object it got makes core use [its messages]
  verbatim." Masking must therefore return a fresh `{ result, context }` without `ref`
  and `text`, so core validates and re-maps the masked `result`.
- `ui.render` rewrites change only the drawing, never the stored message.
- `globalThis.crypto.subtle` is not usable in the mods runtime (`importKey` is undefined);
  `crypto.getRandomValues` and `TextEncoder` work.
- `$.fs.read` paths are normalized to the platform (`/home/u/x` becomes `C:\home\u\x` on
  Windows); `$.env.get` needs literal names.

## Plugin layout

```
privacy-mask/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json        "modules": ["./register.js"]
│   ├── register.js       wires hooks; all $ calls (fs, store, ui, command) live here
│   ├── config.js         pure: parse, validate, merge configs
│   ├── hmac.js           pure: SHA-256 and HMAC-SHA256 in plain JS
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
- A replacement that contains any term original as a substring (would make masking
  non-idempotent, see below).

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
   Text already in placeholder form (`<configured rule name>_[0-9a-f]{10}`, no word
   boundaries) is left out of both the term pass and regex matching: the text is split
   around those tokens and only the parts between them are processed.

Idempotency: the same text is masked twice on its way in (`prompt.submit` then
`session.append`; `tool.call` then `session.append`), so `mask(mask(x)) === mask(x)` is
required. The placeholder skip above and the config rule that no replacement contains a
term original guarantee it.

`unmask(text)`:

1. Regex rules in reverse config order: replace `NAME_[0-9a-f]{10}` tokens (no word
   boundaries, since a rule may match inside an identifier) that exist in the reverse
   table with their original; unknown tokens stay unchanged.
2. Terms: one alternation of replacements, longest first, single pass, back to originals.

Properties:

- `mask` is deterministic: the same config, secret, and input always give the same output,
  in any session, with or without a stored reverse table.
- `unmask(mask(x)) === x` when `x` contains no literal replacement value or placeholder.
- Nested cases (a regex matching a term replacement) round-trip because unmask runs in
  exact reverse order.

HMAC implementation: `node:crypto` cannot be imported and `crypto.subtle` is unusable in
the mods runtime, so `hooks/hmac.js` implements SHA-256 and HMAC-SHA256 in plain JS
(synchronous). `mask` and `unmask` are synchronous.

`deepMask(value)` / `deepUnmask(value)`: walk plain objects and arrays, apply to every
string value, return a new structure; non-string leaves are returned as is. Base64 media
payloads are left untouched: any `base64` field, and `data` in an object whose `type` is
`base64` or `image`.

Known limitation: if real text already contains a string equal to a replacement value or
an issued placeholder, unmask rewrites it to the original.

## Secret and reverse table persistence

- Secret: 32 random bytes from `crypto.getRandomValues`, hex-encoded, stored in `$.store`
  under `privacy-mask:secret`; created once, shared by every session on the machine, never
  rotated by the mod. It never leaves the machine.
- Reverse table: stored in `$.store` under `privacy-mask:reverse:<project root>`
  (`$.session.root()`). Loaded lazily by the first hook that needs it (config, secret
  and reverse table load together, once per module load), written after a mask call
  that added entries. Entries are only ever added, and two sessions can only add identical entries
  for the same placeholder, so concurrent sessions do not conflict.
- `$.store` is capped at 4 MiB shared; entries are tens of bytes, so this is accepted. A
  failed save never blocks masking (the masked text does not depend on the table): the
  mod shows one toast and keeps working with the in-memory table.
- Global config home: `USERPROFILE` first, then `HOME`.

## Prompt cache

The Claude API caches a request prefix only when it is byte-identical to an earlier one.
Rules the implementation must keep:

- Masking is deterministic (see the mask engine); no counters or other session state
  influence the masked text.
- The mod never adds dynamic text (timestamps, counts, status) to the system prompt,
  context, tool descriptions, or prompts.
- History is masked when it enters the conversation; a second mask of the same text
  (idempotent) produces identical bytes, and stored rows are never re-masked later.
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
| `tool.call` (after `next`) | Answered: return a fresh `{ result: deepMask(result), context }` without `ref` and `text`; `context` is kept as received because the engine refuses a hook that rewrites entries a hook below attached, and those entries reach the model as attachments that `prompt.attachment` and `session.append` mask. Errored (`isError`): return `{ deny: mask(text) }`. Denied: return `{ deny: mask(deny) }`. |
| `prompt.section` | `await next(e)`, return `{ text: mask(text) }` (null stays null) |
| `prompt.context` | mask every block; return `{ blocks }` only, without `instructionFiles`, so the engine does not re-render `claudeMd` from the unmasked files |
| `prompt.attachment` | mask `text` |
| `skill.prompt` | mask `text` |
| `tool.describe` | mask `description` |
| `session.append` | For rows with `message.role` set: mask every text block's `text` and every `tool_result`'s `content` (string, or its text blocks); pass the rest through. Rows without a role (notices) pass unchanged. |

### Inbound (unmask what the user sees and tools execute)

| Event | Behavior |
|---|---|
| `tool.call` (before `next`) | deepUnmask all tool arguments except reserved `tool`, `tool_use_id`, `agentId`, `consent`. Exceptions for arguments the engine forwards to a model call: `WebSearch` arguments stay masked; `WebFetch` unmasks only `url`, its `prompt` stays masked. |
| `ui.render` `AssistantMessage` | unmask `props.text` |
| `ui.render` `UserMessage` | unmask `props.text` |
| `ui.render` `ToolUse` | deepUnmask `props.input` and `props.output` |
| `ui.render` `ToolResult` | deepUnmask `props.output` |
| `ui.render` `AskUserQuestion` | deepUnmask `props.questions` |

Render rewrites change only the drawing; stored messages stay masked. Read-only props
(`onScreen`, ids, flags) are passed through untouched.

### Verification: `tool.call` result `ref`

The types state that returning core's object makes core use its own (unmasked) messages
verbatim. A hook test asserts the returned object has no `ref` and no `text` and that its
`result` is masked. The manual smoke test confirms in the session `.jsonl` that the tool
result the model read is masked. If it is not, stop and report instead of shipping.

## Error handling

- No config file found: pass-through mode; one `$.ui.toast` at `session.start`.
- Config invalid: blocked mode; `prompt.submit` returns `{ drop: 'privacy-mask: config error in <file>: <reason>' }` until the config is fixed and `/reload-plugins` is run.
- Each masking hook has a `.catch` that fails closed:
  - `prompt.submit` -> `{ drop: reason }`
  - `tool.call` -> `{ deny: reason }`
  - `prompt.section`, `prompt.attachment` -> `{ text: null }`
  - `skill.prompt` -> `{ text: '' }` (its result type does not allow null)
  - `prompt.context` -> `{ blocks: [] }`
  - `tool.describe` -> `{ description: '' }`
  - `session.append` -> a hook may not refuse an engine row, so its `.catch` calls `next`
    with every text block and `tool_result` content replaced by
    `[privacy-mask: content withheld]`
- Render-layer unmask hooks have no `.catch`: a failure only affects display and leaves the
  model side masked.

## Command

`/privacy-mask` (runs without a Claude turn) prints: loaded config files, term count,
regex rule count, reverse table size for the project, current mode (active / pass-through /
blocked) and any config errors.

## Testing

Run with `claude plugin test`.

- `masker`: round-trip; longest term wins; repeated originals share one placeholder;
  term/regex nesting round-trips; deepMask/deepUnmask on nested objects and arrays;
  unknown placeholders untouched.
- Prompt cache determinism: the same input masks to the same output across two masker
  instances with the same secret and an empty reverse table; HMAC output matches a known
  test vector; a forced collision throws.
- Idempotency: `mask(mask(x)) === mask(x)` for terms, regex, and nested cases.
- `config`: merge precedence; invalid JSON, bad regex, bad rule name, duplicate
  replacement, replacement-contains-original errors.
- Hooks: `prompt.submit` masks; `session.append` masks text and tool_result rows and
  leaves notices; `tool.call` unmasks input before the tool and masks the result after
  it with no `ref`/`text`; `ui.render` unmasks all five sites; invalid config drops
  prompts; a throwing hook fails closed.
- Manual smoke test: `claude --plugin-dir ./privacy-mask`, ask Claude to read a file with
  an IP and an email and edit it; confirm the screen shows originals, the file on disk has
  originals, and the session `.jsonl` contains only placeholders.

## Out of scope

- Images and other non-text attachments.
- Masking calls other mods make through `$.model`.
- Unmasking in `claude -p` and the VS Code chat panel.
- Toggle, reset-reverse-table, or rotate-secret commands.
