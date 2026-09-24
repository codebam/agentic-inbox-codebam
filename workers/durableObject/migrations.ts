// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{
		// Jev classification results. `category` is `spam` or a configured
		// category ID; `classification` stores the raw model answer for audit
		// and future reprocessing.
		name: "9_add_email_categorization",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN category TEXT;
            ALTER TABLE emails ADD COLUMN category_confidence REAL;
            ALTER TABLE emails ADD COLUMN classification TEXT;

            CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category);
        `),
	},
	{
		// The SMTP envelope recipient is the address Cloudflare Email Routing
		// actually delivered to; the visible To header may differ for aliases,
		// forwarded mail, or Bcc-only deliveries.
		name: "10_add_envelope_recipient",
		sql: txn(`ALTER TABLE emails ADD COLUMN envelope_recipient TEXT;`),
	},
	{
		// Deterministic per-mailbox rules (filters). `match` stores the
		// JSON { mode, conditions } spec and `actions` the JSON action set;
		// both are parsed by workers/lib/rules.ts. Lower `priority` runs
		// first (see runRules for the full evaluation contract).
		name: "11_add_rules",
		sql: txn(`
            CREATE TABLE rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                priority INTEGER NOT NULL DEFAULT 0,
                match TEXT NOT NULL,
                actions TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX idx_rules_priority ON rules(priority, created_at);
        `),
	},

	{
		// Trash retention. `trashed_at` is stamped when a message enters the
		// Trash folder and cleared when it leaves (see folderMoveFields in
		// durableObject/index.ts). Deliberately NOT backfilled from `date`:
		// that column is the sender's Date header, not the trash time, so
		// backfilling would make freshly trashed old mail instantly eligible
		// for the retention sweep. Existing Trash rows keep NULL — "not
		// eligible until re-trashed" — and are still removable with the
		// manual "Empty trash" action.
		name: "12_add_trashed_at",
		sql: txn(`ALTER TABLE emails ADD COLUMN trashed_at TEXT;`),
	},
	{
		// The text/plain alternative from the inbound message, kept alongside
		// the HTML `body` so a reader can switch to a plain-text view without
		// converting markup on the fly. NULL for messages with no text part.
		name: "13_add_body_text",
		sql: txn(`ALTER TABLE emails ADD COLUMN body_text TEXT;`),
	},
	{
		// Per-mailbox sender allow/block policy (workers/lib/sender-policy.ts).
		// The inbound pipeline reads this before the Jev classifier: `block`
		// files mail straight into Spam (still stored — never dropped) and
		// skips classification + auto-draft; `allow` skips the spam question
		// but keeps category classification. Addresses are stored trimmed and
		// lowercased by the Durable Object.
		name: "14_add_sender_policy",
		sql: txn(`
            CREATE TABLE sender_policy (
                address TEXT PRIMARY KEY,
                policy TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `),
	},
	{
		// Firing statistics and the rule stamp on delivered mail.
		// `rule_stats` is keyed by rule id and cascades away with the rule;
		// the two email columns record which rule acted on a stored message
		// (the first rule in evaluation order that acted, matching the
		// first-write-wins contract of runRules).
		name: "15_add_rule_stats",
		sql: txn(`
            CREATE TABLE rule_stats (
                rule_id TEXT PRIMARY KEY REFERENCES rules(id) ON DELETE CASCADE,
                fired_count INTEGER NOT NULL DEFAULT 0,
                last_fired_at TEXT
            );

            ALTER TABLE emails ADD COLUMN matched_rule_id TEXT;
            ALTER TABLE emails ADD COLUMN matched_rule_name TEXT;
        `),
	},
	{
		// Backs the duplicate-delivery lookup in MailboxDO.createEmail.
		// NON-unique on purpose: databases created before this migration may
		// already hold rows with the same message_id (the exact situation the
		// dedupe check now prevents), and a UNIQUE index would fail to build
		// on them. Do not "fix" this into a unique index without first
		// deduplicating existing rows.
		name: "16_add_message_id_index",
		sql: txn(`CREATE INDEX idx_emails_message_id ON emails(message_id);`),
	},
	{
		// The Reply-To header as a lowercased comma-joined address list, the
		// same shape as cc/bcc. Replies target it when present (mailing lists,
		// ticketing systems) and fall back to the sender otherwise; NULL for
		// messages that do not set the header.
		name: "17_add_reply_to",
		sql: txn(`ALTER TABLE emails ADD COLUMN reply_to TEXT;`),
	},
	{
		// Snooze + follow-up reminders (workers/durableObject/index.ts).
		// `snooze_until` holds the wake time while a message sits in the
		// Snoozed folder; `snoozed_from_folder` remembers where it came from
		// so waking restores the original folder and never the Snoozed
		// folder itself. `remind_at` is the pending follow-up time and
		// `reminded_at` the instant it fired (cleared whenever the reminder
		// is re-set or cancelled), so a fired reminder can be listed without
		// re-arming the alarm. The folder row is seeded here the same way
		// migration 3 seeds Drafts, so every mailbox DO gets it on boot.
		name: "18_add_snooze_and_reminders",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN snooze_until TEXT;
            ALTER TABLE emails ADD COLUMN snoozed_from_folder TEXT;
            ALTER TABLE emails ADD COLUMN remind_at TEXT;
            ALTER TABLE emails ADD COLUMN reminded_at TEXT;

            CREATE INDEX idx_emails_snooze_until ON emails(snooze_until);
            CREATE INDEX idx_emails_remind_at ON emails(remind_at);

            INSERT INTO folders (id, name, is_deletable) VALUES ('snoozed', 'Snoozed', 0);
        `),
	},
	{
		// One-click unsubscribe (RFC 8058). `list_unsubscribe` and
		// `list_unsubscribe_post` keep the sender's headers verbatim so the
		// targets can be re-parsed later; `unsubscribed_at` is stamped only
		// after the sender's endpoint answered 2xx to an explicit operator
		// request (see the /unsubscribe route in workers/index.ts). Nothing
		// here fires automatically, and the agent/MCP surfaces deliberately
		// have no unsubscribe tool.
		name: "19_add_unsubscribe_headers",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN list_unsubscribe TEXT;
            ALTER TABLE emails ADD COLUMN list_unsubscribe_post TEXT;
            ALTER TABLE emails ADD COLUMN unsubscribed_at TEXT;
        `),
	},
	{
		// Metadata-only audit log for mutating agent/MCP tool calls
		// (workers/lib/agent-actions.ts). Deliberately narrow: ids, flags,
		// folder names, a subject and a thread id — never message bodies,
		// attachment bytes or credentials. `args`/`before_state`/`after_state`
		// are JSON strings the caller has already bounded to ~1000
		// characters. `undoable` marks the reversible tools (move_email,
		// star_email, mark_email_read); `undone_at` is stamped when
		// undo_action restores the before-state, which also makes a second
		// undo of the same row fail. MailboxDO.recordAgentAction prunes each
		// mailbox back to its newest 500 rows on every write.
		name: "20_add_agent_actions",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS agent_actions (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                tool TEXT NOT NULL,
                email_id TEXT,
                email_subject TEXT,
                thread_id TEXT,
                args TEXT,
                before_state TEXT,
                after_state TEXT,
                undoable INTEGER NOT NULL DEFAULT 0,
                undone_at TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_agent_actions_created_at ON agent_actions(created_at);
        `),
	},
	{
		// Mail-flow contacts (workers/lib/contacts.ts): one row per address
		// this mailbox has exchanged mail with. Metadata only — address,
		// display name, sent/received counts and first/last seen timestamps —
		// never message bodies. Fed by MailboxDO.createEmail: a message
		// stored in Sent counts every addressee as a sent contact, any other
		// folder counts its sender as received. recordContacts prunes each
		// mailbox back to its newest 5000 rows on every write. The UNIQUE
		// email column is the upsert target; the two indexes back the
		// lowercased address lookup and the recency-ranked page.
		name: "21_add_contacts",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT,
                sent_count INTEGER NOT NULL DEFAULT 0,
                received_count INTEGER NOT NULL DEFAULT 0,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
            CREATE INDEX IF NOT EXISTS idx_contacts_last_seen_at ON contacts(last_seen_at);
        `),
	},
];
