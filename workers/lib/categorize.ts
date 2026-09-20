// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inbound email categorization with TypeSafe's Jev model
 * (`typesafe/jev`, https://developers.cloudflare.com/ai/models/typesafe/jev/).
 *
 * Jev evaluates a `state` against typed `noul`, `choice`, and `score`
 * questions and returns calibrated answers. We ask:
 *   - `is_spam`: noul question with a probability in [0, 1]
 *   - `category`: optional choice question over the mailbox's categories
 *
 * Classification is best-effort by design: any failure returns null and the
 * caller delivers the email uncategorized rather than bouncing it.
 */

import {
	categoryLabel,
	normalizeCategorizationSettings,
	SPAM_CATEGORY_ID,
	type CategorizationSettings,
} from "../../shared/categories";
import { stripHtmlToText } from "./email-helpers";

export interface IncomingEmailForClassification {
	sender: string;
	senderName?: string | null;
	recipients: string;
	subject: string;
	body: string;
}

interface JevNoulAnswer {
	type: "noul";
	noul: number;
}

interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	confidence?: number;
	probabilities?: Record<string, number>;
}

type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

interface JevResponse {
	model?: string;
	answers?: Record<string, JevAnswer | undefined>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface EmailClassification {
	/** Category ID stored on the email (`spam` or a configured category). */
	category: string | null;
	/** Display name for the chosen category, if any. */
	categoryName: string | null;
	/** Model confidence in the chosen category (noul probability or choice confidence). */
	categoryConfidence: number | null;
	isSpam: boolean;
	spamProbability: number | null;
	model: string | null;
	answers: Record<string, JevAnswer> | null;
	usage: { input_tokens?: number; output_tokens?: number } | null;
}

/** Keep the state comfortably inside Jev's 32k-token context window. */
const MAX_BODY_CHARS = 12_000;

/** Don't hold up email delivery for a slow model. */
const CLASSIFICATION_TIMEOUT_MS = 10_000;

const SPAM_INSTRUCTIONS =
	"Given the `state` object for a received email, decide whether it is spam. " +
	"Spam includes unsolicited bulk or marketing email, phishing, scams, fraud, and other unwanted junk. " +
	"A normal personal or business email, a receipt or notification, or a newsletter the recipient opted into is NOT spam.";

const SPAM_CRITERIA = {
	true: "The email is spam: unsolicited bulk/marketing, phishing, scam, fraud, or otherwise unwanted junk",
	false:
		"The email is legitimate personal or business correspondence (including opted-in newsletters, receipts, and notifications)",
};

const CATEGORY_INSTRUCTIONS =
	"Classify the received email described by `state` into exactly one category. " +
	"Use the sender, subject, and body to choose the single best-fitting criterion.";

/** Clamp a value to the probability range. */
function clampProbability(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Classify one inbound email against the mailbox's categorization settings.
 *
 * @returns the classification, or null when classification is disabled or the
 *          model call fails. Never throws.
 */
export async function classifyIncomingEmail(
	ai: Ai,
	email: IncomingEmailForClassification,
	rawSettings: unknown,
): Promise<EmailClassification | null> {
	const settings = normalizeCategorizationSettings(rawSettings);
	if (!settings.enabled) return null;

	const categories = settings.categories;
	if (!settings.spam.enabled && categories.length === 0) return null;

	const questions: Record<string, unknown> = {};

	if (settings.spam.enabled) {
		questions.is_spam = {
			type: "noul",
			instructions: SPAM_INSTRUCTIONS,
			criteria: SPAM_CRITERIA,
		};
	}

	if (categories.length > 0) {
		const criteria: Record<string, string> = {};
		for (const category of categories) {
			criteria[category.id] = category.description
				? `${category.name}: ${category.description}`
				: category.name;
		}
		questions.category = {
			type: "choice",
			instructions: CATEGORY_INSTRUCTIONS,
			criteria,
		};
	}

	const state = {
		sender: email.senderName
			? `${email.senderName} <${email.sender}>`
			: email.sender,
		recipients: email.recipients,
		subject: email.subject || "(no subject)",
		body: stripHtmlToText(email.body).slice(0, MAX_BODY_CHARS),
	};

	try {
		const response = (await ai.run(
			"typesafe/jev",
			{ state, questions },
			{ signal: AbortSignal.timeout(CLASSIFICATION_TIMEOUT_MS) },
		)) as JevResponse;

		return interpretJevResponse(response, settings);
	} catch (error) {
		console.error(
			"Jev email classification failed; leaving email uncategorized:",
			(error as Error).message,
		);
		return null;
	}
}

/**
 * Serialize a classification for the email row's `classification` JSON
 * column. Kept next to the classifier so the stored audit shape and the
 * parsed shape cannot drift apart.
 */
export function serializeClassification(
classification: EmailClassification | null,
): string | null {
if (!classification) return null;
return JSON.stringify({
model: classification.model,
is_spam: classification.isSpam,
spam_probability: classification.spamProbability,
category: classification.category,
category_name: classification.categoryName,
category_confidence: classification.categoryConfidence,
answers: classification.answers,
usage: classification.usage,
});
}

/** Translate the raw Jev answers into the shape stored on the email row. */
function interpretJevResponse(
	response: JevResponse,
	settings: CategorizationSettings,
): EmailClassification {
	const answers = response?.answers ?? {};
	const spamAnswer = answers.is_spam;
	const spamProbability =
		spamAnswer?.type === "noul" && typeof spamAnswer.noul === "number"
			? clampProbability(spamAnswer.noul)
			: null;
	const isSpam =
		settings.spam.enabled &&
		spamProbability !== null &&
		spamProbability >= settings.spam.threshold;

	let category: string | null = null;
	let categoryConfidence: number | null = null;

	if (isSpam) {
		// Spam wins over a custom category; the email is filed in Spam anyway.
		category = SPAM_CATEGORY_ID;
		categoryConfidence = spamProbability;
	} else if (settings.categories.length > 0) {
		const choiceAnswer = answers.category;
		const validIds = new Set(settings.categories.map((item) => item.id));
		let selected: string | undefined;

		if (choiceAnswer?.type === "choice") {
			if (validIds.has(choiceAnswer.choice)) {
				selected = choiceAnswer.choice;
			} else if (choiceAnswer.probabilities) {
				// Defensive fallback: if Jev returns an unknown key, pick the
				// highest-probability valid category instead of dropping the result.
				selected = Object.entries(choiceAnswer.probabilities)
					.filter(
						([id, probability]) =>
							validIds.has(id) && typeof probability === "number",
					)
					.sort(([, a], [, b]) => b - a)[0]?.[0];
			}

			if (selected) {
				category = selected;
				categoryConfidence =
					typeof choiceAnswer.confidence === "number"
						? clampProbability(choiceAnswer.confidence)
						: null;
			}
		}
	}

	const compactAnswers = Object.fromEntries(
		Object.entries(answers).filter(([, answer]) => answer != null),
	) as Record<string, JevAnswer>;

	return {
		category,
		categoryName: categoryLabel(category, settings.categories),
		categoryConfidence,
		isSpam,
		spamProbability,
		model: typeof response?.model === "string" ? response.model : null,
		answers: Object.keys(compactAnswers).length > 0 ? compactAnswers : null,
		usage: response?.usage ?? null,
	};
}
