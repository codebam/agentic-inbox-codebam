// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * EML reconstruction shared by the message/rfc822 surfaces.
 *
 * The mailbox never stores the wire source, so the EML route
 * (workers/index.ts) and the export_email tool both rebuild a message from
 * the fields the mailbox kept at ingest (sender, recipient, cc, date,
 * subject, message_id, body) — see reconstructedMessage. One module so the
 * two surfaces cannot drift.
 */

/** The stored fields every reconstructed message is built from. */
export interface StoredMessageFields {
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	date: string | null;
	subject: string | null;
	message_id: string | null;
	body: string | null;
}

/**
 * One stored message as an RFC 5322 block: the headers the mailbox kept
 * (From, To, Cc when present, Date, Subject and Message-ID when the row has
 * one), a blank line, then the stored body. The mailbox never stores the
 * wire source, so this is a reconstruction from those fields — not a
 * byte-exact copy of what was sent or received. A body line that begins
 * with "From " is quoted with a leading ">" (RFC 4155) so it cannot be
 * mistaken for the next message's separator line.
 */
export function reconstructedMessage(row: StoredMessageFields): string {
	const lines: string[] = [
		`From: ${row.sender ?? ""}`,
		`To: ${row.recipient ?? ""}`,
	];
	if (row.cc) lines.push(`Cc: ${row.cc}`);
	lines.push(`Date: ${row.date ?? ""}`);
	lines.push(`Subject: ${row.subject ?? ""}`);
	if (row.message_id) lines.push(`Message-ID: ${row.message_id}`);
	lines.push("");
	for (const line of (row.body ?? "").split("\n")) {
		lines.push(line.startsWith("From ") ? `>${line}` : line);
	}
	return `${lines.join("\n")}\n`;
}
