// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import { UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent } from "react";
import { formatFileSize } from "~/lib/attachments";
import api, { ApiError, type ImportJob } from "~/services/api";


/** Query key for one mailbox's import jobs. */
function importJobsQueryKey(mailboxId: string | undefined) {
	return ["import-jobs", mailboxId] as const;
}


/** True while a job still has work: poll it and offer Cancel for these. */
function isActiveJob(job: ImportJob): boolean {
	return job.status === "pending" || job.status === "running";
}


/** Badge colour per job status. */
function statusVariant(status: ImportJob["status"]): "info" | "success" | "error" | "secondary" {
	switch (status) {
		case "pending":
		case "running":
			return "info";
		case "done":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "secondary";
	}
}


/**
 * One mailbox's import jobs, newest first. Polls every few seconds while a
 * job is pending or running: the server drains the file in bounded batches
 * driven by the mailbox's own alarm and pushes nothing to the browser.
 */
function useImportJobs(mailboxId: string | undefined) {
	return useQuery<ImportJob[]>({
		queryKey: mailboxId ? importJobsQueryKey(mailboxId) : ["import-jobs", "_disabled"],
		queryFn: async () => (await api.listImportJobs(mailboxId!)).jobs ?? [],
		enabled: !!mailboxId,
		refetchInterval: (query) => (query.state.data?.some(isActiveJob) ? 3000 : false),
	});
}


/**
 * Per-mailbox import: stage an mbox export or a single .eml file and watch it
 * drain.
 *
 * The upload stores the file as-is; the mailbox's alarm parses it in bounded
 * batches and files each message in the Inbox — unread, with its original
 * Date header, deduplicated by Message-ID, and never fed to the AI, the
 * rules, the webhook or push notifications. The card shows each job's status
 * and counts and polls while one is still moving; Cancel drops a job and its
 * staged bytes.
 */
export default function ImportCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const toastManager = useKumoToastManager();
	const qc = useQueryClient();
	const inputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const { data: jobs } = useImportJobs(mailboxId);

	const invalidateJobs = () => {
		if (mailboxId) {
			void qc.invalidateQueries({ queryKey: importJobsQueryKey(mailboxId) });
		}
	};

	const upload = useMutation({
		mutationFn: ({ mailbox, upload }: { mailbox: string; upload: File }) =>
			api.importMailboxFile(mailbox, upload),
	});
	const cancel = useMutation({
		mutationFn: ({ mailbox, jobId }: { mailbox: string; jobId: string }) =>
			api.cancelImportJob(mailbox, jobId),
	});

	const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
		setFile(event.target.files?.[0] ?? null);
	};

	const handleUpload = () => {
		if (!mailboxId || !file || upload.isPending) return;
		upload.mutate(
			{ mailbox: mailboxId, upload: file },
			{
				onSuccess: () => {
					toastManager.add({ title: "Import started" });
					setFile(null);
					if (inputRef.current) inputRef.current.value = "";
					invalidateJobs();
				},
				onError: (error) => {
					toastManager.add({
						title:
							error instanceof ApiError
								? error.message
								: "Failed to start the import",
						variant: "error",
					});
				},
			},
		);
	};

	const handleCancel = (jobId: string) => {
		if (!mailboxId || cancel.isPending) return;
		cancel.mutate(
			{ mailbox: mailboxId, jobId },
			{
				onSuccess: () => {
					toastManager.add({ title: "Import cancelled" });
					invalidateJobs();
				},
				onError: (error) => {
					toastManager.add({
						title:
							error instanceof ApiError
								? error.message
								: "Failed to cancel the import",
						variant: "error",
					});
					// The job may have finished since the last poll: refresh.
					invalidateJobs();
				},
			},
		);
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<UploadSimpleIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Import</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Import an mbox export or a single .eml file. Messages land in the
				Inbox unread, with their original dates and Message-IDs; duplicates
				are skipped, and nothing is sent, classified or notified.
			</p>

			<div className="flex items-center gap-2">
				<input
					ref={inputRef}
					type="file"
					accept=".mbox,.eml,application/mbox,message/rfc822"
					className="hidden"
					onChange={handleInputChange}
					disabled={!mailboxId || upload.isPending}
					aria-label="Choose an mbox or EML file"
				/>
				<Button
					variant="secondary"
					size="sm"
					disabled={!mailboxId || upload.isPending}
					onClick={() => inputRef.current?.click()}
				>
					Choose file
				</Button>
				<span className="truncate text-xs text-kumo-subtle">
					{file ? `${file.name} · ${formatFileSize(file.size)}` : "No file selected"}
				</span>
				<Button
					variant="primary"
					size="sm"
					icon={<UploadSimpleIcon size={16} />}
					loading={upload.isPending}
					disabled={!mailboxId || !file}
					onClick={handleUpload}
				>
					Upload &amp; import
				</Button>
			</div>

			{jobs && jobs.length > 0 && (
				<div className="mt-4 space-y-2">
					{jobs.map((job) => {
						const active = isActiveJob(job);
						const percent =
							job.size > 0
								? Math.min(100, Math.round((job.cursor / job.size) * 100))
								: 0;
						return (
							<div
								key={job.id}
								className="rounded-md border border-kumo-line px-3 py-2 text-xs"
							>
								<div className="flex items-center gap-2">
									<span className="truncate font-medium text-kumo-default">
										{job.filename}
									</span>
									<Badge variant={statusVariant(job.status)}>{job.status}</Badge>
									<span className="text-kumo-subtle">{formatFileSize(job.size)}</span>
									<span className="flex-1" />
									{active && (
										<Button
											variant="secondary"
											size="sm"
											icon={<XIcon size={14} />}
											disabled={cancel.isPending}
											onClick={() => handleCancel(job.id)}
										>
											Cancel
										</Button>
									)}
								</div>
								<div className="mt-1 text-kumo-subtle">
									{job.imported} imported · {job.skipped} skipped · {job.failed} failed
									{job.status === "running" && ` · ${percent}%`}
								</div>
								{job.last_error && (
									<div className="mt-1 text-kumo-danger">{job.last_error}</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
