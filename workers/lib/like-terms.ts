// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * LIKE-pattern helpers for the Durable Object search queries.
 *
 * Two problems they solve:
 *
 * 1. `%` and `_` are LIKE wildcards. Someone searching for "50%" or
 *    "foo_bar" must not match unrelated rows, so the metacharacters (and the
 *    escape character itself) are escaped, and every LIKE clause built by the
 *    search condition builder uses `ESCAPE '\'`.
 * 2. SQLite rejects LIKE patterns longer than SQLITE_LIMIT_LIKE_PATTERN_LENGTH
 *    with "LIKE or GLOB pattern too complex". Durable Object SQLite caps this
 *    at 50 characters — measured in workerd: a 50-character pattern is
 *    accepted, a 51-character one throws — so a term longer than 48
 *    characters used to fail the whole search request. Terms are therefore
 *    split into chunks of at most 48 escaped characters and the chunks are
 *    ANDed together: every chunk still has to appear in the column for a row
 *    to match.
 */


/** Longest LIKE pattern Durable Object SQLite accepts (inclusive). */
export const LIKE_MAX_PATTERN_CHARS = 50;


/**
 * Longest *escaped* term chunk per pattern: the pattern budget minus the two
 * wrapping `%` wildcards.
 */
export const LIKE_TERM_MAX_CHARS = LIKE_MAX_PATTERN_CHARS - 2;


/** Escape LIKE metacharacters (`%`, `_`) and the escape character itself. */
export function escapeLikeTerm(term: string): string {
	return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}


/**
 * Split a term into chunks whose escaped form fits `maxChars`. Escaping
 * happens inside the loop, so a chunk never ends on a dangling escape
 * character.
 */
export function splitLikeTerm(
	term: string,
	maxChars: number = LIKE_TERM_MAX_CHARS,
): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const char of term) {
		const escaped = escapeLikeTerm(char);
		if (current.length > 0 && current.length + escaped.length > maxChars) {
			chunks.push(current);
			current = "";
		}
		current += escaped;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}


/**
 * `%...%` LIKE patterns for a user-supplied term: escaped, and split so no
 * single pattern can exceed the SQLite LIKE pattern limit.
 *
 * Returns `[]` for an empty (or whitespace-only) term, so callers can add no
 * condition at all in that case.
 */
export function likePatternsFor(
	term: string,
	maxChars: number = LIKE_TERM_MAX_CHARS,
): string[] {
	const trimmed = term.trim();
	if (!trimmed) return [];
	return splitLikeTerm(trimmed, maxChars).map((chunk) => `%${chunk}%`);
}
