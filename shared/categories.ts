// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI email categorization settings shared by the Worker, Durable Object,
 * Agent/MCP tools, and frontend settings UI.
 *
 * Incoming email is classified with TypeSafe's Jev model
 * (`typesafe/jev`) through the Workers AI binding. Jev answers typed
 * questions, so spam is a `noul` (boolean/probability) question and custom
 * categories are a `choice` question.
 */

/** Special category value assigned to email classified as spam. */
export const SPAM_CATEGORY_ID = "spam";

/** Keep prompts small and settings editable from the UI. */
export const MAX_EMAIL_CATEGORIES = 12;

/** Category names/descriptions are broadcast to the model, so cap their size. */
const MAX_CATEGORY_NAME_LENGTH = 60;
const MAX_CATEGORY_DESCRIPTION_LENGTH = 300;

export interface EmailCategory {
	/** Stable identifier stored on emails and used as the Jev criteria key. */
	id: string;
	/** Human-readable label shown in the UI. */
	name: string;
	/** Guidance Jev uses to decide whether an email belongs to this category. */
	description: string;
}

export interface SpamCategorizationSettings {
	/** Run the Jev spam question. */
	enabled: boolean;
	/**
	 * Jev returns a calibrated probability in [0, 1]. At or above this
	 * threshold the email is considered spam. The UI enforces >= 0.5 so a
	 * stale setting can never mark every email as spam.
	 */
	threshold: number;
	/** File detected spam in the Spam folder instead of the Inbox. */
	moveToSpam: boolean;
}

export interface CategorizationSettings {
	/** Master switch for inbound email classification. */
	enabled: boolean;
	spam: SpamCategorizationSettings;
	/** Optional categories in addition to the spam/not-spam question. */
	categories: EmailCategory[];
}

export const DEFAULT_SPAM_THRESHOLD = 0.8;

/** Fresh default settings. `enabled` defaults on so spam is filtered on arrival. */
export function defaultCategorizationSettings(): CategorizationSettings {
	return {
		enabled: true,
		spam: {
			enabled: true,
			threshold: DEFAULT_SPAM_THRESHOLD,
			moveToSpam: true,
		},
		categories: [],
	};
}

/**
 * Turn arbitrary settings JSON into a safe, bounded shape. Missing settings
 * default to feature-on (spam detection only), while explicit `false`
 * disables the corresponding behaviour.
 */
export function normalizeCategorizationSettings(
	raw: unknown,
): CategorizationSettings {
	const value =
		raw && typeof raw === "object"
			? (raw as Partial<CategorizationSettings>)
			: {};
	const spamRaw =
		value.spam && typeof value.spam === "object"
			? (value.spam as Partial<SpamCategorizationSettings>)
			: {};

	const rawCategories = Array.isArray(value.categories) ? value.categories : [];
	const categories: EmailCategory[] = [];
	const seenIds = new Set<string>();

	for (
		let index = 0;
		index < rawCategories.length && categories.length < MAX_EMAIL_CATEGORIES;
		index++
	) {
		const candidate = rawCategories[index];
		if (!candidate || typeof candidate !== "object") continue;

		const name =
			typeof candidate.name === "string"
				? candidate.name.trim().slice(0, MAX_CATEGORY_NAME_LENGTH)
				: "";
		if (!name) continue;

		const description =
			typeof candidate.description === "string"
				? candidate.description.trim().slice(0, MAX_CATEGORY_DESCRIPTION_LENGTH)
				: "";

		let id =
			typeof candidate.id === "string" ? slugifyCategoryId(candidate.id) : "";
		if (!id) id = slugifyCategoryId(name) || `category-${index + 1}`;

		// `spam` is reserved for the built-in spam classification.
		let uniqueId = id;
		let suffix = 2;
		while (seenIds.has(uniqueId) || uniqueId === SPAM_CATEGORY_ID) {
			uniqueId = `${id}-${suffix++}`;
		}

		seenIds.add(uniqueId);
		categories.push({ id: uniqueId, name, description });
	}

	const threshold =
		typeof spamRaw.threshold === "number" && Number.isFinite(spamRaw.threshold)
			? spamRaw.threshold
			: DEFAULT_SPAM_THRESHOLD;

	return {
		enabled: value.enabled !== false,
		spam: {
			enabled: spamRaw.enabled !== false,
			threshold: Math.min(1, Math.max(0.5, threshold)),
			moveToSpam: spamRaw.moveToSpam !== false,
		},
		categories,
	};
}

/** Build a safe URL/SQL/Jev-key friendly category ID from a display name. */
export function slugifyCategoryId(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

/** Display label for a category ID, falling back to a readable form of the ID. */
export function categoryLabel(
	categoryId: string | null | undefined,
	categories?: EmailCategory[],
): string | null {
	if (!categoryId) return null;
	if (categoryId === SPAM_CATEGORY_ID) return "Spam";

	const match = categories?.find((category) => category.id === categoryId);
	if (match) return match.name;

	return categoryId
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}
