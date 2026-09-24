// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Turn the stored classification audit into a human-readable verdict.
 *
 * Inputs are the columns written when an email arrives:
 *   - `classification` — the serialized Jev answer (see
 *     `workers/lib/categorize.ts`): `{ is_spam, spam_probability, category,
 *     category_name, category_confidence, model, ... }`. Legacy rows may hold
 *     a plain string token (`spam`, `not_spam`) instead.
 *   - `category` — the stored category id (`spam` or a configured category).
 *   - `category_confidence` — the model's confidence in [0, 1].
 *
 * Pure and total: null, legacy plain-string, and malformed JSON all degrade to
 * a category-derived verdict or "No AI verdict" — the function never throws
 * and never invents a verdict that is not in the data.
 */


import { SPAM_CATEGORY_ID } from "./categories";


export interface ClassificationSummaryInput {
	classification?: string | Record<string, unknown> | null;
	category?: string | null;
	category_confidence?: number | null;
	/** Display label for `category`, already resolved by the caller. */
	categoryLabel?: string | null;
}


export interface ClassificationSummary {
	/** One-line human verdict, e.g. `Spam — 0.94 confidence`. */
	verdict: string;
	/** Whether the stored data marks this email as spam (null = unknown). */
	isSpam: boolean | null;
	/** Probability backing the verdict, in [0, 1], when known. */
	confidence: number | null;
	/** Stored category id, when known. */
	category: string | null;
	/** Display label for the category, when known. */
	categoryName: string | null;
	/** Classifier model id, when recorded. */
	model: string | null;
	/** Where the verdict came from. */
	source: "classification" | "category" | "none";
}


const LEGACY_SPAM_RE = /^(spam|true)$/;
const LEGACY_HAM_RE = /^(not[ _-]?spam|ham|false)$/;


type ParsedClassification =
	| { kind: "object"; value: Record<string, unknown> }
	| { kind: "legacy"; value: string }
	| { kind: "none" };


function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}


function parseClassification(raw: unknown): ParsedClassification {
	if (isRecord(raw)) return { kind: "object", value: raw };
	if (typeof raw !== "string") return { kind: "none" };
	const trimmed = raw.trim();
	if (!trimmed) return { kind: "none" };
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isRecord(parsed)) return { kind: "object", value: parsed };
		if (typeof parsed === "string" && parsed.trim()) {
			return { kind: "legacy", value: parsed.trim() };
		}
		return { kind: "none" };
	} catch {
		// Not JSON at all: legacy rows stored a bare token in this column.
		return { kind: "legacy", value: trimmed };
	}
}


function finiteProbability(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(1, Math.max(0, value));
}


function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}


/** `spam` → `Spam`; `receipts-2024` → `Receipts 2024`. */
function labelForCategory(category: string): string {
	if (category === SPAM_CATEGORY_ID) return "Spam";
	return category
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}


/** `("Spam", 0.94)` → `Spam — 0.94 confidence`; no confidence → `Spam`. */
function verdictFor(label: string, confidence: number | null): string {
	return confidence === null
		? label
		: `${label} — ${confidence.toFixed(2)} confidence`;
}


/**
 * Summarize why an email was classified/filed. Always returns a summary; use
 * `source === "none"` (or `verdict === "No AI verdict"`) to decide whether to
 * render anything.
 */
export function summarizeClassification(
	input: ClassificationSummaryInput | null | undefined,
): ClassificationSummary {
	const source = input ?? {};
	const parsed = parseClassification(source.classification);
	const columnCategory = nonEmptyString(source.category);
	const columnConfidence = finiteProbability(source.category_confidence);
	const columnLabel = nonEmptyString(source.categoryLabel);


	if (parsed.kind === "object") {
		const value = parsed.value;
		const model = nonEmptyString(value["model"]);
		const category = nonEmptyString(value["category"]) ?? columnCategory;
		const categoryName =
			nonEmptyString(value["category_name"]) ??
			(category ? (columnLabel ?? labelForCategory(category)) : null);
		const jsonConfidence = finiteProbability(value["category_confidence"]);
		const spamProbability = finiteProbability(value["spam_probability"]);
		const isSpam = typeof value["is_spam"] === "boolean" ? value["is_spam"] : null;


		if (isSpam !== null) {
			const confidence = spamProbability ?? jsonConfidence ?? columnConfidence;
			return {
				verdict: verdictFor(isSpam ? "Spam" : "Not spam", confidence),
				isSpam,
				confidence,
				category,
				categoryName,
				model,
				source: "classification",
			};
		}


		// A classification without a boolean spam answer still explains the
		// filing when it recorded a category.
		if (category) {
			const confidence = jsonConfidence ?? columnConfidence;
			return {
				verdict: verdictFor(
					`Filed as ${categoryName ?? labelForCategory(category)}`,
					confidence,
				),
				isSpam: category === SPAM_CATEGORY_ID ? true : null,
				confidence,
				category,
				categoryName,
				model,
				source: "classification",
			};
		}


		return {
			verdict: "No AI verdict",
			isSpam: null,
			confidence: null,
			category: null,
			categoryName: null,
			model,
			source: "none",
		};
	}


	if (parsed.kind === "legacy") {
		const token = parsed.value.toLowerCase();
		const isSpam = LEGACY_HAM_RE.test(token)
			? false
			: LEGACY_SPAM_RE.test(token)
				? true
				: null;
		if (isSpam !== null) {
			return {
				verdict: verdictFor(isSpam ? "Spam" : "Not spam", columnConfidence),
				isSpam,
				confidence: columnConfidence,
				category: columnCategory,
				categoryName: columnCategory
					? (columnLabel ?? labelForCategory(columnCategory))
					: null,
				model: null,
				source: "classification",
			};
		}
	}


	// No usable AI audit trail: fall back to the stored category.
	if (columnCategory) {
		const isSpam = columnCategory === SPAM_CATEGORY_ID ? true : null;
		const name = columnLabel ?? labelForCategory(columnCategory);
		return {
			verdict: verdictFor(isSpam === true ? "Spam" : `Filed as ${name}`, columnConfidence),
			isSpam,
			confidence: columnConfidence,
			category: columnCategory,
			categoryName: name,
			model: null,
			source: "category",
		};
	}


	return {
		verdict: "No AI verdict",
		isSpam: null,
		confidence: null,
		category: null,
		categoryName: null,
		model: null,
		source: "none",
	};
}
