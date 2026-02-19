# Supabase Email Templates

Plug and play examples can be found in the email-templates directory on the main project page. Refer to the Setup section for integration information.

stellar-drive uses three Supabase email templates. Configure these in your Supabase dashboard under **Authentication > Email Templates**.

## Multi-App Support

Multiple stellar-drive apps can share a **single Supabase project** (same Auth, same SMTP). The templates use Go template variables from `user_metadata` to dynamically render the correct app name and confirmation link domain:

- **`{{ .Data.app_name }}`** -- the app's human-readable name (set via `initEngine({ name: '...' })`)
- **`{{ .Data.app_domain }}`** -- the app's production URL (set via `initEngine({ domain: '...' })`)

Both values are written to Supabase `user_metadata` during signup, login, device link, and profile update. The templates reference these directly:

```
{{ .Data.app_name }}
{{ .Data.app_domain }}
```

**Why not just use `{{ .SiteURL }}`?** Supabase's `SiteURL` is a project-level setting -- it can only point to one domain. If two apps (e.g., Stellar Planner and Infinite Notes) share one Supabase project, `SiteURL` can only be set to one of them. By storing `app_domain` in `user_metadata`, each user's confirmation emails link to the correct app. Both `name` and `domain` are required fields on `initEngine()` -- there are no fallbacks.

## Templates

Each app should include its own copy of these template HTML files in `static/`:

| Supabase Template | Subject | File | Triggered by |
|---|---|---|---|
| **Confirm signup** | `Confirm Your Email` | `static/signup-email.html` | `setupSingleUser()` |
| **Change Email Address** | `Confirm Your New Email` | `static/change-email.html` | `changeSingleUserEmail()` |
| **Magic Link** | `Verify Your Device` | `static/device-verification-email.html` | `sendDeviceVerification()` via `signInWithOtp()` |

## Setup

1. Go to your Supabase dashboard > **Authentication** > **Email Templates**
2. For each template:
   - Select the template by name
   - Set the **Subject** as listed above
   - Copy the contents of the corresponding HTML file into the **Body** field
3. Ensure your `confirmRedirectPath` in the engine config matches the path in the templates (`/confirm` by default)

### Engine Configuration

The `name` and `domain` fields on `initEngine()` control what appears in emails:

```ts
initEngine({
  prefix: 'myapp',
  name: 'My App',                   // → {{ .Data.app_name }} in email templates
  domain: window.location.origin,   // → {{ .Data.app_domain }} in email templates
  // ...
});
```

These values are automatically included in `user_metadata` during:
- `setupSingleUser()` -- initial signup
- `unlockSingleUser()` -- each login (ensures metadata stays current before any OTP email)
- `linkSingleUserDevice()` -- device linking (before device verification email)
- `updateSingleUserProfile()` -- profile updates

## Confirmation Link Format

All templates construct confirmation links as:

```
{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&type=<type>
```

The `domain` is always `window.location.origin` at runtime, so no environment variable is needed -- the correct domain is always written to `user_metadata` automatically.

The `type` parameter matches what the `/confirm` page and engine expect:
- Signup: `type=signup`
- Email change: `type=email_change`
- Device verification: `type=email` (matches `verifyDeviceCode()` which uses `type: 'email'`)

## Design Notes

- All templates use **solid `background-color` values** instead of CSS gradients or `background-image` for Gmail compatibility (Gmail strips most `background-image` and `linear-gradient()` properties).
- **No SVG** -- Gmail strips all `<svg>` elements. Logos use text-based symbols instead.
- **VML fallbacks** for Outlook (`<!--[if mso]>` blocks) provide rounded buttons and card backgrounds.
- The device verification email uses a **green accent** (button + top bar) to visually distinguish it as a security action.
- Templates use a **neutral design** (dark background, amber/gold accents) so they work for any app brand. Each app can customize its template files independently.
