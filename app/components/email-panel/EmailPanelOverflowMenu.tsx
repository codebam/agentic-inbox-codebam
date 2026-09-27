// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Button, DropdownMenu, Tooltip } from "@cloudflare/kumo";
import { DotsThreeIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { downloadFile } from "~/lib/utils";


/**
 * The message panel's overflow menu: per-message actions that do not deserve
 * their own toolbar button. Today it holds one item — download the message
 * as .eml. Like the mailbox export, that file is reconstructed from the
 * stored fields (the mailbox never keeps the wire source), so it is a
 * faithful rebuild of the message, not a byte-exact copy.
 */
export default function EmailPanelOverflowMenu({
	mailboxId,
	emailId,
}: {
	mailboxId: string;
	emailId: string;
}) {
	return (
		<DropdownMenu>
			<Tooltip content="More actions" side="bottom" asChild>
				<DropdownMenu.Trigger
					render={
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<DotsThreeIcon size={18} />}
							aria-label="More actions"
						/>
					}
				/>
			</Tooltip>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Item
					icon={DownloadSimpleIcon}
					onClick={() => {
						downloadFile(
							`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/eml`,
							`${emailId}.eml`,
						);
					}}
				>
					Download .eml
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
