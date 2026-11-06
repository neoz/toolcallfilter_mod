---
name: edit-config
description: Use when the user wants to add, change, remove or check privacy-mask terms or regex rules, or asks why their privacy-mask config is rejected.
---

# Editing the privacy-mask config

## Never Read, Write or Edit the config file directly

While the mod is active you see the file masked, and your tool arguments are unmasked before they
run. A term `"Acme Corp": "Contoso"` reads as `"Contoso": "Contoso"`; writing it back turns both
sides into `"Acme Corp"`, and the broken config then blocks every prompt. Make every change with the
script below. It edits one entry, checks the result with the mod's own validation, and writes only
when the result is valid.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/edit-config.mjs" <global|project> <operation> [arguments] [--root <project dir>]
```

| Operation | Arguments |
|---|---|
| `check` | none: validates both files and lists the regex rules |
| `add-term` | `<original> <replacement>`; replaces the replacement when the original exists |
| `remove-term` | `<original or replacement>` |
| `add-regex` | `<NAME> <pattern> [flags]`; replaces the rule with the same name |
| `remove-regex` | `<NAME>` |

- `global` is `~/.claude/privacy-mask.json`, for every project. `project` is
  `<project>/.claude/privacy-mask.json`; the project root defaults to the current directory.
- Quote every argument in single quotes. Pass the pattern as plain regex, not JSON-escaped:
  `'\b\d{1,3}(\.\d{1,3}){3}\b'`.
- To refer to a term already in the config, use the replacement you see; the script receives the
  original and handles either. Terms in the script's output are masked too, so it lists only
  counts and regex rules.

## Choosing values

Ask the user when a value is missing; do not invent a term the user did not name.

- Terms are exact and case-sensitive. Add each spelling that occurs (`Acme`, `ACME`).
- A replacement must be unique, must not occur in the user's real data, and must not contain or be
  contained in any original. `example`-style names (`Contoso`, `user1`, `example.internal`) work well.
- Rule names match `^[A-Z][A-Z0-9_]*$` and appear in placeholders (`IP_d6da262530`), so make them
  short and descriptive. `g` is always added to the flags.
- A project rule with the same name as a global one replaces it. Do not use that to narrow a global
  rule unless the user asks.
- Test a new pattern before adding it:
  `node -e 'console.log("text to try".match(new RegExp(process.argv[1], "g")))' '<pattern>'`.

## After a change

The script prints `ok` and the file it wrote, or `error:` with the reason and writes nothing. On an
error, fix the value and run it again. When it succeeds, tell the user to run `/reload-plugins`,
then `/privacy-mask` to confirm `mode: active`.

When the config is already rejected, the mod blocks every prompt, so this skill cannot run: the
user has to fix the file by hand (the error is in `/privacy-mask`) or start a session with mods off
(`claude --safe-mode`).
