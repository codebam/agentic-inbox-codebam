// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Tooltip } from "@cloudflare/kumo";
import { CaretDownIcon, SparkleIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
	hasAuthResults,
	parseAuthResults,
	type AuthMethodResult,
} from "shared/auth-results";
import { categoryLabel, type EmailCategory } from "shared/categories";
import { summarizeClassification } from "shared/classification-summary";
import type { Email } from "~/types";


/** Rule columns added by the rules branch; optional on purpose (hot file). */
interface EmailRuleFields {
	matched_rule_id?: string | null;
	matched_rule_name?: string | null;
}


interface ExplainPanelProps {
	email: Email;
	/** Mailbox + global categories, used to resolve the stored category id. */
	categories?: EmailCategory[];
}


/** Result token → badge tone. Only standard tokens ever reach the UI. */
function authBadgeVariant(
	result: AuthMethodResult["result"],
): "success" | "error" | "warning" | "secondary" {
	if (result === "pass") return "success";
	if (result === "fail") return "error";
	if (result === "softfail" || result === "temperror" || result === "permerror") {
		return "warning";
	}
	return "secondary";
}


/**
 * "Why this email?" strip: the stored AI verdict, the filed category, the
 * SPF/DKIM/DMARC results, and — when the rules branch supplies them — the rule
 * that filed the message.
 *
 * Read-only and self-hiding: it renders nothing at all when there is nothing
 * to explain (Sent items and drafts carry neither a classification nor
 * authentication headers), so no empty boxes appear.
 */
export default function ExplainPanel({ email, categories }: ExplainPanelProps) {
	const [showRawAuth, setShowRawAuth] = useState(false);


	const auth = useMemo(() => parseAuthResults(email.raw_headers), [email.raw_headers]);
	const summary = useMemo(
		() =>
			summarizeClassification({
				classification: email.classification,
				category: email.category,
				category_confidence: email.category_confidence,
				categoryLabel: categoryLabel(email.category, categories),
			}),
		[email.classification, email.category, email.category_confidence, categories],
	);
	const authEntries = useMemo(
		() =>
			[auth.spf, auth.dkim, auth.dmarc].filter(
				(entry): entry is AuthMethodResult => Boolean(entry),
			),
		[auth],
	);


	// Rules columns arrive from a separate branch; read them defensively.
	const ruleFields = email as Email & EmailRuleFields;
	const matchedRule =
		ruleFields.matched_rule_name || ruleFields.matched_rule_id || null;


	if (!hasAuthResults(auth) && summary.source === "none" && !matchedRule) {
		return null;
	}


	return (
		<div className="px-4 py-2.5 border-b border-kumo-line bg-kumo-tint/40 shrink-0 md:px-6">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<span className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle">
					<SparkleIcon size={14} weight="duotone" />
					Why this email?
				</span>


				<span className="text-xs text-kumo-default">
					{summary.source === "none" ? "No AI verdict" : summary.verdict}
				</span>


				{summary.category && (
					<Badge variant={summary.isSpam === true ? "red" : "secondary"}>
						{summary.categoryName ?? summary.category}
					</Badge>
				)}


				{summary.model && (
					<span className="text-[11px] text-kumo-subtle">{summary.model}</span>
				)}


				{matchedRule && (
					<span className="text-xs text-kumo-subtle">
						Filed by rule: <span className="text-kumo-default">{matchedRule}</span>
					</span>
				)}


				{authEntries.length > 0 && (
					<span className="flex items-center gap-1.5">
						{authEntries.map((entry) => (
							<Tooltip
								key={entry.method}
								content={`${entry.headerName}: ${entry.headerValue}`}
								asChild
							>
								<span className="inline-flex">
									<Badge variant={authBadgeVariant(entry.result)}>
										{entry.method.toUpperCase()} {entry.result}
										{entry.domain ? ` · ${entry.domain}` : ""}
									</Badge>
								</span>
							</Tooltip>
						))}
						<button
							type="button"
							onClick={() => setShowRawAuth((open) => !open)}
							className="inline-flex items-center gap-0.5 text-[11px] text-kumo-subtle hover:text-kumo-default"
							aria-expanded={showRawAuth}
						>
							Raw headers
							<CaretDownIcon
								size={10}
								className={showRawAuth ? "rotate-180 transition-transform" : "transition-transform"}
							/>
						</button>
					</span>
				)}
			</div>


			{showRawAuth && authEntries.length > 0 && (
				<div className="mt-2 space-y-1">
					{authEntries.map((entry) => (
						<div
							key={entry.method}
							className="font-mono text-[11px] break-all text-kumo-subtle"
						>
							<span className="font-semibold text-kumo-default">
								{entry.headerName}:
							</span>{" "}
							{entry.headerValue}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
