/**
 * Plan mode module.
 *
 * Restricts the agent to read-only tools so it produces a plan instead of
 * making changes. Toggled via a keyboard shortcut (default: ctrl+shift+p).
 *
 * When plan mode is active:
 * - The active tool set is reduced to the configured read-only tools
 * - The system prompt gets an addendum telling the model to produce a plan
 * - A status indicator is shown in the footer
 *
 * The previous tool set is saved and restored when plan mode is exited.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { HarnessConfig } from "./types.js";

/** Plan mode runtime state. */
export interface PlanModeState {
	/** Whether plan mode is currently active. */
	active: boolean;
	/** The tool set that was active before entering plan mode. */
	savedTools: string[] | null;
	/** Number of times plan mode was toggled. */
	toggleCount: number;
}

/**
 * Register plan mode: shortcut + system prompt hook.
 *
 * @returns PlanModeState (mutable) for display and external control.
 */
export function registerPlanMode(
	pi: ExtensionAPI,
	config: HarnessConfig["planmode"],
): PlanModeState {
	const state: PlanModeState = {
		active: false,
		savedTools: null,
		toggleCount: 0,
	};

	if (!config.enabled) return state;

	/** Toggle plan mode on/off. Called from shortcut handler and /deepseek-optimized-plan command. */
	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (state.active) {
			// Exit plan mode — restore saved tools.
			if (state.savedTools) {
				pi.setActiveTools(state.savedTools);
			}
			state.active = false;
			state.savedTools = null;
			ctx.ui.setStatus("planmode", undefined);
			ctx.ui.notify("Plan mode OFF — full tool set restored", "info");
		} else {
			// Enter plan mode — save current tools, switch to read-only.
			state.savedTools = pi.getActiveTools();
			pi.setActiveTools(config.readonlyTools);
			state.active = true;
			ctx.ui.setStatus("planmode", "📋 PLAN MODE");
			ctx.ui.notify(
				`Plan mode ON — read-only tools: ${config.readonlyTools.join(", ")}`,
				"info",
			);
		}
		state.toggleCount++;
	}

	// Register the keyboard shortcut.
	if (config.shortcut) {
		pi.registerShortcut(config.shortcut as KeyId, {
			description: "Toggle plan mode (restrict to read-only tools)",
			handler: async (ctx) => void toggle(ctx),
		});
	}

	// ── System prompt modification in plan mode ─────────────────────────
	//
	// When plan mode is active, append a directive to the system prompt
	// telling the model to produce a numbered plan instead of edits.
	pi.on(
		"before_agent_start",
		async (
			_event: BeforeAgentStartEvent,
		): Promise<BeforeAgentStartEventResult | void> => {
			if (!state.active) return;

			const planDirective = [
				"",
				"## PLAN MODE ACTIVE",
				"",
				"You are in Plan mode. You have read-only tools available only.",
				"Do NOT attempt to edit, write, or modify files.",
				"Instead, produce a numbered plan of the changes you would make:",
				"1. Read the relevant files to understand the current state.",
				"2. List each change you would make, with file path and description.",
				"3. Explain the reasoning behind each change.",
				"4. Note any risks or alternatives.",
				"",
				"Exit plan mode (ctrl+shift+p) when you're ready to execute the plan.",
			].join("\n");

			return {
				systemPrompt: _event.systemPrompt + planDirective,
			};
		},
	);

	// Expose toggle for the /deepseek-optimized-plan command (wired in the entry point).
	(
		state as PlanModeState & {
			toggle: (ctx: ExtensionContext) => Promise<void>;
		}
	).toggle = toggle;

	return state;
}

/**
 * Build the plan mode directive appended to the system prompt.
 * Pure function extracted for testing.
 */
export function buildPlanDirective(shortcut?: string): string {
	const exitNote = shortcut
		? `Exit plan mode (${shortcut}) when you're ready to execute the plan.`
		: `Exit plan mode ("/deepseek-optimized-plan") when you're ready to execute the plan.`;
	return [
		"",
		"## PLAN MODE ACTIVE",
		"",
		"You are in Plan mode. You have read-only tools available only.",
		"Do NOT attempt to edit, write, or modify files.",
		"Instead, produce a numbered plan of the changes you would make:",
		"1. Read the relevant files to understand the current state.",
		"2. List each change you would make, with file path and description.",
		"3. Explain the reasoning behind each change.",
		"4. Note any risks or alternatives.",
		"",
		exitNote,
	].join("\n");
}
