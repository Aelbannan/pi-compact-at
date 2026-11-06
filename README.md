# pi-compact-at

Set an auto-compaction threshold per model in [pi](https://pi.dev), as an absolute token count or a percentage of the model's context window.

## Install

```bash
pi install git:github.com/Aelbannan/pi-compact-at
```

## Usage

```
/compact-at                  show threshold for the current model
/compact-at 200k             compact at 200K tokens
/compact-at 60%              compact at 60% of the context window
/compact-at 200k keep=30k    also set keepRecentTokens for this model
/compact-at clear            remove the current model's override
/compact-at list             list all overrides
```

The footer shows `compact@200K` for models with an override.

## How it works

It writes pi's native `compaction.modelOverrides["provider/modelId"]` in `~/.pi/agent/settings.json`, converting "compact at X" into `reserveTokens = contextWindow - X`. Pi core then uses it for threshold checks, overflow recovery and `/compact`. Because pi caches settings, the command runs `/reload` after saving (or asks you to, if the agent is busy).

## Compatibility

- **pi-vcc**: works. vcc replaces the summarizer, not the trigger. `keep=` has little effect since vcc uses its own `smartKeepTail`.
- **pi-blackhole**: in its default `auto` mode it uses its own trigger (`compactAfterTokens` / preset curve), so this threshold only acts as a backstop. Set `compactionEngine: "pi-default"` to let pi's trigger govern.

## Choosing a threshold

Compaction only summarizes conversation messages older than the last `keepRecentTokens` (default 20K). The system prompt and tool definitions are never reduced. So the threshold must be comfortably above *baseline context (system prompt + tools) + keepRecentTokens*, otherwise pi has nothing to summarize and silently skips. Check your baseline in a fresh session; `/compact-at` warns when the threshold is too low.
