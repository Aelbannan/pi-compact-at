/**
 * compact-at — set a per-model auto-compaction threshold.
 *
 * Writes pi's native `compaction.modelOverrides["provider/modelId"]` in the
 * global settings.json, translating "compact at X tokens" into
 * `reserveTokens = contextWindow - X`. Pi core then uses it for automatic
 * threshold checks, overflow recovery and /compact (works with pi-vcc, which
 * only replaces the summarizer, not the trigger).
 *
 *   /compact-at                 show current model's threshold
 *   /compact-at 200k            compact at 200K tokens
 *   /compact-at 60%             compact at 60% of the context window
 *   /compact-at 200k keep=30k   also set keepRecentTokens for this model
 *   /compact-at clear           remove this model's override
 *   /compact-at list            list all overrides
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "compact-at";

type Override = { reserveTokens?: number; keepRecentTokens?: number };

const settingsPath = () => join(getAgentDir(), "settings.json");

function fmt(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Parse "200k", "1.5m", "150000", "150_000". Returns null if invalid. */
function parseTokens(s: string): number | null {
	const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(s.replace(/[_,]/g, ""));
	if (!m) return null;
	const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1_000 : 1;
	const n = Math.round(parseFloat(m[1]) * mult);
	return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Simple mkdir-based lock compatible with proper-lockfile (used by pi). */
function withSettingsLock<T>(fn: () => T): T {
	const lock = `${settingsPath()}.lock`;
	for (let i = 0; ; i++) {
		try {
			mkdirSync(lock);
			break;
		} catch (e: any) {
			if (e?.code !== "EEXIST") throw e;
			try {
				if (Date.now() - statSync(lock).mtimeMs > 10_000) {
					rmdirSync(lock); // stale
					continue;
				}
			} catch {}
			if (i >= 50) throw new Error("settings.json is locked; try again");
			const until = Date.now() + 20;
			while (Date.now() < until) {}
		}
	}
	try {
		return fn();
	} finally {
		try {
			rmdirSync(lock);
		} catch {}
	}
}

function updateOverrides(mutate: (overrides: Record<string, Override>) => void) {
	withSettingsLock(() => {
		const path = settingsPath();
		const raw = existsSync(path) ? readFileSync(path, "utf-8").replace(/^\uFEFF/, "") : "{}";
		const settings = JSON.parse(raw || "{}");
		settings.compaction ??= {};
		settings.compaction.modelOverrides ??= {};
		mutate(settings.compaction.modelOverrides);
		if (Object.keys(settings.compaction.modelOverrides).length === 0) delete settings.compaction.modelOverrides;
		const tmp = `${path}.compact-at.tmp`;
		writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
		renameSync(tmp, path);
	});
}

function readOverrides(): Record<string, Override> {
	try {
		const s = JSON.parse(readFileSync(settingsPath(), "utf-8").replace(/^\uFEFF/, ""));
		return s?.compaction?.modelOverrides ?? {};
	} catch {
		return {};
	}
}

const modelKey = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

export default function (pi: ExtensionAPI) {
	/** Threshold currently in effect for the active model (from live, loaded settings). */
	function effective(ctx: ExtensionContext) {
		const key = modelKey(ctx);
		if (!key || !ctx.model) return undefined;
		const c = (pi.getSettings() as any).compaction ?? {};
		const o: Override | undefined = c.modelOverrides?.[key];
		const reserve = o?.reserveTokens ?? c.reserveTokens ?? 16384;
		const keep = o?.keepRecentTokens ?? c.keepRecentTokens ?? 20000;
		const window = ctx.model.contextWindow;
		return { key, window, reserve, keep, threshold: Math.max(0, window - reserve), hasOverride: !!o };
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const e = effective(ctx);
		ctx.ui.setStatus(STATUS_KEY, e?.hasOverride ? `compact@${fmt(e.threshold)}` : undefined);
	}

	pi.on("session_start", (_e, ctx) => updateStatus(ctx));
	pi.on("model_select", (_e, ctx) => updateStatus(ctx));

	/**
	 * Compaction can only summarize conversation messages older than the last
	 * `keepRecentTokens`; the system prompt and tool definitions are never
	 * reduced. Warn when the threshold can't realistically do anything.
	 */
	function sanityWarning(ctx: ExtensionContext, threshold: number, keep: number): string | undefined {
		const notes: string[] = [];
		const baseline = ctx.getContextUsage()?.tokens;
		if (baseline != null && baseline >= threshold) {
			notes.push(
				`current context (${fmt(baseline)}) is already above the threshold; system prompt + tools can't be compacted, so it will retrigger every turn`,
			);
		}
		if (keep >= threshold) {
			notes.push(
				`keepRecentTokens (${fmt(keep)}) ≥ threshold: the last ${fmt(keep)} tokens of conversation are never summarized, so there's often nothing to compact (use keep=<n>)`,
			);
		}
		return notes.length ? `compact-at: ${notes.join("; ")}` : undefined;
	}

	async function apply(ctx: any, msg: string) {
		if (ctx.isIdle()) {
			ctx.ui.notify(`${msg} — reloading`, "info");
			await ctx.reload();
			return;
		}
		ctx.ui.notify(`${msg} — saved; run /reload to apply`, "warning");
	}

	pi.registerCommand("compact-at", {
		description: "Set auto-compaction threshold for the current model (e.g. 200k, 60%, clear, list)",
		getArgumentCompletions: (prefix) => {
			const opts = ["clear", "list", "50%", "60%", "75%", "100k", "200k", "keep="];
			const items = opts.filter((o) => o.startsWith(prefix.trim())).map((o) => ({ value: o, label: o }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const key = modelKey(ctx);

			if (parts[0] === "list") {
				const all = readOverrides();
				const lines = Object.entries(all).map(([k, o]) => {
					const m = ctx.modelRegistry.find(k.slice(0, k.indexOf("/")), k.slice(k.indexOf("/") + 1));
					const at = m && o.reserveTokens !== undefined ? `compact@${fmt(m.contextWindow - o.reserveTokens)}` : "";
					const bits = [at, o.reserveTokens !== undefined ? `reserve=${fmt(o.reserveTokens)}` : "", o.keepRecentTokens !== undefined ? `keep=${fmt(o.keepRecentTokens)}` : ""];
					return `${k}: ${bits.filter(Boolean).join(" ")}`;
				});
				ctx.ui.notify(lines.length ? lines.join("\n") : "No per-model compaction overrides", "info");
				return;
			}

			if (!key || !ctx.model) {
				ctx.ui.notify("No active model", "error");
				return;
			}

			if (parts.length === 0) {
				const e = effective(ctx)!;
				ctx.ui.notify(
					`${e.key}: compact@${fmt(e.threshold)} / ${fmt(e.window)} (${Math.round((e.threshold / e.window) * 100)}%), keep=${fmt(e.keep)}${e.hasOverride ? "" : " [defaults]"}`,
					"info",
				);
				const warning = sanityWarning(ctx, e.threshold, e.keep);
				if (warning) ctx.ui.notify(warning, "warning");
				return;
			}

			if (parts[0] === "clear") {
				if (!readOverrides()[key]) {
					ctx.ui.notify(`No override for ${key}`, "info");
					return;
				}
				updateOverrides((o) => delete o[key]);
				await apply(ctx, `Cleared compaction override for ${key}`);
				return;
			}

			const window = ctx.model.contextWindow;
			let threshold: number | undefined;
			let keep: number | undefined;
			for (const p of parts) {
				if (p.toLowerCase().startsWith("keep=")) {
					const k = parseTokens(p.slice(5));
					if (k === null) return ctx.ui.notify(`Invalid keep value: ${p}`, "error");
					keep = k;
				} else if (p.endsWith("%")) {
					const pct = parseFloat(p);
					if (!(pct > 0 && pct < 100)) return ctx.ui.notify(`Percentage must be between 0 and 100: ${p}`, "error");
					threshold = Math.round((window * pct) / 100);
				} else {
					const t = parseTokens(p);
					if (t === null) return ctx.ui.notify(`Invalid value: ${p} (try 200k, 60%, clear, list)`, "error");
					threshold = t;
				}
			}
			if (threshold !== undefined && (threshold <= 0 || threshold >= window)) {
				return ctx.ui.notify(`Threshold must be between 0 and the context window (${fmt(window)})`, "error");
			}
			if (threshold === undefined && keep === undefined) return;

			updateOverrides((o) => {
				const cur = { ...(o[key] ?? {}) };
				if (threshold !== undefined) cur.reserveTokens = window - threshold;
				if (keep !== undefined) cur.keepRecentTokens = keep;
				o[key] = cur;
			});
			const desc = [
				threshold !== undefined ? `compact@${fmt(threshold)} of ${fmt(window)}` : "",
				keep !== undefined ? `keep=${fmt(keep)}` : "",
			].filter(Boolean).join(", ");
			const warning = sanityWarning(ctx, threshold ?? effective(ctx)!.threshold, keep ?? effective(ctx)!.keep);
			if (warning) ctx.ui.notify(warning, "warning");
			await apply(ctx, `${key}: ${desc}`);
		},
	});
}
