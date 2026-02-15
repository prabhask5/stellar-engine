# Supabase Email Templates

Stellar Engine uses three Supabase email templates. Configure these in your Supabase dashboard under **Authentication > Email Templates**.

The template HTML files are located in Stellar Planner at `static/`:

| Supabase Template | Subject | File | Triggered by |
|---|---|---|---|
| **Confirm signup** | `Confirm Your Email - Stellar` | `static/signup-email.html` | `setupSingleUser()` |
| **Change Email Address** | `Confirm Your New Email - Stellar` | `static/change-email.html` | `changeSingleUserEmail()` |
| **Magic Link** | `Verify Your Device - Stellar` | `static/device-verification-email.html` | `sendDeviceVerification()` via `signInWithOtp()` |

## Setup

1. Go to your Supabase dashboard > **Authentication** > **Email Templates**
2. For each template:
   - Select the template by name
   - Set the **Subject** as listed above
   - Copy the contents of the corresponding HTML file into the **Body** field
3. Ensure your `confirmRedirectPath` in the engine config matches the path in the templates (`/confirm` by default)

## Design notes

- All templates use **solid `background-color` values** instead of CSS gradients or `background-image` for Gmail compatibility (Gmail strips most `background-image` and `linear-gradient()` properties).
- **No SVG** -- Gmail strips all `<svg>` elements. The logo uses a text-based checkmark (`&#10003; Stellar`) instead.
- **VML fallbacks** for Outlook (`<!--[if mso]>` blocks) provide rounded buttons and card backgrounds.
- The device verification email uses a **green accent** (button + top bar) to visually distinguish it as a security action.
- The `type` URL parameter matches what the `/confirm` page and engine expect:
  - Signup: `type=signup`
  - Email change: `type=email_change`
  - Device verification: `type=email` (matches `verifyDeviceCode()` which uses `type: 'email'`)
