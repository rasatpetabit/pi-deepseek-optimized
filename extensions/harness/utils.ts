/**
 * Shared utilities for the pi-harness extension.
 *
 * Line hashing uses FNV-1a 32-bit (same family as the cwcode implementation)
 * truncated to 12 bits (3 hex chars). The hash is computed on trailing-
 * whitespace-trimmed content so edits that only change trailing spaces don't
 * cause spurious mismatches.
 */

/**
 * Compute a 3-character hex hash for a line of content.
 * The hash is based on trailing-whitespace-trimmed content.
 */
export function lineHash(line: string): string {
	const trimmed = line.replace(/\s+$/, "");
	let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
	for (let i = 0; i < trimmed.length; i++) {
		hash ^= trimmed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV-1a prime
	}
	// Take lowest 12 bits → 3 hex chars
	return (hash & 0xfff).toString(16).padStart(3, "0");
}

/**
 * Format a line number with its hash annotation.
 *
 * Output format: `     N:HHH→content`
 * The line number is right-padded to 5 chars for alignment with 3-digit+ lines.
 * The hash is 3 hex chars. The `→` separates annotation from content.
 */
export function annotateLine(lineNumber: number, content: string): string {
	const num = String(lineNumber).padStart(5, " ");
	const hash = lineHash(content);
	return `${num}:${hash}\u2192${content}`;
}

/** The regex used to detect already-annotated lines (to avoid double-annotation). */
const ANNOTATED_RE = /^\s*\d+:([0-9a-f]{3})\u2192/;

/** Check whether a line already has a hash annotation. */
export function isAnnotated(line: string): boolean {
	return ANNOTATED_RE.test(line);
}

/**
 * Annotate raw file content with line numbers and hashes.
 *
 * @param content Raw file content (newline-separated)
 * @param startLine 1-based line number of the first line (for offset reads)
 * @returns Annotated content where each line is `     N:HHH→original line content`
 *
 * Lines that are part of continuation notices (surrounded by `[...]`) are
 * left un-annotated so the model can distinguish them from file content.
 */
export function annotateContent(
	content: string,
	startLine = 1,
): string {
	const lines = content.split("\n");
	const result: string[] = [];
	let lineNum = startLine;
	let inNoticeBlock = false;

	for (const line of lines) {
		// Detect continuation notice blocks (lines starting with '[' at the end
		// of the content or after a blank line).
		if (line.startsWith("[") && (line.endsWith("]") || line.includes("to continue.]"))) {
			inNoticeBlock = true;
		}

		if (inNoticeBlock || line === "") {
			// Empty lines and notice blocks: still annotate empty lines with hashes
			// (the hash of an empty string is deterministic), but pass through
			// notice block lines unchanged.
			if (inNoticeBlock && !line.startsWith("[Showing") && !line.startsWith("[")) {
				inNoticeBlock = false;
			}
			if (inNoticeBlock) {
				result.push(line);
			} else {
				result.push(annotateLine(lineNum, line));
				lineNum++;
			}
		} else {
			if (isAnnotated(line)) {
				// Already annotated (e.g., re-read after our hook) — pass through.
				result.push(line);
				lineNum++;
			} else {
				result.push(annotateLine(lineNum, line));
				lineNum++;
			}
		}
	}

	return result.join("\n");
}

/**
 * Extract the error message from a tool result's content array.
 *
 * Tool results contain `(TextContent | ImageContent)[]`. We concatenate
 * all text content to produce an error signature for storm-breaker dedup.
 */
export function extractErrorText(
	content: { type: string; text?: string; data?: string }[],
): string {
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n")
		.slice(0, 500); // cap for dedup signature
}

/**
 * Normalize an error message into a signature for consecutive-failure dedup.
 *
 * Strips file-specific details (paths, line numbers, timestamps) so that
 * "Error: open /foo/bar.txt: no such file" and "Error: open /baz/qux.txt: no such file"
 * are considered the same failure class.
 */
export function errorSignature(toolName: string, errorText: string): string {
	const normalized = errorText
		.replace(/\/[^\s:]+/g, "<path>") // file paths
		.replace(/line \d+/gi, "line N") // line numbers
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<timestamp>") // ISO timestamps
		.replace(/\b0x[0-9a-f]+\b/gi, "<hex>") // hex addresses
		.slice(0, 200);
	return `${toolName}:${normalized}`;
}

/**
 * Enhance a raw tool error message to be more actionable.
 *
 * Catches common unhelpful error patterns and replaces them with messages
 * that tell the model *what to fix*, not just *what broke*.
 */
export function enhanceError(
	toolName: string,
	errorText: string,
): string {
	// Empty path errors
	if (/open\s*:?\s*no such file/i.test(errorText) || /no such file or directory/i.test(errorText)) {
		if (/open\s+:|open\s+''/.test(errorText) || errorText.includes('""')) {
			return `Error: the 'path' argument is empty or missing. Please provide a valid file path.`;
		}
	}

	// Permission errors
	if (/permission denied/i.test(errorText)) {
		return `${errorText}\n\nThis usually means the file is not readable. Check the path and permissions.`;
	}

	// Edit tool partial-match errors — include the actual content for context.
	// Only match edit-specific patterns to avoid catching unrelated 'not found' errors.
	if (/old_text.*not found|old_string.*not found|did not match|exact string.*not found/i.test(errorText)) {
		return `${errorText}\n\nThe exact string was not found in the file. This commonly happens when:\n- The file was modified since you last read it (re-read the file)\n- Whitespace differs (tabs vs spaces, trailing whitespace)\n- You are matching content from an outdated read\nSuggestion: use read to get fresh content, then retry.`;
	}

	// Offset out of bounds
	if (/offset.*beyond end of file/i.test(errorText)) {
		return `${errorText}\nThe file may be shorter than expected. Use read without offset to see the full file.`;
	}

	// Default: pass through with tool name context
	return `[${toolName}] ${errorText}`;
}

/**
 * Check whether a model matches any of the given patterns (case-insensitive
 * substring match against the model's provider, id, or name).
 *
 * Used to gate cache and hashline modules to DeepSeek-like models only.
 * Returns false when model is undefined (no model selected yet).
 */
export function matchesModelPattern(
	model: { id: string; provider: string; name: string } | undefined,
	patterns: string[],
): boolean {
	if (!model || patterns.length === 0) return false;
	const haystack = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
	return patterns.some((p) => haystack.includes(p.toLowerCase()));
}