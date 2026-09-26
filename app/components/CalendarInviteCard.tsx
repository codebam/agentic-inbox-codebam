// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import { CalendarDotsIcon, CheckIcon, QuestionIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { formatDetailDate } from "shared/dates";
import { useCalendarInvite, useRespondToInvite } from "~/queries/calendar";
import type { CalendarResponse } from "~/queries/calendar";

interface CalendarInviteCardProps {
	emailId: string;
	mailboxId?: string | undefined;
}

/** The colour of the badge showing an already-recorded answer. */
const RESPONSE_BADGE_VARIANT: Record<CalendarResponse, "green" | "orange" | "red"> = {
	accepted: "green",
	tentative: "orange",
	declined: "red",
};

/**
 * The ISO instant the server carried next to a UTC ICS value, when it carried
 * one: the parser stores `20260925T140000Z (2026-09-25T14:00:00.000Z)`. An
 * all-day DATE and a floating local time have no instant, and are shown as the
 * ICS wrote them — never reformatted through a timezone the invite never named.
 */
function inviteInstant(value: string): string | null {
	const match = /\(([^()]+)\)\s*$/.exec(value);
	if (!match) return null;
	const candidate = match[1] ?? "";
	return Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

/** One invite date: the formatted instant when there is one, else the raw value. */
function inviteDate(value: string): string {
	const instant = inviteInstant(value);
	return instant ? formatDetailDate(instant) : value;
}

/**
 * The calendar invitation the open message carries, as a strip under its
 * header: what the organizer asked for, when and where, plus the three
 * answers. Accept / Decline / Tentative POST the iMIP reply the server sends
 * to the organizer — an explicit click only, never automatic — and the
 * recorded answer appears as a badge once the route confirms it. The actions
 * are disabled while a response is in flight, and the card renders nothing
 * while the invite is loading or when the message carries none, so mail
 * without an invitation looks exactly as it did before this card existed.
 */
export default function CalendarInviteCard({ emailId, mailboxId }: CalendarInviteCardProps) {
	const { data, isLoading } = useCalendarInvite(mailboxId, emailId);
	const respond = useRespondToInvite();
	const toastManager = useKumoToastManager();

	const invite = data?.invite ?? null;
	if (isLoading || !invite) return null;

	const answer = (response: CalendarResponse) => {
		if (!mailboxId) return;
		respond.mutate(
			{ mailboxId, emailId, response },
			{
				onSuccess: () => toastManager.add({ title: `Invitation ${response}` }),
				onError: (error) => {
					toastManager.add({
						title: "Could not send the response",
						description:
							error instanceof Error ? error.message : "Something went wrong",
						variant: "error",
					});
				},
			},
		);
	};

	const answerButton = (
		response: CalendarResponse,
		label: string,
		icon: ReactNode,
	) => (
		<Button
			variant={response === "declined" ? "ghost" : "secondary"}
			size="xs"
			icon={icon}
			disabled={!mailboxId || respond.isPending}
			loading={respond.isPending && respond.variables?.response === response}
			onClick={() => answer(response)}
		>
			{label}
		</Button>
	);

	return (
		<div className="px-4 py-2 border-b border-kumo-line md:px-6">
			<div className="flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
				<CalendarDotsIcon size={14} className="shrink-0" />
				<span>Calendar invitation</span>
				{invite.method && <Badge variant="secondary">{invite.method.toLowerCase()}</Badge>}
				{invite.response && (
					<Badge variant={RESPONSE_BADGE_VARIANT[invite.response]}>
						{invite.response}
					</Badge>
				)}
			</div>
			<div className="mt-2 space-y-1">
				<div className="text-sm text-kumo-default">{invite.summary ?? "(no summary)"}</div>
				{invite.organizer && (
					<div className="text-xs text-kumo-subtle">Organizer: {invite.organizer}</div>
				)}
				{invite.start_at && (
					<div className="text-xs text-kumo-subtle">
						{inviteDate(invite.start_at)}
						{invite.end_at ? ` → ${inviteDate(invite.end_at)}` : ""}
					</div>
				)}
				{invite.location && (
					<div className="text-xs text-kumo-subtle">Where: {invite.location}</div>
				)}
			</div>
			{invite.method === "REQUEST" && (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{answerButton("accepted", "Accept", <CheckIcon size={14} />)}
					{answerButton("tentative", "Tentative", <QuestionIcon size={14} />)}
					{answerButton("declined", "Decline", <XIcon size={14} />)}
				</div>
			)}
		</div>
	);
}
