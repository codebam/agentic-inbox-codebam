// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	EyeIcon,
	MarkdownLogoIcon,
	PencilSimpleIcon,
	TextAaIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { htmlToMarkdown, markdownToHtml } from "~/lib/markdown";
import RichTextEditor from "./RichTextEditor";

interface ComposeBodyEditorProps {
	/** Email body HTML. Drafts and sent mail always store HTML. */
	value: string;
	onChange: (value: string) => void;
}

type ComposeEditorMode = "rich" | "markdown";

const PREVIEW_CLASSES = [
	'prose prose-sm max-w-none p-3 text-sm min-h-[180px]',
	'[&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold',
	'[&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5',
	'[&_a]:text-kumo-link [&_a]:underline',
	'[&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_blockquote]:bg-kumo-tint [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-xs [&_blockquote]:rounded-r-sm',
	'[&_code]:rounded [&_code]:bg-kumo-recessed [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
	'[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-kumo-recessed [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
	'[&_hr]:my-4 [&_hr]:border-kumo-line',
	'[&_table]:my-2 [&_table]:w-full [&_th]:border [&_th]:border-kumo-line [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-kumo-line [&_td]:px-2 [&_td]:py-1',
].join(" ");

/**
 * Body editor for the compose form: the existing rich-text editor plus a
 * Markdown mode with live preview. Markdown is converted to HTML on every
 * change so the rest of the compose flow (drafts, replies, send) is unchanged.
 */
export default function ComposeBodyEditor({
	value,
	onChange,
}: ComposeBodyEditorProps) {
	const [mode, setMode] = useState<ComposeEditorMode>("rich");
	const [markdown, setMarkdown] = useState("");
	const [showPreview, setShowPreview] = useState(false);
	const lastHtmlRef = useRef(value);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const switchTo = useCallback(
		(next: ComposeEditorMode) => {
			if (next === mode) return;
			if (next === "markdown") {
				setMarkdown(htmlToMarkdown(value));
				setShowPreview(false);
				lastHtmlRef.current = value;
				requestAnimationFrame(() => textareaRef.current?.focus());
			}
			setMode(next);
		},
		[mode, value],
	);

	// Body changes that did not come from this editor (loaded draft, reply
	// prefill, signature arriving after mount, compose reset) refresh the
	// Markdown source. Changes we emitted ourselves are ignored.
	useEffect(() => {
		if (mode !== "markdown") return;
		if (value === lastHtmlRef.current) return;
		lastHtmlRef.current = value;
		setMarkdown(htmlToMarkdown(value));
	}, [mode, value]);

	const handleMarkdownChange = useCallback(
		(next: string) => {
			setMarkdown(next);
			const html = markdownToHtml(next);
			lastHtmlRef.current = html;
			onChange(html);
		},
		[onChange],
	);

	const richTextButton = (
		<Tooltip content="Rich text" side="bottom" asChild>
			<Button
				variant={mode === "rich" ? "secondary" : "ghost"}
				shape="square"
				size="sm"
				icon={<TextAaIcon size={16} />}
				onClick={() => switchTo("rich")}
				aria-label="Rich text"
			/>
		</Tooltip>
	);

	const markdownButton = (
		<Tooltip content="Markdown" side="bottom" asChild>
			<Button
				variant={mode === "markdown" ? "secondary" : "ghost"}
				shape="square"
				size="sm"
				icon={<MarkdownLogoIcon size={16} />}
				onClick={() => switchTo("markdown")}
				aria-label="Markdown"
			/>
		</Tooltip>
	);

	if (mode === "rich") {
		return (
			<RichTextEditor
				value={value}
				onChange={onChange}
				toolbarEnd={
					<>
						{richTextButton}
						{markdownButton}
					</>
				}
			/>
		);
	}

	return (
		<div className="rounded-lg border border-kumo-line overflow-hidden flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-0.5 bg-kumo-recessed px-2 py-1.5 border-b border-kumo-line shrink-0">
				<span className="px-2 inline-flex items-center gap-1.5 text-xs font-medium text-kumo-subtle">
					<MarkdownLogoIcon size={14} />
					Markdown
				</span>
				<div className="ml-auto flex items-center gap-0.5">
					<Button
						variant={!showPreview ? "secondary" : "ghost"}
						size="sm"
						icon={<PencilSimpleIcon size={14} />}
						onClick={() => setShowPreview(false)}
					>
						Write
					</Button>
					<Button
						variant={showPreview ? "secondary" : "ghost"}
						size="sm"
						icon={<EyeIcon size={14} />}
						onClick={() => setShowPreview(true)}
					>
						Preview
					</Button>
					{richTextButton}
					{markdownButton}
				</div>
			</div>

			{showPreview ? (
				<div
					className={PREVIEW_CLASSES}
					dangerouslySetInnerHTML={{ __html: markdownToHtml(markdown) }}
				/>
			) : (
				<textarea
					ref={textareaRef}
					value={markdown}
					onChange={(event) => handleMarkdownChange(event.target.value)}
					placeholder={
						"Write your email in Markdown…\n\n**bold**   *italic*   ~~strike~~   `code`   [link](https://example.com)\n\n# Heading\n- List item\n> Quote"
					}
					spellCheck
					aria-label="Email body in Markdown"
					className="w-full min-h-[180px] flex-1 resize-y bg-kumo-base p-3 text-sm font-mono leading-relaxed focus:outline-none"
				/>
			)}
		</div>
	);
}
