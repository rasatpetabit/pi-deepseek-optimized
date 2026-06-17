/**
 * Hashline editing module.
 *
 * Replaces exact-string editing with hash-anchored editing:
 *
 * 1. The `tool_result` hook for the `read` tool post-processes its output to
 *    inject per-line content hashes. The model receives:
 *
 *         1:5c2→package tools
 *         2:a1f→
 *         3:0eb→import "os"
 *
 * 2. A new `edit_lines` tool lets the model edit by line reference + hash
 *    verification, avoiding the need to reproduce exact old_string blocks.
 *
 * The pattern is from Can Akay's "harness problem" work and the cwcode
 * Substack post. It reduces retries and output tokens because the model
 * doesn't have to character-perfectly reproduce file content.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "./types.js";
import type { HashEdit } from "./types.js";
import { annotateContent, lineHash, matchesModelPattern } from "./utils.js";

/**
 * JSON Schema for the edit_lines tool parameters.
 *
 * Constructed as a plain JSON Schema object — at runtime, TypeBox schemas
 * are just JSON Schema with extra symbol properties that are only used for
 * TypeScript inference. The LLM only sees the JSON Schema.
 */
export const editLinesSchema = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description: "Path to the file to edit (relative to cwd or absolute).",
		},
		edits: {
			type: "array",
			description: "Hash-anchored edits to apply. Each edit replaces lines from..to (inclusive, 1-based) with new_text.",
			items: {
				type: "object",
				properties: {
					from: { type: "integer", description: "1-based start line number." },
					from_hash: { type: "string", description: "3-char hex hash of the from line (from the read annotation)." },
					to: { type: "integer", description: "1-based end line number (inclusive)." },
					to_hash: { type: "string", description: "3-char hex hash of the to line (from the read annotation)." },
					new_text: { type: "string", description: "Replacement text for lines from..to. May contain multiple lines (newline-separated)." },
				},
				required: ["from", "from_hash", "to", "to_hash", "new_text"],
			},
		},
	},
	required: ["path", "edits"],
} as const;

/** Runtime stats for the /harness-hashlines command. */
export interface HashlineStats {
	/** Number of read results annotated. */
	readsAnnotated: number;
	/** Number of edit_lines calls. */
	editCalls: number;
	/** Number of edit_lines hash mismatches. */
	hashMismatches: number;
	/** Number of edit_lines successful applications. */
	editSuccesses: number;
}

/**
 * Return type from the tool_result event handler.
 * (Defined locally because ToolResultEventResult is not re-exported.)
 */
interface LocalToolResultEventResult {
	content?: { type: string; text?: string; data?: string; mimeType?: string }[];
	details?: unknown;
	isError?: boolean;
}

/**
 * Register hashline editing hooks and the edit_lines tool.
 *
 * @returns HashlineStats (mutable) for display by commands.
 */
export function registerHashlines(
	pi: ExtensionAPI,
	config: HarnessConfig["hashlines"],
	cwd: string,
	patterns: string[],
): HashlineStats {
	const stats: HashlineStats = {
		readsAnnotated: 0,
		editCalls: 0,
		hashMismatches: 0,
		editSuccesses: 0,
	};

	if (!config.enabled) return stats;

	// ── Hook 1: Annotate read tool results with line hashes ──────────────
	//
	// The `tool_result` event fires after the read tool executes. We modify
	// the text content to inject `N:HHH→` prefix on each line. The model
	// sees annotated content and can use the hashes with edit_lines.
	pi.on(
		"tool_result",
		async (event: ToolResultEvent, ctx: ExtensionContext) => {
			// Only activate on matching models (DeepSeek-like).
			if (!matchesModelPattern(ctx.model, patterns)) return;

			// Only process read tool results.
			if (event.toolName !== "read") return;
			if (event.isError) return;

			// Only process text content (skip image-only reads).
			const textContent = event.content.find(
				(c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string",
			);
			if (!textContent) return;

			// Determine the starting line number (from offset parameter).
			const input = event.input as { offset?: number } | Record<string, unknown>;
			const offset =
				typeof input?.offset === "number" && input.offset > 0 ? input.offset : 1;

			// Annotate the content.
			const annotated = annotateContent(textContent.text, offset);

			// If nothing changed (e.g., content was already annotated or empty), skip.
			if (annotated === textContent.text) return;

			stats.readsAnnotated++;

			// Rebuild the content array with the annotated text.
			return {
					content: event.content.map((c) =>
						c.type === "text" && typeof c.text === "string"
							? { type: "text" as const, text: annotated }
							: c,
					),
				};
		},
	);

	// ── Register the edit_lines tool ────────────────────────────────────
	//
	// This tool reads the file fresh, recomputes hashes, and verifies that
	// the from/to line hashes match before applying the edit. On mismatch,
	// it returns a precise error so the model can self-correct.
	const editLinesTool: ToolDefinition = {
		name: "edit_lines",
		label: "edit lines",
		description:
			"Edit a file using hash-anchored line ranges. Each edit specifies a line range (from..to, 1-based inclusive) with the expected content hashes at both endpoints. The tool reads the file fresh, verifies the hashes match, and rejects on mismatch with a precise error showing the actual vs. claimed hash. Use this instead of 'edit' when you have a recent 'read' with hash annotations — it avoids the need to reproduce exact old_string blocks character-perfectly.",
		promptSnippet:
			"Edit file using hash-anchored line ranges (preferred when you have a recent read with hash annotations)",
		promptGuidelines: [
			"Prefer edit_lines for edits to files you've recently read with 'read'. The read output includes per-line hashes (format: N:HHH→content). Use these hashes with edit_lines to avoid character-perfect old_string reproduction.",
			"Use 'edit' only when you don't have a fresh read with hash annotations, or when you need to match a specific string without line numbers.",
		],
		parameters: editLinesSchema as any, // JSON Schema is runtime-compatible with TSchema
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { path: rawPath, edits } = params as { path: string; edits: HashEdit[] };
			stats.editCalls++;

			const absolutePath = resolve(ctx.cwd, rawPath);

			// Read the file fresh.
			let content: string;
			try {
				content = await readFile(absolutePath, "utf-8");
			} catch (err) {
			return {
					content: [{ type: "text" as const, text: `Error reading file: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: undefined,
				};
			}

			const lines = content.split("\n");

			// Validate all edits before applying any (fail-fast on first mismatch).
			for (const edit of edits) {
				const fromIdx = edit.from - 1;
				const toIdx = edit.to - 1;

				if (fromIdx < 0 || fromIdx >= lines.length) {
					return {
						content: [{ type: "text" as const, text: `edit_lines: line ${edit.from} is out of range (file has ${lines.length} lines).` }],
						isError: true,
						details: undefined,
					};
				}
				if (toIdx < 0 || toIdx >= lines.length || toIdx < fromIdx) {
					return {
						content: [{ type: "text" as const, text: `edit_lines: line ${edit.to} is out of range or before 'from' (file has ${lines.length} lines).` }],
						isError: true,
						details: undefined,
					};
				}

				const actualFromHash = lineHash(lines[fromIdx]!);
				if (actualFromHash !== edit.from_hash) {
					stats.hashMismatches++;
					return {
						content: [{
							type: "text" as const,
							text: `edit_lines: line ${edit.from} hash mismatch — claimed "${edit.from_hash}", actual "${actualFromHash}".\nCurrent line: "${lines[fromIdx]}"\n\nThe file may have changed since you last read it. Use 'read' to get fresh content with current hashes, then retry.`,
						}],
						isError: true,
						details: undefined,
					};
				}

				// Only check to_hash if from != to (single-line edits don't need to verify the same line twice).
				if (edit.to !== edit.from) {
					const actualToHash = lineHash(lines[toIdx]!);
					if (actualToHash !== edit.to_hash) {
						stats.hashMismatches++;
						return {
							content: [{
								type: "text" as const,
								text: `edit_lines: line ${edit.to} hash mismatch — claimed "${edit.to_hash}", actual "${actualToHash}".\nCurrent line: "${lines[toIdx]}"\n\nThe file may have changed since you last read it. Use 'read' to get fresh content with current hashes, then retry.`,
							}],
							isError: true,
							details: undefined,
						};
					}
				}
			}

			// All hashes verified — apply edits in reverse order to preserve
			// line numbers for subsequent edits.
			const sortedEdits = [...edits].sort((a, b) => b.to - a.to);
			for (const edit of sortedEdits) {
				const fromIdx = edit.from - 1;
				const toIdx = edit.to - 1;
				const newLines = edit.new_text.split("\n");
				lines.splice(fromIdx, toIdx - fromIdx + 1, ...newLines);
			}

			// Write the file.
			const newContent = lines.join("\n");
			try {
				await writeFile(absolutePath, newContent, "utf-8");
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Error writing file: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: undefined,
				};
			}

			stats.editSuccesses++;

			// Build a simple summary for the model.
			const linesChanged = edits.reduce(
				(sum, e) => sum + (e.to - e.from + 1),
				0,
			);
			const newLinesAdded = edits.reduce(
				(sum, e) => sum + e.new_text.split("\n").length,
				0,
			);

			return {
					content: [{
						type: "text" as const,
						text: `Successfully applied ${edits.length} edit${edits.length !== 1 ? "s" : ""} to ${rawPath} (${linesChanged} line${linesChanged !== 1 ? "s" : ""} replaced, ${newLinesAdded} line${newLinesAdded !== 1 ? "s" : ""} added).`,
					}],
					details: {
						editsApplied: edits.length,
						linesChanged,
						linesAdded: newLinesAdded,
					},
				};
		},
	};

	pi.registerTool(editLinesTool);

	return stats;
	return stats;
}

/**
 * Validate a set of hash-anchored edits against the current file lines.
 * Pure function extracted from the edit_lines tool for testing.
 *
 * @returns Error string if invalid, or null if all edits pass validation.
 */
export function validateEdits(lines: string[], edits: HashEdit[]): string | null {
	for (const edit of edits) {
		const fromIdx = edit.from - 1;
		const toIdx = edit.to - 1;

		if (fromIdx < 0 || fromIdx >= lines.length) {
			return `edit_lines: line ${edit.from} is out of range (file has ${lines.length} lines).`;
		}
		if (toIdx < 0 || toIdx >= lines.length || toIdx < fromIdx) {
			return `edit_lines: line ${edit.to} is out of range or before 'from' (file has ${lines.length} lines).`;
		}

		const actualFromHash = lineHash(lines[fromIdx]!);
		if (actualFromHash !== edit.from_hash) {
			return `edit_lines: line ${edit.from} hash mismatch — claimed "${edit.from_hash}", actual "${actualFromHash}".\nCurrent line: "${lines[fromIdx]}"\n\nThe file may have changed since you last read it. Use 'read' to get fresh content with current hashes, then retry.`;
		}

		if (edit.to !== edit.from) {
			const actualToHash = lineHash(lines[toIdx]!);
			if (actualToHash !== edit.to_hash) {
				return `edit_lines: line ${edit.to} hash mismatch — claimed "${edit.to_hash}", actual "${actualToHash}".\nCurrent line: "${lines[toIdx]}"\n\nThe file may have changed since you last read it. Use 'read' to get fresh content with current hashes, then retry.`;
			}
		}
	}
	return null;
}

/**
 * Apply hash-anchored edits to file lines (after validation).
 * Applies edits in reverse order to preserve line numbers for subsequent edits.
 * Pure function extracted for testing.
 */
export function applyEditsToLines(lines: string[], edits: HashEdit[]): string[] {
	const result = [...lines];
	const sortedEdits = [...edits].sort((a, b) => b.to - a.to);
	for (const edit of sortedEdits) {
		const fromIdx = edit.from - 1;
		const toIdx = edit.to - 1;
		const newLines = edit.new_text.split("\n");
		result.splice(fromIdx, toIdx - fromIdx + 1, ...newLines);
	}
	return result;
}

/**
 * Build an edit summary string for the model.
 * Pure function extracted for testing.
 */
export function buildEditSummary(edits: HashEdit[], path: string): string {
	const linesChanged = edits.reduce((sum, e) => sum + (e.to - e.from + 1), 0);
	const newLinesAdded = edits.reduce((sum, e) => sum + e.new_text.split("\n").length, 0);
	return `Successfully applied ${edits.length} edit${edits.length !== 1 ? "s" : ""} to ${path} (${linesChanged} line${linesChanged !== 1 ? "s" : ""} replaced, ${newLinesAdded} line${newLinesAdded !== 1 ? "s" : ""} added).`;
}