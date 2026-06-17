/**
 * Cache prefix stability module.
 *
 * DeepSeek (and OpenAI-compatible providers) cache prompts on exact byte prefix.
 * Three common things destroy the prefix, killing the cache and multiplying
 * input token costs by ~120x:
 *
 * 1. Timestamps in the system prompt — change every turn, cache hit: 0%
 * 2. Re-sending reasoning_content — DeepSeek docs say not to; bloats context
 * 3. Non-deterministic tool serialization — different order breaks prefix
 *
 * This module hooks three events:
 * - `context`: strip reasoning_content from assistant messages before LLM call
 * - `before_provider_request`: sort tool schemas in the outbound payload
 * - `before_agent_start`: remove dynamic timestamps from the system prompt
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "./types.js";
import { matchesModelPattern } from "./utils.js";

/** Track cache-related stats for the /harness-cache command. */
export interface CacheStats {
	/** Number of context events where reasoning_content was stripped. */
	reasoningStripped: number;
	/** Number of request payloads where tools were sorted. */
	toolsSorted: number;
	/** Number of system prompts where timestamps were stripped. */
	timestampsStripped: number;
	/** Total context events seen. */
	contextEvents: number;
	/** Total provider requests seen. */
	providerRequests: number;
}

/** Regex to match common timestamp/date patterns in system prompts. */
export const TIMESTAMP_RE =
	/(?:Current (?:date|time)(?:\s+is)?[:\s]\s*.*|Today(?:\s+is)?[:\s]\s*.*|Date[:\s]\s*\d{4}-\d{2}-\d{2}.*|Time[:\s]\s*\d{2}:\d{2}(?::\d{2})?.*)$/gim;

/**
 * Register cache prefix stability hooks.
 *
 * @returns CacheStats object (mutable) for display by commands.
 */
export function registerCacheHooks(
	pi: ExtensionAPI,
	config: HarnessConfig["cache"],
	patterns: string[],
): CacheStats {
	const stats: CacheStats = {
		reasoningStripped: 0,
		toolsSorted: 0,
		timestampsStripped: 0,
		contextEvents: 0,
		providerRequests: 0,
	};

	if (!config.enabled) return stats;

	// ── Hook 1: Strip reasoning_content from messages ──────────────────
	//
	// The `context` event fires before each LLM call with the full messages
	// array. We walk assistant messages and delete reasoning_content fields.
	// This both protects the cache prefix and prevents context bloat from
	// accumulated thinking tokens.
	if (config.stripReasoning) {
		pi.on("context", async (event, ctx: ExtensionContext) => {
			if (!matchesModelPattern(ctx.model, patterns)) return;
			stats.contextEvents++;
			let stripped = 0;
			for (const msg of event.messages) {
				// Assistant messages may carry reasoning_content (DeepSeek) or
				// reasoning (some providers) or thinking blocks (Anthropic).
				const anyMsg = msg as unknown as Record<string, unknown>;
				const role = anyMsg.role;
				if (role === "assistant" || role === "tool") {
					if ("reasoning_content" in anyMsg) {
						delete anyMsg.reasoning_content;
						stripped++;
					}
					if ("reasoning" in anyMsg) {
						delete anyMsg.reasoning;
						stripped++;
					}
					// Some providers nest reasoning under content arrays as
					// { type: "thinking", thinking: "..." } blocks.
					if (Array.isArray(anyMsg.content)) {
						anyMsg.content = (anyMsg.content as unknown[]).filter((block) => {
							const b = block as Record<string, unknown> | undefined;
							return b?.type !== "thinking" && b?.type !== "reasoning";
						});
					}
				}
			}
			if (stripped > 0) stats.reasoningStripped += stripped;
		});
	}

	// ── Hook 2: Sort tool schemas in the outbound request ──────────────
	//
	// The `before_provider_request` event fires with the full payload before
	// it's sent to the API. We sort the tools array deterministically by name
	// so the serialized tool schema prefix is byte-identical across requests.
	if (config.sortTools) {
		pi.on("before_provider_request", async (event, ctx: ExtensionContext) => {
			if (!matchesModelPattern(ctx.model, patterns)) return;
			stats.providerRequests++;
			const payload = event.payload as Record<string, unknown> | undefined;
			if (!payload || !Array.isArray(payload.tools)) return;

			// Sort by function.name (OpenAI format) or name (direct format).
			const tools = payload.tools as unknown[];
			tools.sort((a, b) => {
				const ta = a as Record<string, unknown> | undefined;
				const tb = b as Record<string, unknown> | undefined;
				const fnA = ta?.function as Record<string, unknown> | undefined;
				const fnB = tb?.function as Record<string, unknown> | undefined;
				const nameA = (fnA?.name as string) ?? (ta?.name as string) ?? "";
				const nameB = (fnB?.name as string) ?? (tb?.name as string) ?? "";
				return nameA.localeCompare(nameB);
			});

			stats.toolsSorted++;
		});
	}

	// ── Hook 3: Strip timestamps from the system prompt ─────────────────
	//
	// The `before_agent_start` event fires after the user submits a prompt
	// but before the agent loop begins. We can replace the system prompt.
	// We strip any lines that look like timestamps/dates to keep the prefix
	// byte-stable across turns.
	if (config.stripTimestamps) {
		pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
			if (!matchesModelPattern(ctx.model, patterns)) return;
			const prompt = event.systemPrompt;
			if (!TIMESTAMP_RE.test(prompt)) return;

			// Reset lastIndex (global flag) and strip
			TIMESTAMP_RE.lastIndex = 0;
			const cleaned = prompt
				.replace(TIMESTAMP_RE, "")
				.replace(/\n{3,}/g, "\n\n");
			stats.timestampsStripped++;

			return { systemPrompt: cleaned };
		});
	}

	return stats;
}

/**
 * Pure function: strip timestamp/date patterns from a system prompt.
 * Extracted from the before_agent_start hook for testing.
 */
export function stripTimestampsFromPrompt(prompt: string): string {
	if (!TIMESTAMP_RE.test(prompt)) return prompt;
	TIMESTAMP_RE.lastIndex = 0;
	return prompt.replace(TIMESTAMP_RE, "").replace(/\n{3,}/g, "\n\n");
}
