// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import {
	Badge,
	Button,
	Dialog,
	Input,
	Loader,
	Select,
	Switch,
	Textarea,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	FunnelIcon,
	MagnifyingGlassIcon,
	PencilSimpleIcon,
	PlusIcon,
	TrashIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import {
	mergeCategorizationCategories,
	SPAM_CATEGORY_ID,
} from "shared/categories";
import {
	hasOutboundActions,
	type MailRule,
	type RuleActions,
	type RuleConditions,
	type RuleDraft,
	type RuleMatchMode,
	type RulePreviewResult,
} from "workers/lib/rules";
import { useGlobalCategorization } from "~/queries/categorization";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import {
	useCreateRule,
	useDeleteRule,
	usePreviewRule,
	useReorderRules,
	useRules,
	useUpdateRule,
} from "~/queries/rules";
import type { Folder } from "~/types";


/** Mirrors MAX_RULE_NAME_LENGTH in workers/lib/rules.ts (client-side cap only). */
const RULE_NAME_MAX_LENGTH = 120;


type AttachmentChoice = "any" | "yes" | "no";
type ReadChoice = "unchanged" | "read" | "unread";
type StarChoice = "unchanged" | "star" | "unstar";


interface SelectItem {
	value: string;
	label: string;
}


const MATCH_MODE_ITEMS: SelectItem[] = [
	{ value: "all", label: "Match all conditions" },
	{ value: "any", label: "Match any condition" },
];


const ATTACHMENT_ITEMS: SelectItem[] = [
	{ value: "any", label: "Any message" },
	{ value: "yes", label: "Has an attachment" },
	{ value: "no", label: "Has no attachment" },
];


const READ_ITEMS: SelectItem[] = [
	{ value: "unchanged", label: "Leave unchanged" },
	{ value: "read", label: "Mark as read" },
	{ value: "unread", label: "Mark as unread" },
];


const STAR_ITEMS: SelectItem[] = [
	{ value: "unchanged", label: "Leave unchanged" },
	{ value: "star", label: "Star" },
	{ value: "unstar", label: "Unstar" },
];


/** Select hands back `unknown`; every option in this editor is a string. */
function selectValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}


/** Human-readable failure text for an ApiError or anything else thrown. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong";
}


interface RuleFormState {
	name: string;
	enabled: boolean;
	mode: RuleMatchMode;
	fromContains: string;
	toContains: string;
	subjectContains: string;
	bodyContains: string;
	attachment: AttachmentChoice;
	categoryEquals: string;
	moveToFolder: string;
	setCategory: string;
	read: ReadChoice;
	star: StarChoice;
	discard: boolean;
	/** Outbound: matching messages are forwarded to this single address. */
	forwardTo: string;
	/** Outbound: auto-reply body sent to the sender (guarded server-side). */
	autoReplyText: string;
}


const EMPTY_FORM: RuleFormState = {
	name: "",
	enabled: true,
	mode: "all",
	fromContains: "",
	toContains: "",
	subjectContains: "",
	bodyContains: "",
	attachment: "any",
	categoryEquals: "",
	moveToFolder: "",
	setCategory: "",
	read: "unchanged",
	star: "unchanged",
	discard: false,
	forwardTo: "",
	autoReplyText: "",
};


/** Load a stored rule into the editor state. */
function formFromRule(rule: MailRule): RuleFormState {
	const conditions = rule.match?.conditions ?? {};
	const actions = rule.actions ?? {};


	return {
		name: rule.name,
		enabled: rule.enabled,
		mode: rule.match?.mode === "any" ? "any" : "all",
		fromContains: conditions.from_contains ?? "",
		toContains: conditions.to_contains ?? "",
		subjectContains: conditions.subject_contains ?? "",
		bodyContains: conditions.body_contains ?? "",
		attachment:
			conditions.has_attachment === true
				? "yes"
				: conditions.has_attachment === false
					? "no"
					: "any",
		categoryEquals: conditions.category_equals ?? "",
		moveToFolder: actions.move_to_folder ?? "",
		setCategory: actions.set_category ?? "",
		read:
			actions.mark_read === true
				? "read"
				: actions.mark_unread === true
					? "unread"
					: "unchanged",
		star:
			actions.star === true
				? "star"
				: actions.unstar === true
					? "unstar"
					: "unchanged",
		discard: actions.discard === true,
		forwardTo: actions.forward_to ?? "",
		autoReplyText: actions.auto_reply_text ?? "",
	};
}


/** Turn the editor state into the wire shape the API validates. */
function formToDraft(form: RuleFormState): RuleDraft {
	const conditions: RuleConditions = {};
	const from = form.fromContains.trim();
	if (from) conditions.from_contains = from;
	const to = form.toContains.trim();
	if (to) conditions.to_contains = to;
	const subject = form.subjectContains.trim();
	if (subject) conditions.subject_contains = subject;
	const body = form.bodyContains.trim();
	if (body) conditions.body_contains = body;
	if (form.attachment === "yes") conditions.has_attachment = true;
	if (form.attachment === "no") conditions.has_attachment = false;
	if (form.categoryEquals) conditions.category_equals = form.categoryEquals;


	const actions: RuleActions = {};
	if (form.moveToFolder) actions.move_to_folder = form.moveToFolder;
	if (form.setCategory) actions.set_category = form.setCategory;
	if (form.read === "read") actions.mark_read = true;
	if (form.read === "unread") actions.mark_unread = true;
	if (form.star === "star") actions.star = true;
	if (form.star === "unstar") actions.unstar = true;
	if (form.discard) actions.discard = true;
	const forwardTo = form.forwardTo.trim();
	if (forwardTo) actions.forward_to = forwardTo;
	const autoReplyText = form.autoReplyText.trim();
	if (autoReplyText) actions.auto_reply_text = autoReplyText;


	return {
		name: form.name.trim(),
		enabled: form.enabled,
		match: { mode: form.mode, conditions },
		actions,
	};
}


/** Client-side mirror of the server's "needs a condition and an action" rule. */
function validateForm(form: RuleFormState): string | null {
	if (!form.name.trim()) return "Give the rule a name.";
	const draft = formToDraft(form);
	if (Object.keys(draft.match.conditions).length === 0) {
		return "Add at least one match condition — a rule with no conditions never matches.";
	}
	if (Object.keys(draft.actions).length === 0) {
		return "Add at least one action.";
	}
	return null;
}


/** One-line summary of a rule's conditions, in the order the editor lists them. */
function conditionSummary(conditions: RuleConditions): string[] {
	const parts: string[] = [];
	if (conditions.from_contains) {
		parts.push(`from contains “${conditions.from_contains}”`);
	}
	if (conditions.to_contains) {
		parts.push(`to contains “${conditions.to_contains}”`);
	}
	if (conditions.subject_contains) {
		parts.push(`subject contains “${conditions.subject_contains}”`);
	}
	if (conditions.body_contains) {
		parts.push(`body contains “${conditions.body_contains}”`);
	}
	if (conditions.has_attachment === true) parts.push("has an attachment");
	if (conditions.has_attachment === false) parts.push("has no attachment");
	if (conditions.category_equals) {
		parts.push(`category is “${conditions.category_equals}”`);
	}
	return parts;
}


/** One-line summary of a rule's actions. */
function actionSummary(
	actions: RuleActions,
	folderNames: Map<string, string>,
	categoryNames: Map<string, string>,
): string[] {
	const parts: string[] = [];
	if (actions.move_to_folder) {
		parts.push(
			`move to ${folderNames.get(actions.move_to_folder) ?? actions.move_to_folder}`,
		);
	}
	if (actions.set_category) {
		parts.push(
			`categorize as ${categoryNames.get(actions.set_category) ?? actions.set_category}`,
		);
	}
	if (actions.mark_read === true) parts.push("mark as read");
	if (actions.mark_unread === true) parts.push("mark as unread");
	if (actions.star === true) parts.push("star");
	if (actions.unstar === true) parts.push("unstar");
	if (actions.discard === true) parts.push("discard");
	if (actions.forward_to) parts.push(`forward to ${actions.forward_to}`);
	if (actions.auto_reply_text) parts.push("auto-reply");
	return parts;
}




/** Short relative time ("2h ago") for firing stats and preview dates. */
function formatRelativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return iso;
	const minutes = Math.floor((Date.now() - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}


interface RulePreviewPanelProps {
	result: RulePreviewResult;
	/** Optional id -> display name map for the folder column. */
	folderNames?: Map<string, string>;
	onClose: () => void;
}




/**
 * Dry-run output: what the rule matches right now. Rendered under "Test rule"
 * in the editor and under a row. A preview never moves, changes, or sends
 * anything — it only reads stored mail with the live matcher.
 */
function RulePreviewPanel({
	result,
	folderNames,
	onClose,
}: RulePreviewPanelProps) {
	const matches = result.matches;
	return (
		<div className="mt-3 rounded-md border border-kumo-line bg-kumo-recessed p-4">
			<div className="mb-2 flex items-center justify-between gap-3">
				<div className="text-xs font-medium text-kumo-strong">
					Test result — {result.total} matching message
					{result.total === 1 ? "" : "s"}
				</div>
				<Button variant="ghost" size="sm" onClick={onClose}>
					Close
				</Button>
			</div>
			<p className="mb-3 text-xs text-kumo-subtle">
				Scanned the {result.scanned} most recent stored message
				{result.scanned === 1 ? "" : "s"}. Nothing was moved, changed, or sent.
				{result.total > matches.length
					? ` Showing the first ${matches.length}.`
					: ""}
			</p>
			{matches.length === 0 ? (
				<p className="text-xs text-kumo-subtle">
					No stored message matches these conditions yet.
				</p>
			) : (
				<ul className="max-h-64 space-y-1 overflow-y-auto">
					{matches.map((match) => (
						<li
							key={match.id}
							className="flex items-baseline justify-between gap-3 rounded border border-kumo-line bg-kumo-base px-3 py-1.5"
						>
							<div className="min-w-0">
								<div className="truncate text-xs font-medium text-kumo-default">
									{match.subject || "(no subject)"}
								</div>
								<div className="truncate text-xs text-kumo-subtle">
									{match.sender} ·{" "}
									{folderNames?.get(match.folder_id) ?? match.folder_id}
								</div>
							</div>
							<span className="shrink-0 text-xs text-kumo-subtle">
								{formatRelativeTime(match.date)}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}




interface RuleRowProps {
	rule: MailRule;
	index: number;
	count: number;
	isToggling: boolean;
	isReordering: boolean;
	isTesting: boolean;
	folderNames: Map<string, string>;
	categoryNames: Map<string, string>;
	/** Rendered inside the row (the "Test rule" results). */
	previewPanel?: ReactNode;
	onToggle: (rule: MailRule, enabled: boolean) => void;
	onMove: (index: number, direction: -1 | 1) => void;
	onEdit: (rule: MailRule) => void;
	onDelete: (rule: MailRule) => void;
	onTest: (rule: MailRule) => void;
}




function RuleRow({
	rule,
	index,
	count,
	isToggling,
	isReordering,
	isTesting,
	folderNames,
	categoryNames,
	previewPanel,
	onToggle,
	onMove,
	onEdit,
	onDelete,
	onTest,
}: RuleRowProps) {
	const conditions = conditionSummary(rule.match?.conditions ?? {});
	const actions = actionSummary(rule.actions ?? {}, folderNames, categoryNames);
	const isFirst = index === 0;
	const isLast = index === count - 1;


	return (
		<li className="rounded-lg border border-kumo-line bg-kumo-base p-4">
			<div className="flex items-start gap-3">
				<div className="pt-0.5">
					<Switch
						checked={rule.enabled}
						onCheckedChange={(checked) => onToggle(rule, checked)}
						size="sm"
						disabled={isToggling}
						aria-label={
							rule.enabled ? `Disable ${rule.name}` : `Enable ${rule.name}`
						}
					/>
				</div>


				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span
							className={`truncate text-sm font-medium ${
								rule.enabled ? "text-kumo-default" : "text-kumo-subtle"
							}`}
						>
							{rule.name}
						</span>
						<Badge variant="secondary">Priority {rule.priority}</Badge>
						{!rule.enabled && <Badge variant="outline">Paused</Badge>}
						{rule.actions?.discard === true && (
							<Badge variant="warning">Discards mail</Badge>
						)}
						{hasOutboundActions(rule.actions ?? {}) && (
							<Badge variant="warning">Sends mail</Badge>
						)}
						{(rule.fired_count ?? 0) > 0 && (
							<Badge variant="secondary">
								Fired {rule.fired_count}×
								{rule.last_fired_at
									? `, last ${formatRelativeTime(rule.last_fired_at)}`
									: ""}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-kumo-subtle">
						{conditions.length > 0
							? `When ${conditions.join(rule.match?.mode === "any" ? " or " : " and ")}`
							: "No conditions"}
						{" → "}
						{actions.length > 0 ? actions.join(", ") : "No actions"}
					</p>
				</div>


				<div className="flex shrink-0 items-center gap-0.5">
					<Tooltip content="Run earlier" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowUpIcon size={16} />}
							onClick={() => onMove(index, -1)}
							disabled={isFirst || isReordering}
							aria-label={`Move ${rule.name} earlier`}
						/>
					</Tooltip>
					<Tooltip content="Run later" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowDownIcon size={16} />}
							onClick={() => onMove(index, 1)}
							disabled={isLast || isReordering}
							aria-label={`Move ${rule.name} later`}
						/>
					</Tooltip>
					<Tooltip content="Test rule" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<MagnifyingGlassIcon size={16} />}
							onClick={() => onTest(rule)}
							disabled={isTesting}
							aria-label={`Test ${rule.name}`}
						/>
					</Tooltip>
					<Tooltip content="Edit" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<PencilSimpleIcon size={16} />}
							onClick={() => onEdit(rule)}
							aria-label={`Edit ${rule.name}`}
						/>
					</Tooltip>
					<Tooltip content="Delete" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<TrashIcon size={16} />}
							onClick={() => onDelete(rule)}
							aria-label={`Delete ${rule.name}`}
						/>
					</Tooltip>
				</div>
			</div>
			{previewPanel}
		</li>
	);
}


interface RuleEditorProps {
	rule: MailRule | null;
	mailboxId: string;
	folderItems: SelectItem[];
	categoryItems: SelectItem[];
	isSaving: boolean;
	error: string | null;
	onCancel: () => void;
	onSave: (form: RuleFormState) => void;
}


function RuleEditor({
	rule,
	mailboxId,
	folderItems,
	categoryItems,
	isSaving,
	error,
	onCancel,
	onSave,
}: RuleEditorProps) {
	const [form, setForm] = useState<RuleFormState>(() =>
		rule ? formFromRule(rule) : EMPTY_FORM,
	);
	const [localError, setLocalError] = useState<string | null>(null);
	const [previewResult, setPreviewResult] = useState<RulePreviewResult | null>(
		null,
	);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const previewTest = usePreviewRule();


	const update = <K extends keyof RuleFormState>(
		key: K,
		value: RuleFormState[K],
	) => {
		setForm((current) => ({ ...current, [key]: value }));
	};


	const folderSelectItems: SelectItem[] = [
		{ value: "", label: "Leave in its current folder" },
		...folderItems,
	];
	const categoryConditionItems: SelectItem[] = [
		{ value: "", label: "Any category" },
		...categoryItems,
	];
	const categoryActionItems: SelectItem[] = [
		{ value: "", label: "Leave unchanged" },
		...categoryItems,
	];


	const handleSubmit = () => {
		const validationError = validateForm(form);
		if (validationError) {
			setLocalError(validationError);
			return;
		}
		setLocalError(null);
		onSave(form);
	};


	/**
	 * "Test rule": dry-run the current form against stored mail. The server
	 * uses the same matcher as the live pipeline and writes nothing.
	 */
	const handleTest = async () => {
		const validationError = validateForm(form);
		if (validationError) {
			setLocalError(validationError);
			return;
		}
		setLocalError(null);
		setPreviewError(null);
		try {
			const result = await previewTest.mutateAsync({
				mailboxId,
				draft: formToDraft(form),
			});
			setPreviewResult(result);
		} catch (testError) {
			setPreviewResult(null);
			setPreviewError(errorMessage(testError));
		}
	};


	const shownError = localError ?? error;


	return (
		<div className="mb-6 rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="mb-4 flex items-center justify-between gap-4">
				<div className="text-sm font-medium text-kumo-default">
					{rule ? "Edit rule" : "New rule"}
				</div>
				<Switch
					checked={form.enabled}
					onCheckedChange={(checked) => update("enabled", checked)}
					size="sm"
					label="Enabled"
				/>
			</div>


			<div className="space-y-4">
				<Input
					label="Rule name"
					placeholder="e.g. File supplier invoices"
					value={form.name}
					onChange={(e) => update("name", e.target.value)}
					maxLength={RULE_NAME_MAX_LENGTH}
					required
				/>


				{/* Conditions */}
				<div className="space-y-3 rounded-md border border-kumo-line bg-kumo-recessed p-4">
					<div className="text-xs font-medium text-kumo-strong">Match</div>
					<Select
						label="Condition mode"
						items={MATCH_MODE_ITEMS}
						value={form.mode}
						onValueChange={(value) =>
							update("mode", selectValue(value) === "any" ? "any" : "all")
						}
						size="sm"
					/>
					<div className="grid gap-3 sm:grid-cols-2">
						<Input
							label="From contains"
							placeholder="e.g. billing@vendor.com"
							value={form.fromContains}
							onChange={(e) => update("fromContains", e.target.value)}
						/>
						<Input
							label="To contains"
							placeholder="e.g. invoices@yourdomain.com"
							value={form.toContains}
							onChange={(e) => update("toContains", e.target.value)}
						/>
						<Input
							label="Subject contains"
							placeholder="e.g. invoice"
							value={form.subjectContains}
							onChange={(e) => update("subjectContains", e.target.value)}
						/>
						<Input
							label="Body contains"
							placeholder="e.g. purchase order"
							value={form.bodyContains}
							onChange={(e) => update("bodyContains", e.target.value)}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<Select
							label="Attachment"
							items={ATTACHMENT_ITEMS}
							value={form.attachment}
							onValueChange={(value) =>
								update("attachment", selectValue(value) as AttachmentChoice)
							}
							size="sm"
						/>
						<Select
							label="Category is"
							items={categoryConditionItems}
							value={form.categoryEquals}
							onValueChange={(value) =>
								update("categoryEquals", selectValue(value))
							}
							size="sm"
						/>
					</div>
					<p className="text-xs text-kumo-subtle">
						Text conditions are case-insensitive substring tests. A rule with no
						active condition never matches, so nothing fires by accident.
					</p>
				</div>


				{/* Actions */}
				<div className="space-y-3 rounded-md border border-kumo-line bg-kumo-recessed p-4">
					<div className="text-xs font-medium text-kumo-strong">Actions</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<Select
							label="Move to folder"
							items={folderSelectItems}
							value={form.moveToFolder}
							onValueChange={(value) =>
								update("moveToFolder", selectValue(value))
							}
							size="sm"
						/>
						<Select
							label="Set category"
							items={categoryActionItems}
							value={form.setCategory}
							onValueChange={(value) => update("setCategory", selectValue(value))}
							size="sm"
						/>
						<Select
							label="Read state"
							items={READ_ITEMS}
							value={form.read}
							onValueChange={(value) =>
								update("read", selectValue(value) as ReadChoice)
							}
							size="sm"
						/>
						<Select
							label="Star state"
							items={STAR_ITEMS}
							value={form.star}
							onValueChange={(value) =>
								update("star", selectValue(value) as StarChoice)
							}
							size="sm"
						/>
					</div>
					{/* Outbound actions. Both send mail from this mailbox on arrival:
					    labelled plainly, and skipped for spam and discarded mail. */}
					<div className="grid gap-3 sm:grid-cols-2">
						<div>
							<Input
								label="Forward to"
								placeholder="e.g. archive@yourdomain.com"
								value={form.forwardTo}
								onChange={(e) => update("forwardTo", e.target.value)}
							/>
							<p className="mt-1 text-xs text-kumo-subtle">
								Sends automatically: matching messages are forwarded to this
								single address on arrival. Skipped for spam and discarded mail.
							</p>
						</div>
						<div>
							<Textarea
								label="Auto-reply"
								placeholder="e.g. Thanks — I'll get back to you within two working days."
								value={form.autoReplyText}
								onChange={(e) => update("autoReplyText", e.target.value)}
								rows={3}
							/>
							<p className="mt-1 text-xs text-kumo-subtle">
								Sends automatically: the sender gets this reply once per day.
								Suppressed for bulk/list mail and for your own address.
							</p>
						</div>
					</div>
					<div>
						<Switch
							checked={form.discard}
							onCheckedChange={(checked) => update("discard", checked)}
							size="sm"
							label="Discard the message"
						/>
						<p className="mt-1 text-xs text-kumo-subtle">
							A discarded message is dropped on arrival — it is never stored and
							its attachments are not saved.
						</p>
					</div>
					<p className="text-xs text-kumo-subtle">
						When several rules set the same field, the one that runs first wins.
						A rule needs at least one action.
					</p>
				</div>


				{shownError && <p className="text-xs text-kumo-danger">{shownError}</p>}


				{previewError && (
					<p className="text-xs text-kumo-danger">{previewError}</p>
				)}


				{previewResult && (
					<RulePreviewPanel
						result={previewResult}
						folderNames={
							new Map(folderItems.map((item) => [item.value, item.label]))
						}
						onClose={() => setPreviewResult(null)}
					/>
				)}


				<div className="flex justify-end gap-2">
					<Button
						variant="secondary"
						onClick={handleTest}
						loading={previewTest.isPending}
						disabled={isSaving}
						icon={<MagnifyingGlassIcon size={16} />}
					>
						Test rule
					</Button>
					<Button variant="secondary" onClick={onCancel} disabled={isSaving}>
						Cancel
					</Button>
					<Button variant="primary" onClick={handleSubmit} loading={isSaving}>
						{rule ? "Save changes" : "Create rule"}
					</Button>
				</div>
			</div>
		</div>
	);
}


export default function RulesRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();


	const { data: rules, isLoading, isError, error, refetch } = useRules(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: globalCategorization } = useGlobalCategorization();


	const createRule = useCreateRule();
	const updateRule = useUpdateRule();
	const deleteRule = useDeleteRule();
	const reorderRules = useReorderRules();
	const previewRule = usePreviewRule();


	const [isEditorOpen, setIsEditorOpen] = useState(false);
	const [editorRule, setEditorRule] = useState<MailRule | null>(null);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<MailRule | null>(null);
	/** "Test rule" result for one row (rule id -> matches). */
	const [rowPreview, setRowPreview] = useState<{
		ruleId: string;
		result: RulePreviewResult;
	} | null>(null);


	const folderItems = useMemo<SelectItem[]>(
		() => folders.map((folder: Folder) => ({ value: folder.id, label: folder.name })),
		[folders],
	);


	const categoryItems = useMemo<SelectItem[]>(() => {
		const merged = mergeCategorizationCategories(
			globalCategorization?.categories ?? [],
			mailbox?.settings?.categorization?.categories ?? [],
			mailbox?.settings?.categorization?.useGlobalCategories !== false,
		);
		return [
			{ value: SPAM_CATEGORY_ID, label: "Spam" },
			...merged.map((category) => ({
				value: category.id,
				label: category.name,
			})),
		];
	}, [globalCategorization, mailbox]);


	const folderNames = useMemo(
		() => new Map(folders.map((folder) => [folder.id, folder.name])),
		[folders],
	);
	const categoryNames = useMemo(
		() => new Map(categoryItems.map((item) => [item.value, item.label])),
		[categoryItems],
	);


	const ruleList = rules ?? [];


	const openCreate = () => {
		setEditorRule(null);
		setEditorError(null);
		setIsEditorOpen(true);
	};


	const openEdit = (rule: MailRule) => {
		setEditorRule(rule);
		setEditorError(null);
		setIsEditorOpen(true);
	};


	const closeEditor = () => {
		setIsEditorOpen(false);
		setEditorRule(null);
		setEditorError(null);
	};


	const handleSave = async (form: RuleFormState) => {
		if (!mailboxId) return;
		const draft = formToDraft(form);
		try {
			if (editorRule) {
				await updateRule.mutateAsync({
					mailboxId,
					ruleId: editorRule.id,
					patch: draft,
				});
				toastManager.add({ title: "Rule updated" });
			} else {
				await createRule.mutateAsync({ mailboxId, rule: draft });
				toastManager.add({ title: "Rule created" });
			}
			closeEditor();
		} catch (saveError) {
			const message = errorMessage(saveError);
			setEditorError(message);
			toastManager.add({
				title: "Failed to save rule",
				description: message,
				variant: "error",
			});
		}
	};


	const handleToggle = (rule: MailRule, enabled: boolean) => {
		if (!mailboxId) return;
		updateRule.mutate(
			{ mailboxId, ruleId: rule.id, patch: { enabled } },
			{
				onSuccess: () =>
					toastManager.add({
						title: enabled ? "Rule enabled" : "Rule paused",
					}),
				onError: (toggleError) =>
					toastManager.add({
						title: "Failed to update rule",
						description: errorMessage(toggleError),
						variant: "error",
					}),
			},
		);
	};


	const handleMove = (index: number, direction: -1 | 1) => {
		if (!mailboxId) return;
		const target = index + direction;
		if (target < 0 || target >= ruleList.length) return;
		const ids = ruleList.map((rule) => rule.id);
		const [moved] = ids.splice(index, 1);
		ids.splice(target, 0, moved);
		reorderRules.mutate(
			{ mailboxId, ids },
			{
				onSuccess: () =>
					toastManager.add({ title: "Rule order updated" }),
				onError: (moveError) =>
					toastManager.add({
						title: "Failed to reorder rules",
						description: errorMessage(moveError),
						variant: "error",
					}),
			},
		);
	};


	const handleDelete = async () => {
		if (!mailboxId || !deleteTarget) return;
		try {
			await deleteRule.mutateAsync({ mailboxId, ruleId: deleteTarget.id });
			toastManager.add({ title: "Rule deleted" });
			setDeleteTarget(null);
		} catch (deleteError) {
			toastManager.add({
				title: "Failed to delete rule",
				description: errorMessage(deleteError),
				variant: "error",
			});
		}
	};


	/** Row-level "Test rule": dry-run a stored rule against stored mail. */
	const handleTestRow = async (rule: MailRule) => {
		if (!mailboxId) return;
		try {
			const result = await previewRule.mutateAsync({
				mailboxId,
				draft: { name: rule.name, match: rule.match },
			});
			setRowPreview({ ruleId: rule.id, result });
		} catch (testError) {
			toastManager.add({
				title: "Test failed",
				description: errorMessage(testError),
				variant: "error",
			});
		}
	};


	const togglingRuleId = updateRule.isPending
		? updateRule.variables?.ruleId
		: undefined;


	if (isLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}


	if (isError) {
		return (
			<div className="h-full overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<h1 className="mb-6 text-lg font-semibold text-kumo-default">Rules</h1>
				<div className="flex flex-col items-center rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
					<WarningCircleIcon
						size={40}
						weight="thin"
						className="mb-3 text-kumo-danger"
					/>
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						Couldn't load rules
					</h3>
					<p className="mb-4 max-w-sm text-sm text-kumo-subtle">
						{errorMessage(error)}
					</p>
					<Button variant="secondary" size="sm" onClick={() => refetch()}>
						Try again
					</Button>
				</div>
			</div>
		);
	}


	return (
		<div className="h-full max-w-3xl overflow-y-auto px-4 py-4 md:px-8 md:py-6">
			<div className="mb-2 flex items-start justify-between gap-4">
				<h1 className="text-lg font-semibold text-kumo-default">Rules</h1>
				{!isEditorOpen && (
					<Button
						variant="primary"
						size="sm"
						icon={<PlusIcon size={16} />}
						onClick={openCreate}
					>
						New rule
					</Button>
				)}
			</div>
			<p className="mb-6 max-w-xl text-sm text-kumo-subtle">
				Rules run on arrival, before the AI classifier. Messages a rule handles
				skip AI categorization, and a rule that discards a message drops it
				entirely — nothing is stored. Rules run top to bottom; when two rules set
				the same field, the first one wins. Rules that forward or auto-reply send
				mail automatically, and are skipped for spam and discarded messages.
			</p>


			{isEditorOpen && (
				<RuleEditor
					key={editorRule?.id ?? "new"}
					rule={editorRule}
					mailboxId={mailboxId ?? ""}
					folderItems={folderItems}
					categoryItems={categoryItems}
					isSaving={createRule.isPending || updateRule.isPending}
					error={editorError}
					onCancel={closeEditor}
					onSave={handleSave}
				/>
			)}


			{ruleList.length === 0 && !isEditorOpen ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-kumo-line px-6 py-20 text-center">
					<FunnelIcon size={48} weight="thin" className="mb-4 text-kumo-subtle" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						No rules yet
					</h3>
					<p className="mb-5 max-w-sm text-sm text-kumo-subtle">
						Rules filter incoming mail before the AI classifier runs. Add one to
						file, label, star, or drop messages automatically.
					</p>
					<Button
						variant="primary"
						size="sm"
						icon={<PlusIcon size={16} />}
						onClick={openCreate}
					>
						New rule
					</Button>
				</div>
			) : (
				<ul className="space-y-2">
					{ruleList.map((rule, index) => (
						<RuleRow
							key={rule.id}
							rule={rule}
							index={index}
							count={ruleList.length}
							isToggling={togglingRuleId === rule.id}
							isReordering={reorderRules.isPending}
							folderNames={folderNames}
							categoryNames={categoryNames}
							onToggle={handleToggle}
							onMove={handleMove}
							onEdit={openEdit}
							onDelete={setDeleteTarget}
							onTest={handleTestRow}
							isTesting={previewRule.isPending}
							previewPanel={
								rowPreview?.ruleId === rule.id ? (
									<RulePreviewPanel
										result={rowPreview.result}
										folderNames={folderNames}
										onClose={() => setRowPreview(null)}
									/>
								) : null
							}
						/>
					))}
				</ul>
			)}


			<Dialog.Root
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="mb-2 text-base font-semibold">
						Delete rule
					</Dialog.Title>
					<Dialog.Description className="mb-4 text-sm text-kumo-subtle">
						“{deleteTarget?.name}” will stop filtering incoming mail. This cannot
						be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={({ className, ...props }) => (
								<Button {...props} {...(className ? { className } : {})} variant="secondary">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							onClick={handleDelete}
							loading={deleteRule.isPending}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
