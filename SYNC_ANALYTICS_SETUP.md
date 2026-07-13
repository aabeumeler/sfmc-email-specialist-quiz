# Sync and Admin Analytics Setup

The quiz code now contains the complete user/device model, QR pairing flow, consent controls, region collection endpoint, and private admin dashboard. The following one-time setup connects those features to hosted services.

## What the design stores

- Each browser installation receives a random device ID.
- Each anonymous user receives a random profile ID.
- QR pairing associates additional device IDs with the same profile ID.
- Each device uploads an encrypted contribution. Paired contributions are combined in the browser, which avoids double-counting offline activity.
- Appearance settings are encrypted before syncing.
- Analytics is off by default.
- When analytics is enabled, the complete merged statistics record becomes readable to the private admin dashboard.
- Approximate state or first-level region is collected only after opt-in. Raw IP addresses and exact location are not stored by the quiz.
- Turning analytics off deletes the readable statistics and stored region while allowing encrypted private sync to continue.

## 1. Create the Supabase project

1. Create a Supabase project.
2. In Authentication settings, enable anonymous sign-ins for quiz players.
3. Keep email-and-password authentication enabled for the administrator.
4. Set the site URL to `https://aabeumeler.github.io/sfmc-email-specialist-quiz/`.
5. Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor.

Supabase recommends bot protection for anonymous sign-ins on public sites. Add Cloudflare Turnstile support in a later security pass if usage expands; do not enable a CAPTCHA requirement until the quiz has been given its matching site key and token flow.

## 2. Create the sole admin account

1. In Supabase Authentication, create one user with the administrator email and a strong password.
2. Do not put that password in this repository, `sync-config.js`, SQL, or any GitHub setting.
3. In the SQL editor, allowlist the created user. Replace the example email only in the SQL editor:

```sql
insert into public.quiz_admins(user_id)
select id from auth.users
where email = 'your-private-admin-email@example.com'
on conflict (user_id) do nothing;
```

The password is transmitted over HTTPS and handled by Supabase Auth. Supabase stores a salted bcrypt password hash, not the original password. The dashboard also checks the `quiz_admins` allowlist before returning analytics.

## 3. Connect the public browser values

Copy the Supabase project URL and publishable key into [`sync-config.js`](sync-config.js). These two values are intended for browser use and are not passwords. Never place a Supabase secret key or service-role key in the repository.

## 4. Deploy coarse region lookup

The source in [`cloudflare-worker/src/index.js`](cloudflare-worker/src/index.js) returns only country and first-level region information supplied by Cloudflare. It does not return or store the visitor IP address.

1. Create a Cloudflare Worker.
2. Deploy the included Worker source and keep `ALLOWED_ORIGIN` set to `https://aabeumeler.github.io`.
3. Copy the Worker HTTPS URL into `regionEndpoint` in `sync-config.js`.

The quiz calls this endpoint only while anonymous analytics is enabled.

## 5. Verify before publishing

1. Take a quiz on one device and enable sync.
2. Display the one-time QR code and scan it on a second device.
3. Take a quiz while one device is offline, reconnect, and use **Sync Now**.
4. Confirm one anonymous user and two devices appear after opting in.
5. Confirm both devices' activity appears in the individual user view and the aggregate view.
6. Turn analytics off and confirm the user disappears from the dashboard while private sync continues.
7. Confirm an unapproved email/password account cannot open the dashboard.
