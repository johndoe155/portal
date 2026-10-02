# Email setup — SMTP, SPF, DKIM, DMARC

**Audience:** whoever controls the school's domain DNS and mail.
**Why this matters:** the portal sends password resets, staff invites, guardian
verification links and absence alerts. If these land in spam, parents cannot
log in and the school will conclude the portal is broken. Deliverability is not
an optimisation here — it is a functional requirement.

> The portal is **provider-agnostic**: it speaks plain SMTP. Anything with an
> SMTP endpoint works (Postmark, Amazon SES, Resend, Mailgun, SendGrid, Google
> Workspace, Microsoft 365, or the school's own server).

---

## 1. Choose a sender address and domain

Use a subdomain dedicated to the portal, e.g. `portal.school.ng`, and send as
`no-reply@portal.school.ng`.

**Why a subdomain:** reputation is tracked per-domain. If the portal ever sends
a burst that trips a filter, a subdomain contains the damage and the staff's
day-to-day `@school.ng` mail is unaffected.

Set in `.env`:

```bash
MAIL_FROM="Greenfield High School <no-reply@portal.school.ng>"
# Optional: where a parent's reply should actually go.
MAIL_REPLY_TO="office@school.ng"
```

> Keep `MAIL_FROM` on a domain you control. Sending as `@gmail.com` or
> `@yahoo.com` will be rejected outright by DMARC-enforcing receivers.

---

## 2. Configure SMTP

```bash
# Implicit TLS (port 465)
SMTP_URL=smtps://USERNAME:PASSWORD@smtp.provider.com:465

# STARTTLS (port 587) — the portal sets requireTLS, so an unencrypted
# downgrade is refused rather than silently accepted.
SMTP_URL=smtp://USERNAME:PASSWORD@smtp.provider.com:587
```

Percent-encode any `@ : / ?` in the password (`p@ss` → `p%40ss`).

**Missing `SMTP_URL` is fatal in production.** The API and worker refuse to
boot. This is deliberate: the previous behaviour silently discarded every
message into a JSON sink while marking it delivered.

Provider notes:

| Provider | Host | Port | Username |
| --- | --- | --- | --- |
| Postmark | `smtp.postmarkapp.com` | 587 | server API token (as both user and pass) |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | SES SMTP credentials (**not** your AWS keys) |
| Resend | `smtp.resend.com` | 465 | `resend` / your API key |
| Mailgun | `smtp.mailgun.org` | 587 | `postmaster@<domain>` |
| Google Workspace | `smtp.gmail.com` | 587 | full address + **app password** (2FA required) |
| Microsoft 365 | `smtp.office365.com` | 587 | full address (needs SMTP AUTH enabled on the mailbox) |

---

## 3. Publish the DNS records

All three records go on the **sending domain** (`portal.school.ng` in these
examples). Replace the placeholder values with the ones your provider shows you.

### 3.1 SPF — who is allowed to send as this domain

One TXT record on the sending domain. **A domain must have exactly one SPF
record**; if one already exists, merge the `include:` into it rather than adding
a second.

```dns
portal.school.ng.   TXT   "v=spf1 include:spf.provider.com -all"
```

| Provider | `include:` |
| --- | --- |
| Postmark | `spf.mtasv.net` |
| Amazon SES | `amazonses.com` |
| Resend | `_spf.resend.com` |
| Mailgun | `mailgun.org` |
| Google Workspace | `_spf.google.com` |
| Microsoft 365 | `spf.protection.outlook.com` |

`-all` (hard fail) is correct for a dedicated sending subdomain: nothing else
should ever send as it. On a shared domain use `~all` (soft fail) until you are
certain every legitimate sender is listed.

### 3.2 DKIM — cryptographic proof the message was not altered

Your provider generates the key and gives you the record. It is usually a CNAME:

```dns
pm._domainkey.portal.school.ng.   CNAME   pm.mtasv.net.
```

or a TXT record containing the public key:

```dns
s1._domainkey.portal.school.ng.   TXT   "v=DKIM1; k=rsa; p=MIGfMA0GCSq…"
```

Use a 2048-bit key where the provider offers a choice. Some DNS panels split
long TXT values — that is fine, as long as they are concatenated chunks of one
record.

### 3.3 DMARC — what receivers should do when SPF/DKIM fail

```dns
_dmarc.portal.school.ng.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@school.ng; pct=100; adkim=s; aspf=s"
```

**Roll out in three stages — do not start at `p=reject`:**

| Stage | Record | When |
| --- | --- | --- |
| 1. Monitor | `p=none` | First 2 weeks. Collect reports, change nothing. |
| 2. Quarantine | `p=quarantine; pct=25` → `pct=100` | Once reports show 100% SPF+DKIM alignment. |
| 3. Enforce | `p=reject` | After 2 clean weeks at quarantine. |

Going straight to `p=reject` with a misconfigured DKIM key will bounce every
password reset the school sends, and you will find out from angry parents.

### 3.4 Optional but recommended

```dns
; MX on the sending subdomain so bounces have somewhere to go
portal.school.ng.          MX    10 feedback-smtp.provider.com.
; TLS reporting
_smtp._tls.portal.school.ng. TXT  "v=TLSRPTv1; rua=mailto:tlsrpt@school.ng"
```

---

## 4. Verify before go-live

```bash
npm run build -w @portal/api

SMTP_URL='smtps://user:pass@smtp.provider.com:465' \
MAIL_FROM='Greenfield High School <no-reply@portal.school.ng>' \
PUBLIC_WEB_ORIGIN='https://portal.school.ng' \
  node scripts/mail-check.mjs headteacher@school.ng
```

The script parses the URL, performs the SMTP handshake and auth, then sends a
message rendered through the portal's **real** templates — so what arrives is
exactly what a parent would get.

Then confirm the DNS is actually working:

```bash
dig +short TXT portal.school.ng          # SPF
dig +short TXT pm._domainkey.portal.school.ng   # DKIM (selector varies)
dig +short TXT _dmarc.portal.school.ng   # DMARC
```

And check the delivered message's **original headers** for all three:

```
spf=pass    dkim=pass    dmarc=pass
```

Finally, score the message at <https://www.mail-tester.com> — aim for 9/10 or
better. Anything below 7 will have deliverability problems with Gmail and
Outlook, which between them are most of the parent body.

---

## 5. Warm-up

A brand-new sending domain that suddenly emails 1,200 parents looks exactly like
a spam run. Before the bulk roster import:

1. Send staff invites first (≈60 messages) and let them sit a day.
2. Import parents in batches of ~200/day for the first week.
3. Watch bounces on `/admin/notifications` (the dead-letter screen) and remove
   bad addresses from the CSV before the next batch.

Volumes above a few hundred a day on a cold domain should go through a provider
with managed IP warm-up (Postmark and SES both handle this).

---

## 6. Operating it

- **Retries are automatic.** A failed send is retried six times with backoff
  (1m → 5m → 15m → 1h → 4h → 12h). Only after that is it dead-lettered.
- **Permanent failures are not retried.** A 5.x.x response or "no such user"
  goes straight to the dead-letter list — retrying those damages reputation.
- **Watch `/admin/notifications`.** It shows queued depth, failures and the last
  SMTP error per message, with a Retry button. With plain SMTP there is no
  webhook feedback loop, so this screen is the school's bounce visibility.
- **`/health`** reports `outbox.queued`, `outbox.dead` and `mailConfigured` for
  monitoring.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Everything in spam | No DKIM, or DMARC misaligned | Check `adkim=s` requires the DKIM `d=` to match the From domain exactly |
| `535 authentication failed` | Mailbox password used instead of API credentials | Use the provider's SMTP credentials |
| `Connection timeout` | Host firewall blocks outbound 465/587 | Ask the host to open it, or use the provider's HTTP API via a relay |
| Gmail only: "via provider.com" | DKIM not aligned with the From domain | Add the provider's DKIM record on *your* domain, not theirs |
| Works in test, fails in bulk | Provider rate limit | Lower `SMTP_MAX_CONNECTIONS` / `MAIL_BATCH_SIZE` |
| `self signed certificate` | Internal relay with a private CA | Prefer a real cert; the portal requires TLS on 587 by design |
