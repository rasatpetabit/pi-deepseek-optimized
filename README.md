# pi-deepseek-optimized

Five harness techniques that close the quality gap between DeepSeek V4 Pro and Claude, implemented for the [pi coding harness](https://pi.dev).

DeepSeek V4 Pro costs roughly 5–7× less than Claude Sonnet but scores ~80–90% of Claude's quality on coding tasks. The harness closes the remaining gap by fixing the failure modes that drag DeepSeek down — not by making the model smarter, but by making the environment around it smarter.

**This is a direct implementation of the techniques described in Howard Chen's post: [DeepSeek V4 Pro at 5% the cost of Claude — what actually works](https://howardchen.substack.com/p/deepseek-v4-pro-at-5-the-cost-of).** The post describes `cwcode`, a Go-based terminal harness the author uses as a daily-driver coding tool with DeepSeek V4 Pro. The five techniques below are the ones the post identifies as the highest-leverage improvements. All credit for the underlying ideas belongs to the original author; this package is a TypeScript reimplementation for the pi coding harness.

## How to Install

```bash
pi install git:github.com/jrimmer/pi-deepseek-optimized
```

Then reload with `/reload` and verify with `/deepseek-optimized`.

## Benchmarks

Simulated against the exact failure modes each module targets. Run them with `npx vitest run tests/benchmarks.test.ts`.

### 1. Hash-Line Editing (12 tests)

**Claim:** ~50% fewer retries, 30-40% lower output tokens

| Benchmark                                   | Result                                                     |
|---------------------------------------------|------------------------------------------------------------|
| First-attempt success rate (old edit tool)  | <70% — model whitespace/staleness errors cause frequent failures |
| First-attempt success rate (new edit_lines)  | >95% — hash verification catches mismatches immediately           |
| Staleness detection                         | Catches changed files with precise hash mismatch error            |
| Retry reduction                             | Meaningful reduction — old approach needs extra re-read roundtrips |
| Token savings                               | >15% less output tokens — no old_string reproduction needed       |
| Collision rate (50-line file)               | 0–5 collisions — perfectly safe for typical edits                 |
| Adjacent-line collisions (10,000 lines)     | <1% — dual-hash (from+to) makes false-pass near impossible        |

### 2. Cache Prefix Stability (11 tests)

**Claim:** 85%+ cache hit ratio after turn 3-4

| Benchmark                            | Result                                     |
|--------------------------------------|--------------------------------------------|
| Prompt stability WITHOUT stripping   | 0% — every turn changes the prefix         |
| Prompt stability WITH stripping      | 100% — byte-identical across all turns     |
| Hit ratio projection (50 turns)      | 94% (47/50 hits after 3 warm-up turns)     |
| Cost projection WITHOUT stability    | ~$96.00 — 50 × 16K tokens × $0.12/1K       |
| Cost projection WITH stability       | ~$6.51 — 3 misses + 47 hits                |
| Cache miss/hit cost ratio            | 120x — confirms README's spread            |

## The five modules

| # | Module | Default | Active when | What it does |
|---|---|---|---|---|
| 1 | **Cache prefix stability** | ON | DeepSeek only | Strips `reasoning_content`, sorts tool schemas, removes timestamps to maximize prompt cache hit ratio |
| 2 | **Storm-breaker** | ON | Always | Enhances tool error messages and breaks consecutive-failure loops |
| 3 | **Hashline editing** | ON | DeepSeek only | Hash-annotates read output and provides a hash-verified `edit_lines` tool |
| 4 | **Plan mode** | ON | Always | Restricts the agent to read-only tools for planning |
| 5 | **Rewind** | **OFF** | Always | Git-stash-based file snapshots restorable via `/rewind N` |

**Always-active modules** (storm-breaker, plan mode) are model-agnostic — they work with any model. **Model-gated modules** (cache, hashlines) only activate when the active model matches `PI_HARNESS_MODEL_PATTERN` (default: `deepseek`). When you switch to Claude or GPT, the gated modules go dormant automatically and the footer indicator disappears.

## Footer indicator

When a DeepSeek-like model is active and at least one gated module is enabled, the footer shows `⚡Optimized`.

## Module 1: Cache prefix stability

**Theory.** DeepSeek (and OpenAI-compatible providers) cache prompts on exact byte prefix. Three common things destroy the prefix, killing the cache and multiplying input token costs by ~120× (the price spread between cache hit and cache miss):

1. **Timestamps in the system prompt** — change every turn, cache hit ratio: 0%.
2. **Re-sending `reasoning_content`** — DeepSeek's docs say not to; it also bloats context with accumulated thinking tokens.
3. **Non-deterministic tool serialization** — Go map iteration order (or any non-stable sort) produces a different tool schema byte order on each request, breaking the prefix.

The post reports an 85%+ cache hit ratio after turn 3–4 with these fixes applied. A 4-hour autonomous loop doing 50 turns costs $0.40–$0.80 with cache stability, versus ~$96 without.

**Practice.** Three event hooks:

- `context` event — strips `reasoning_content`, `reasoning`, and `thinking`-type content blocks from assistant/tool messages before each LLM call. This both protects the cache prefix and prevents context bloat.
- `before_provider_request` — sorts the `tools[]` array in the outbound payload by `function.name` (OpenAI format) or `name` (direct format), so the serialized tool schema prefix is byte-identical across requests.
- `before_agent_start` — strips lines matching common timestamp/date patterns (`Current date/time is:`, `Today is:`, `Date: YYYY-MM-DD`, `Time: HH:MM:SS`) from the system prompt.

**Note:** DeepSeek's prompt cache has a time-to-live (~1 hour). Long gaps between turns (lunch breaks, context switching) may expire the cache regardless of prefix stability. The 85%+ hit ratio is achievable within active sessions, not across long pauses.

## Module 2: Storm-breaker

**Theory.** When a model hits repeated identical tool failures, silently aborting with a red error is the worst option — the model has no idea what went wrong and will retry the same thing. Two fixes:

1. **Make tool errors actually useful** — replace cryptic messages with actionable diagnostics. `open : no such file` → `the 'path' argument is empty or missing`. Permission errors get readability hints. Edit partial-match errors get re-read suggestions with whitespace/staleness explanation.
2. **Synthesized failure responses** — after N consecutive identical failures (deduped by error signature), inject an assistant-role message explaining what went wrong in coherent language. The model "owns" the failure and the conversation continues naturally when the user clarifies.

The post calls this the "storm-breaker" and notes that most former storm-breaker triggers self-resolve because the model gets enough information from the enhanced errors to fix its own call.

**Practice.** Two event hooks:

- `tool_result` — intercepts tool results, extracts error text, and replaces it with enhanced diagnostics using pattern matching (empty path, permission denied, edit not-found, offset out-of-bounds).
- `tool_execution_end` — tracks consecutive identical failures via error signature deduplication (paths, line numbers, and timestamps normalized). After the threshold (default 3), calls `ctx.abort()` and injects a synthesized message via `pi.sendMessage()` with `customType: "harness_stormbreaker"`.

## Module 3: Hashline editing

**Theory.** The built-in `edit` tool requires the model to character-perfectly reproduce `oldText` to match it. This is the single biggest source of edit failures. The hashline technique (based on Can Akay's ["harness problem" post](https://blog.can.ac/2026/02/12/the-harness-problem/)) annotates every line in read output with a 3-character content hash, then provides an `edit_lines` tool that edits by line range with endpoint hash verification.

The post reports that this technique alone yielded roughly half the retries per task and 30–40% lower output tokens per session with V4 Pro. Akay showed Grok Code Fast jumping from 6.7% to 68.3% on SWE-bench Verified and 61% fewer output tokens just from the hashline format change.

**Practice.** Two parts:

1. `tool_result` hook for the `read` tool — post-processes text content to inject `N:HHH→content` format (FNV-1a 3-char hex hash per line, trailing-whitespace-trimmed). The user sees clean file content in the TUI; only the model sees hash-annotated lines.
2. New `edit_lines` tool — takes `{ path, edits: [{ from, from_hash, to, to_hash, new_text }] }`. Reads the file fresh, recomputes hashes, verifies endpoint hashes match, rejects the entire batch on any mismatch with a precise error (actual hash + line content). Applies edits in reverse order (sorted by `to` descending) to preserve line numbers. The built-in `edit` tool remains available as fallback.

## Module 4: Plan mode

**Theory.** Sometimes you want the model to produce a plan before making changes. Plan mode restricts the agent to read-only tools so it can only investigate and plan, not modify. The post describes this as a safety feature: the agent gets a smaller tool registry and a system prompt addendum instructing it to produce a numbered plan.

**Practice.**

- `ctrl+shift+p` (or `/deepseek-optimized-plan`) saves the current active tool set via `pi.getActiveTools()`, then calls `pi.setActiveTools(["read", "grep", "find", "ls"])` to restrict to read-only.
- The `before_agent_start` hook appends a "PLAN MODE ACTIVE" directive to the system prompt instructing the model to produce a numbered plan.
- Toggling again restores the saved tool set.

## Module 5: Rewind (off by default)

**Theory.** The post describes a content-addressed blob store that SHA-256-keys file snapshots before mutation. This implementation uses a simpler git-stash-based approach: before each turn, create a git stash snapshot (without modifying the working tree). On `/rewind N`, restore the working tree from the saved snapshot.

**Why it's off by default.** Rewind adds per-turn git operations (`git stash create --include-untracked`) which is unnecessary overhead if you don't need it. Enable it explicitly with `PI_HARNESS_REWIND_ENABLED=1`.

**Practice.**

- `turn_start` hook — runs `git stash create --include-untracked` to create a dangling commit snapshot (doesn't modify the working tree). Stores the stash ref + turn info.
- `/rewind N` command — creates a safety-net stash of current state, cleans the working tree (`git checkout -- . && git clean -fd`), applies the saved stash ref, and notifies the user.
- `/rewind` without N — lists available checkpoints.
- Only activates inside git repositories (checked on `session_start`).

## Commands

- `/deepseek-optimized` — show status: all module states, stats, and configuration
- `/deepseek-optimized-plan` — toggle plan mode on/off
- `/rewind N` — restore files to before turn N (0-based). Without N, lists checkpoints.

## Configuration

All settings are controlled via `PI_HARNESS_*` environment variables. Every module has an independent enable flag.

| Variable | Default | Description |
| --- | ---: | --- |
| `PI_HARNESS_ENABLED` | `true` | Master switch. When false, no hooks fire and no tools are registered. |
| `PI_HARNESS_MODEL_PATTERN` | `deepseek` | Comma-separated patterns. Cache and hashline modules only activate when the active model's provider, id, or name matches (case-insensitive substring). Storm-breaker and plan mode are always on. |
| `PI_HARNESS_CACHE_ENABLED` | `true` | Enable cache prefix stability module. |
| `PI_HARNESS_CACHE_STRIP_REASONING` | `true` | Strip `reasoning_content` from messages before each LLM call. |
| `PI_HARNESS_CACHE_SORT_TOOLS` | `true` | Sort tool schemas deterministically in the outbound request. |
| `PI_HARNESS_CACHE_STRIP_TIMESTAMPS` | `true` | Remove dynamic timestamps/dates from the system prompt. |
| `PI_HARNESS_HASHLINES_ENABLED` | `true` | Enable hashline editing (read annotation + `edit_lines` tool). |
| `PI_HARNESS_STORMBREAKER_ENABLED` | `true` | Enable storm-breaker (error enhancement + failure loop breaking). |
| `PI_HARNESS_STORMBREAKER_THRESHOLD` | `3` | Consecutive identical failures before breaking the loop. |
| `PI_HARNESS_PLANMODE_ENABLED` | `true` | Enable plan mode. |
| `PI_HARNESS_PLANMODE_SHORTCUT` | `ctrl+shift+p` | Toggle shortcut. Set to `off`/`none`/`disabled` to disable. |
| `PI_HARNESS_PLANMODE_READONLY_TOOLS` | `read,grep,find,ls` | Tools available in plan mode. |
| `PI_HARNESS_REWIND_ENABLED` | `false` | Enable rewind. Off by default — adds per-turn git operations. |
| `PI_HARNESS_REWIND_STRATEGY` | `git` | Snapshot strategy. Only `git` is supported. |

Example:

```bash
PI_HARNESS_MODEL_PATTERN=deepseek,kimi PI_HARNESS_REWIND_ENABLED=1 pi
```

## Model gating

Cache prefix stability and hashline editing are DeepSeek-specific optimizations. Storm-breaker and plan mode are model-agnostic and useful with any model.

The `matchesModelPattern` function does a case-insensitive substring match against the model's `provider`, `id`, and `name`. This catches DeepSeek whether it's the native provider (`provider: "deepseek"`), routed through OpenRouter (`id: "deepseek-v4-pro"`), or proxied (`name: "DeepSeek V4 Pro (proxy)"`).

| Model active | Cache | Hashlines | Storm-breaker | Plan mode | Footer |
|---|---|---|---|---|---|
| DeepSeek V4 Pro | ✅ | ✅ | ✅ | ✅ | `⚡Optimized` |
| Claude Sonnet | inactive | inactive | ✅ | ✅ | (hidden) |
| Kimi (if pattern includes `kimi`) | ✅ | ✅ | ✅ | ✅ | `⚡Optimized` |

## Project structure

```
extensions/
  harness.ts                ← entry point (registers all modules + footer + commands)
  harness/
    types.ts                ← shared types (HarnessConfig, CheckpointEntry, FailureRecord, HashEdit)
    config.ts               ← env var parsing (PI_HARNESS_*)
    utils.ts                ← FNV-1a line hashing, content annotation, error enhancement, model matching
    cache.ts                ← cache prefix stability (3 hooks)
    stormbreaker.ts         ← synthesized failure responses (2 hooks)
    hashlines.ts            ← hashline editing (1 hook + edit_lines tool)
    planmode.ts             ← plan mode (1 shortcut + 1 hook)
    rewind.ts               ← git-stash rewind (1 hook + /rewind command)
tests/
  harness.test.ts           ← unit tests (86 tests)
  benchmarks.test.ts        ← benchmark suite (23 tests, 109 total)
```

## Development

```bash
npm install --ignore-scripts
npm run verify
```

`npm run verify` runs TypeScript checks, unit tests, and `npm pack --dry-run` to confirm package contents.

### Running benchmarks

```bash
npx vitest run tests/benchmarks.test.ts --reporter=verbose
```

All 23 benchmarks print structured results to stdout. Pass `--reporter=verbose` to see the full per-test output including cost projections and collision rates.

## Credits

The harness techniques are from Howard Chen's post: [DeepSeek V4 Pro at 5% the cost of Claude — what actually works](https://howardchen.substack.com/p/deepseek-v4-pro-at-5-the-cost-of). The hashline editing technique is based on Can Akay's [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/). All credit for the underlying ideas belongs to the original authors; this package is a TypeScript reimplementation for the pi coding harness.
