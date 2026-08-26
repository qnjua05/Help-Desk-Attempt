# Email-to-Ticket via Cloudflare Email Routing

Inbound email to your support address is delivered directly to the Worker —
no Microsoft Graph, no Entra app, no secrets, no polling. Mail arrives, the
`email` handler fires, and the ticket exists seconds later.

## Prerequisites

- A domain whose DNS is managed by Cloudflare (Email Routing can't receive
  mail on workers.dev addresses)
- The D1 migration `migrations/0002_email_to_ticket.sql` already applied
  (it adds the columns and ingest-log table this feature uses)

## 1. Enable Email Routing on the domain

1. Cloudflare dashboard → select your domain (zone)
2. **Email → Email Routing** → **Get started / Enable**
3. Cloudflare will offer to add the required **MX** and **TXT (SPF)** records
   automatically — accept. (If the domain currently receives mail elsewhere,
   note this changes where ALL mail for the domain goes. For a domain you
   don't use for mail, there's nothing to worry about.)
4. Wait for the records to verify (usually a couple of minutes).

## 2. Route a support address to the Worker

1. Email Routing → **Routing rules** → **Create address**
2. Custom address: `support` (giving you support@yourdomain.com — pick any
   local part you like)
3. Action: **Send to a Worker** → select `help-desk-attempt`
4. Save. Optionally set the catch-all rule to Drop or forward elsewhere.

## 3. Install the parser dependency and deploy

From the project folder:

```bash
npm install
npx wrangler deploy
```

(`npm install` pulls in `postal-mime`, the MIME parser the email handler
uses. Wrangler bundles it into the Worker automatically on deploy.)

## 4. Test

Send an email from anywhere (Gmail, work account, anything) to your new
support address. Refresh the app — the ticket should appear within seconds:
requester = sender address, priority Medium, with a system note recording
the email origin. Reply to the same thread and the reply lands as a work
note on the same ticket.

Watch live with `npx wrangler tail` if you want to see the handler fire.

## Behavior notes

- **Dedup:** each email's Message-ID header is recorded in
  `email_ingest_log` and on the ticket (UNIQUE index), so redelivery or
  retries can't create duplicates.
- **Threading:** replies are matched via their In-Reply-To / References
  headers. Replies to a Resolved ticket open a fresh ticket instead.
- **Loop guard:** auto-generated mail (bounces, out-of-office replies with
  an Auto-Submitted header) is ignored.
- **Body handling:** plain-text part preferred, HTML converted to text as a
  fallback, capped at 4,000 characters.
- **Attachments:** not stored (D1 isn't a blob store). The ticket records
  who sent it and when, so the original is findable in the sender's mailbox.
  R2 storage is a possible future enhancement.

## Note on the retired Graph approach

An earlier version of this feature polled a Microsoft 365 shared mailbox via
Graph on a cron trigger. That code has been removed. If this project later
moves into a licensed M365 tenant and you prefer a shared-mailbox intake,
the Graph approach can be restored from git history — and if so, scope the
Entra app to the one mailbox with an Exchange application access policy.
The Entra app registration and Cloudflare secrets (ENTRA_TENANT_ID,
ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET) from that experiment are no longer
used and can be cleaned up:

```bash
npx wrangler secret delete ENTRA_TENANT_ID
npx wrangler secret delete ENTRA_CLIENT_ID
npx wrangler secret delete ENTRA_CLIENT_SECRET
```

...and the "Helpdesk Mail Poller" app registration can be deleted from the
Entra portal.
