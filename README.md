# SBX Cars — Prototype + Server

This repository contains a static HTML/CSS prototype plus a small Node server that handles form submissions. The site reproduces the main layout: header, hero banner, card grid, and footer, and includes a `/server` backend to accept form submissions and deliver them via email (AWS SES or SMTP).

Contents
- [index.html](index.html) — main prototype page and forms
- [main.css](main.css) — consolidated site stylesheet (merged from styles.css and figma-styles.css)
 - `server/` — Node/Express server that exposes `/api/sell` and `/api/contact`

Quick local view
1. Open `index.html` in a browser for a static view.

Run the server locally (development)
1. Copy the example env and configure credentials:

```bash
cd server
cp .env.example .env
# Edit server/.env with SMTP or AWS credentials (see below)
npm install
npm run dev
```

The dev server runs the email endpoint and serves the static files. By default the server listens on port `3001` (configurable in `server/.env`).

Docker (production parity)
1. Build the container image from the repo root:

```bash
docker build -t sbxcars:latest .
```

2. Run the container (provide env file with secrets):

```bash
docker run --env-file server/.env -p 3001:3001 sbxcars:latest
```

Email sending configuration
-------------------------
The server supports two delivery methods (preferred order):

- AWS SES SDK (IAM credentials) — recommended for production
- SMTP relay (SES SMTP credentials) — supported as a fallback

Environment variables (examples)

For AWS SDK (preferred):

```env
USE_AWS_SDK=true
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...      # IAM user with ses:SendEmail permissions
AWS_SECRET_ACCESS_KEY=...
SMTP_FROM=sales@sbxcars.com    # verified sender
TO_EMAIL=sales@sbxcars.com
```

For SMTP relay (SES SMTP credentials):

```env
USE_AWS_SDK=false
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=SMTP_USERNAME_FROM_SES
SMTP_PASS=SMTP_PASSWORD_FROM_SES
SMTP_FROM=sales@sbxcars.com
TO_EMAIL=sales@sbxcars.com
```

AWS SES notes & troubleshooting (collected during setup)
-----------------------------------------------------
- Verify sender identity: SES requires the `SMTP_FROM` address (or sending domain) to be verified. In the SES console, verify the email or domain and add DNS records for DKIM if you verify the domain.
- Sandbox restrictions: New SES accounts start in a sandbox. In sandbox mode you can only send to verified recipients; to send to arbitrary addresses request production access via AWS Support.
- Support API limitation: creating a Support case via the AWS API/CLI requires a paid Support plan (Business/Enterprise). Use the Console to open a case if your account doesn't have a paid plan.
- Common errors seen during setup:
	- `535 Authentication Credentials Invalid`: SMTP username/password incorrect — use the SES console to create SMTP credentials and use those values in `server/.env`.
	- `MessageRejected: Email address is not verified`: Sender (`SMTP_FROM`) or recipient (`TO_EMAIL`) not verified — verify identities or remove sandbox restriction.
	- Use `ses.getSendQuota()` or check console output to validate AWS credentials; the server performs a quick SES check on startup.

Security & deliverability notes
- Use a verified sending domain and configure SPF/DKIM for best deliverability.
- Do not commit `server/.env` to git. Use secret management (Render/Heroku/Env vars) in production.

Server behavior highlights
- The server validates required fields and performs a honeypot anti-spam check.
- Replies: server sets the email `Reply-To` to the submitter so your team can reply directly.
- Safety: user-submitted fields are HTML-escaped before being included in email bodies to prevent injection.
- Errors: when no email provider is configured the API returns a 5xx and logs details (no silent success).

Testing the form endpoints
- Sell form (from homepage): POST `/api/sell` with JSON of the form fields.
- Contact form: POST `/api/contact` with name/email/message.

If you'd like I can:
- Add an acknowledgement email to senders (simple or templated).
- Create a dedicated IAM user with minimal SES permissions and wire it into `server/.env`.
- Help file a console Support case (instructions) to request SES production access.

License & notes
- This is a prototype codebase; adapt and harden before production use.

---

