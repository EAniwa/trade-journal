# Tradeform for iOS

SwiftUI shell for the Tradeform workspace, iOS 17+. The app opens its bundled service URL directly. No address entry or navigation menu appears on sign-in. After email or Google sign-in, the workspace provides its own navigation. Persistent WebKit cookies remember a valid session; passwords are not bundled or stored by the app. Google uses ASWebAuthenticationSession and a single-use device-bound transfer back into WebKit.

## Development

Start the PostgreSQL/API/web stack using the repository scripts described in docs/scaling.md. Open TradeJournal.xcodeproj and build the TradeJournal scheme. Simulator builds default to http://localhost:3002. Device builds need JOURNAL_SERVER_URL set to the deployed HTTPS root URL in build settings. Set that once before distribution; users never configure it. The permanent production hosting URL has not yet been selected.

The display name is Tradeform. The bundle identifier remains com.tradejournal.ios to preserve installed data. Assets.xcassets contains the approved mint TF icon and splash mark. LaunchScreen.storyboard displays the logo, name and tagline immediately; the SwiftUI loading view continues that branding until the workspace is ready.

## Verification

Run xcodebuild for the TradeJournal scheme with an iOS simulator destination and CODE_SIGNING_ALLOWED=NO. ServerAddressTests.swift checks configured URL validation and origin restrictions. Before distribution, smoke-test first launch, email registration, sign-in, relaunch with a saved session, logout, expired sessions, Google success/cancellation, CSV selection, download sharing and loss/recovery of connectivity on a physical device.

Google configuration and credential setup are documented in docs/google-login.md. Real Google sign-in needs the OAuth client credentials; the current preview shows a clear unavailable state until configured. Email verification and password recovery are not implemented yet. The app requires a reachable backend and is not an offline native rewrite. App Store signing and submission are separate work.
