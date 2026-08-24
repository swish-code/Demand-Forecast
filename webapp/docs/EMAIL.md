# Sending the daily reports

The app builds the reports either way. This is only about how the message
leaves the building. Pick one, set `MAIL_TRANSPORT` in `.env`, restart.

| `MAIL_TRANSPORT` | Needs | Reaches | Status |
| --- | --- | --- | --- |
| `flow` | somebody to build one Power Automate flow | anyone | ready to set up |
| `delegated` | one sign-in as the sending mailbox | anyone | built, one click away |
| `smtp` | SMTP AUTH on the mailbox + an app password | anyone | built, needs the password |
| `graph` *(default)* | a tenant administrator's consent | anyone | blocked on that consent |
| `direct` | a server with clean IP reputation | `@swishhh.net` only | refused from a laptop |

Every option sends the same HTML report with the same CSV attachments.

---

## Why `graph` is currently blocked

The app asks Entra for a token and gets one — the problem is what is *in* it:

```
token issued · roles: (none granted)
Mail.Send present: no
```

`Mail.Send` (Application) lets an app send as **anybody** in the tenant, which
is why only a Global Administrator can grant it. Nothing in the code can work
around that.

To grant it: **Entra admin centre → App registrations →** the app with client ID
`b16c4d77-3582-4951-ab0c-e0f326c5fb94` **→ API permissions → Add a permission →
Microsoft Graph → Application permissions → `Mail.Send` → Grant admin consent**.

Worth pairing with an [application access
policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access) in
Exchange afterwards, so the app can only send as `automation@swishhh.net`
rather than as anyone.

---

## `flow` — Power Automate

The simplest route that needs nothing from an administrator. The flow runs as
whoever builds it, using their own Office 365 Outlook connection, so no
password or permission is stored in the app at all.

**One catch to check first:** the "When an HTTP request is received" trigger is
a premium connector. If nobody has a Power Automate Premium licence, use
`delegated` instead.

### Building the flow

1. [make.powerautomate.com](https://make.powerautomate.com) → **Create** →
   **Instant cloud flow** → skip the trigger picker → search for and choose
   **When an HTTP request is received**.

2. Open the trigger and paste this into **Request Body JSON Schema**:

   ```json
   {
     "type": "object",
     "properties": {
       "to": { "type": "string" },
       "subject": { "type": "string" },
       "html": { "type": "string" },
       "attachments": {
         "type": "array",
         "items": {
           "type": "object",
           "properties": {
             "name": { "type": "string" },
             "contentBytes": { "type": "string" }
           },
           "required": ["name", "contentBytes"]
         }
       }
     },
     "required": ["to", "subject", "html"]
   }
   ```

3. **New step → Office 365 Outlook → Send an email (V2)**, and fill it in from
   the trigger's outputs:

   | Field | Value |
   | --- | --- |
   | To | `to` |
   | Subject | `subject` |
   | Body | `html` |
   | Advanced → Is HTML | **Yes** |
   | Advanced → Attachments | the `attachments` array — Name: `name`, Content: `contentBytes` |

   The Attachments field takes the array directly. Switch that field to its
   array input and pass `attachments`; the property names already match what
   the connector expects.

4. **Save.** Reopen the trigger and copy the **HTTP POST URL**.

5. In `.env`:

   ```
   MAIL_TRANSPORT=flow
   POWER_AUTOMATE_URL=<the URL you copied>
   ```

   Restart, then **Admin → Daily reports → Dry run**, and **Send now** when the
   dry run looks right.

### About that URL

It ends in a signature, and that signature *is* the credential — anybody
holding the URL can make the flow send mail. Keep it in `.env` beside the
client secret: not in the repository, not in a chat message. To revoke it,
regenerate it on the trigger in Power Automate; the old URL stops working
immediately.

---

## `delegated` — send as one mailbox

Delegated `Mail.Send` only permits sending as the account that signed in, so
that account can consent for itself. No administrator, no premium licence.

1. **Admin → Daily reports → Connect a mailbox**
2. Sign in as `automation@swishhh.net` and accept
3. Set `MAIL_TRANSPORT=delegated` and restart

The refresh token is stored encrypted, and rotated tokens are saved as they
arrive so it does not silently expire after ninety days. Disconnecting is a
button on the same panel.

---

## `smtp` — authenticated submission

Verified available: `smtp.office365.com:587` advertises `AUTH LOGIN` after
STARTTLS. It needs SMTP AUTH left enabled on the sending mailbox and a
password — an app password, on a tenant with MFA.

```
MAIL_TRANSPORT=smtp
SMTP_USER=automation@swishhh.net
SMTP_PASS=<app password>
```

---

## `direct` — straight to the recipient's mail server

No credentials at all: a domain's mail exchanger accepts mail for its own
users. Only reaches `@swishhh.net` addresses, and the sending host must have
clean IP reputation and appear in the SPF record.

Tested from the development machine and refused:

```
250 2.1.0 Sender OK
550 5.7.1 Service unavailable, Client host [37.34.150.250] blocked using Spamhaus
```

That is a home broadband address, as expected. From a hosted server this is
viable as a fallback; it is not a primary plan.

---

## Test mode

While `MAIL_TEST_TO` is set in `.env`, every report goes to that address
instead of its real recipient, with the intended address in the subject line.
Clear it when you want them delivered for real.
