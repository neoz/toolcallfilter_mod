# privacy-mask

A Claude Code mod that keeps sensitive values away from the model. It replaces configured
terms and regex matches in everything Claude reads, and restores the originals in what you
see on screen and in what local tools run.

```
You type:        Deploy to Acme Corp at 10.0.0.5
Claude reads:    Deploy to Contoso at IP_d6da262530
You see:         Deploy to Acme Corp at 10.0.0.5
Bash runs:       ssh 10.0.0.5
```

## Requirements

- Claude Code v2.1.288 or later (`claude --version`)
- Mods enabled (the default). They do not load with `--safe-mode`, `--bare`, or
  `"disableAllHooks": true`.
- The terminal CLI or the Code tab of the Desktop app, for on-screen restoring (see
  [Limitations](#limitations))

## Install

Load the plugin directory for one session:

```bash
claude --plugin-dir /path/to/privacy-mask
```

To load it in every session, set `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.
Use an absolute path; separate several directories with `:`, or with `;` on Windows:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "D:/tools/privacy-mask"
  }
}
```

Check that it loaded: run `/plugin` and look for `privacy-mask` in the `mods active` line,
then run `/privacy-mask`.

## Configure

The mod reads two optional files and merges them:

| File | Use it for |
|---|---|
| `~/.claude/privacy-mask.json` | Rules for every project: your name, email, internal domains |
| `<project>/.claude/privacy-mask.json` | Rules for one project: a client name, target hosts |

On Windows, `~` is `%USERPROFILE%`. With no file at all, the mod does nothing and says so
once at startup.

```json
{
  "terms": {
    "Acme Corp": "Contoso",
    "jdoe": "user1"
  },
  "regex": [
    { "name": "EMAIL", "pattern": "[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+" },
    { "name": "IP", "pattern": "\\b\\d{1,3}(\\.\\d{1,3}){3}\\b" },
    { "name": "HOST", "pattern": "[a-z0-9-]+\\.corp\\.example\\.com", "flags": "i" }
  ]
}
```

- **`terms`**: exact, case-sensitive text and the text to show the model instead. When terms
  overlap, the longest one wins.
- **`regex`**: each match becomes a placeholder `NAME_` plus 10 hex characters, for example
  `IP_d6da262530`. `name` must match `^[A-Z][A-Z0-9_]*$`. `flags` is optional, and `g` is
  always added. Remember to escape backslashes in JSON (`\\d`).
- **Merging**: on the same term or rule name, the project file wins. Global rules run first,
  then project-only rules, in file order.

The config is rejected when:

- the JSON or a regex is invalid;
- two terms share a replacement;
- a replacement contains a term's original, or an original contains a replacement.

While the config is rejected, the mod blocks every prompt, so nothing leaks while it is
broken. Fix the file, then run `/reload-plugins`.

Choose replacements that never appear in your real data. A real `Contoso` in your files
would be shown to you as `Acme Corp`.

## Use

Work as usual. To check the mod's state, run:

```
/privacy-mask
```

```
mode: active
config files: global, project
terms: 2
regex rules: 3
reverse table entries: 14
```

| Mode | Meaning |
|---|---|
| `active` | Masking is on |
| `pass-through` | No config file was found; nothing is masked |
| `blocked` | The config is invalid; prompts are not sent. The error is shown below. |

The mod reads its config when it loads. After you edit a config file, run `/reload-plugins`
or start a new session.

## What it covers

Masked before the model reads it:

- your prompts, including prompts typed while Claude is working
- tool results (Read, Bash, Grep, MCP tools, ...)
- the system prompt, `CLAUDE.md` and other context, reminders, and `@`-mentioned files
- skill prompts and tool descriptions
- every conversation row as it is stored, which is what later requests carry

Restored for you and your tools:

- Claude's replies, your messages, tool calls and their results, and question dialogs on
  screen
- tool arguments before the tool runs, so `Edit`, `Write` and `Bash` work on the real
  values. `WebSearch` queries and the `WebFetch` prompt stay masked, because they are sent
  to a model; the `WebFetch` URL is restored.

Placeholders depend only on your config and a local secret, so the same value always
masks the same way. Requests stay byte-identical across turns and sessions, and the
prompt cache keeps working.

## Where data is kept

The mod keeps two things in Claude Code's plugin store (`$.store`), on your machine only:

- `privacy-mask:secret`: a random key, created on first use, that makes placeholders
  impossible to reverse without it. A plain hash of an IP address could be brute-forced.
- `privacy-mask:reverse:<project path>`: the placeholder-to-original table, used to show
  you the originals.

If the reverse table cannot be saved (the store is capped at 4 MiB), masking keeps working
and the mod shows one notice; older placeholders may then show unresolved in later sessions.

## Limitations

- **Local transcript files.** Claude Code writes some rows of the session `.jsonl` before
  any mod can act. They stay on your machine and are never sent to the model:
  - queue bookkeeping rows hold the raw prompt for every prompt in `claude -p` / SDK
    sessions, and for prompts typed while Claude is working;
  - attachment rows keep the raw payload, such as an `@`-mentioned file's content.
- **Auto permission mode.** The permission classifier is a model call the mod cannot hook,
  and it sees tool arguments after they are restored.
- **No on-screen restoring** in `claude -p`, the Agent SDK, or the VS Code chat panel. There
  you see placeholders.
- **Images and other binary content** are not masked.
- **Errored tool calls** are shown as refused, and their error text may show placeholders.
- **Literal look-alikes.** Text that already equals a replacement or an issued placeholder
  is shown to you as the original.

## Troubleshooting

- **`/privacy-mask` is sent to Claude as a message from Git Bash** (`claude -p "/privacy-mask"`):
  Git Bash rewrites `/word` into a Windows path. Prefix the command with `MSYS_NO_PATHCONV=1`.
- **Nothing is masked**: run `/privacy-mask`. `pass-through` means no config file was found;
  check the file path and name.
- **Every prompt is blocked**: `/privacy-mask` shows the config error. Fix the file and run
  `/reload-plugins`.
- **The mod does not load**: check `claude --version`, and run
  `claude plugin validate /path/to/privacy-mask`.

## Development

```bash
cd privacy-mask
claude plugin test                      # 63 tests, no session or network needed
claude plugin validate .                # static checks and the list of hooks
claude --plugin-dir .                   # hot-reloads on save
```

| File | Purpose |
|---|---|
| `hooks/register.js` | All hooks and every mods API call |
| `hooks/masker.js` | Deterministic mask and unmask |
| `hooks/config.js` | Config parsing, merging and validation |
| `hooks/hmac.js` | SHA-256 and HMAC-SHA256 in plain JS (the mods runtime has no usable `crypto.subtle`) |

Design and decisions: `docs/superpowers/specs/2026-10-03-privacy-mask-design.md` in the
repository.
