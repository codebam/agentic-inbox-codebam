// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * FTS5 query-term helpers for the Durable Object search queries.
 *
 * The `emails_fts` index (migration 23) uses tokenize='trigram', which indexes
 * every three-character substring of a value. Three consequences shape this
 * module:
 *
 * 1. A term of one or two characters has no trigram to match, so it can never
 *    hit the index. Those terms keep the LIKE path (lib/like-terms.ts) and the
 *    split point is therefore exactly FTS_MIN_TERM_LENGTH. The count is in
 *    Unicode code points, the unit the tokenizer works in: an emoji is one
 *    character to SQLite but two UTF-16 units to JavaScript, and "👍👍" has to
 *    reach LIKE for a two-emoji search to match anything at all.
 * 2. FTS5 parses its MATCH argument as a query language, and operator input is
 *    arbitrary — `(`, `*`, `-` and an unbalanced quote are all syntax errors
 *    there. Every term is therefore emitted as a quoted phrase with inner
 *    double quotes doubled, which makes that punctuation literal and makes
 *    injection impossible: inside a quoted phrase the only special character
 *    is the quote itself.
 * 3. A NUL character is treated as a separator. workerd hands bound parameters
 *    to SQLite as C strings, so a NUL inside a phrase silently truncates it and
 *    the FTS5 parser rejects the remainder with "unterminated string".
 *
 * Terms past FTS_MAX_TERMS are dropped. Durable Object SQLite accepts at most
 * 100 bound parameters per statement (measured in workerd), and the condition
 * builder spends one parameter per FTS phrase on top of the LIKE patterns and
 * the from/to/subject filters, so a query of hundreds of words would otherwise
 * fail the whole search request. No real search query comes near the cap.
 */


/** Shortest term the trigram index can match, in Unicode code points. */
export const FTS_MIN_TERM_LENGTH = 3;


/** Most terms one query may contribute to a statement; the rest are dropped. */
export const FTS_MAX_TERMS = 32;


/** Where one term ends and the next begins. */
const TERM_SEPARATOR = /\s+/u;


/**
 * Quote a term as an FTS5 phrase, doubling inner quotes.
 *
 * The wrapping quotes are what make the term safe: everything inside them is
 * literal text, including `%`, `_`, `"` and every character FTS5 would
 * otherwise read as syntax.
 */
export function ftsPhrase(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
}


/** Length in Unicode code points — what the trigram tokenizer counts. */
function codePointLength(term: string): number {
	return [...term].length;
}


/**
 * Split a raw operator query into the terms the FTS index can match and the
 * ones it cannot.
 *
 * Returns `ftsPhrases` (each a ready-to-bind quoted FTS5 phrase) and
 * `shortTerms` (raw text for the LIKE path, in query order). Blank terms are
 * dropped, both arrays are empty for a blank query, and no part of the input
 * can produce FTS5 syntax — see the module comment.
 */
export function splitFtsTerms(rawQuery: string | null | undefined): {
	ftsPhrases: string[];
	shortTerms: string[];
} {
	const ftsPhrases: string[] = [];
	const shortTerms: string[] = [];
	// NUL counts as a separator too (reason 3 in the module comment):
	// replacing it keeps it out of every bound parameter.
	const raw = (typeof rawQuery === "string" ? rawQuery : "").replaceAll("\u0000", " ");

	for (const term of raw.split(TERM_SEPARATOR).filter(Boolean).slice(0, FTS_MAX_TERMS)) {
		if (codePointLength(term) >= FTS_MIN_TERM_LENGTH) {
			ftsPhrases.push(ftsPhrase(term));
		} else {
			shortTerms.push(term);
		}
	}

	return { ftsPhrases, shortTerms };
}
