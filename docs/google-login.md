# Google sign-in and app launch

The iOS app opens the configured service directly, without a connection form or hamburger menu. WKWebView uses persistent website storage, so the HttpOnly session cookie survives relaunches. Passwords are never bundled or saved by the app. An expired or revoked session returns to sign-in.

The simulator configuration points at http://localhost:3002. For device or production builds set JOURNAL_SERVER_URL in Xcode build settings to the deployed HTTPS root URL. Set it once for the distributed build; users do not enter it. The checked-in Debug device build uses a local Wi-Fi server address; replace it for your network. Release builds require a configured service URL. The launch view uses the approved Tradeform mint TF logo and tagline: Turn trades into progress.

## Configure Google later

Create a Google Cloud OAuth web client for the backend web service. Configure the consent screen and authorized callback. For local development the redirect is http://localhost:3002/api/oauth/google/callback. For production use the exact corresponding HTTPS URL on your owned domain.

Provide GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI to the API environment using your secure secret configuration. Keep the client secret out of the repository and client bundle. Restart the service after configuration. The provider endpoint enables the Google button only when configuration is complete. Local email sessions remain available. Supabase-managed authentication currently disables this separate Google adapter; use its provider integration when migrating auth.

Browser flow uses authorization code, PKCE, state, nonce, verified email, and signed Google identity tokens with checked issuer/audience/expiry. Google accounts are identified by immutable provider subject. Existing email accounts require deliberate linking; this implementation refuses automatic email-based merging.

On iOS, the app opens the service login through ASWebAuthenticationSession. The backend callback returns a 60-second single-use ticket bound to a device-held verifier, not a reusable session token. The app consumes that ticket into a persistent HttpOnly WebKit session. Cancellation leaves the login screen intact. Only openid/email/profile are requested; Google access tokens and refresh tokens are not persisted.

Local security and database tests cover missing configuration, state rejection, PKCE generation, nonce/verified-email requirements, identity stability, prevention of automatic account takeover, device binding, expiration and concurrent replay of native transfers. Real Google consent and sign-in cannot be verified until credentials are added. Before distribution, run a real Google web and simulator/device sign-in, cancellation, relaunch and logout smoke test. Schedule cleanup of expired session/transfer rows and ensure infrastructure does not log authorization-code callback query strings.
