import SwiftUI

@main
struct TradeJournalApp: App {
    var body: some Scene {
        WindowGroup { JournalRootView().tint(Color(red: 0.44, green: 0.86, blue: 0.75)).preferredColorScheme(.dark) }
    }
}

struct JournalRootView: View {
    // The deployment URL belongs to the app configuration, not an onboarding form.
    private var configuredServer: URL? {
        ServerAddress.parse(Bundle.main.object(forInfoDictionaryKey: "JournalServerURL") as? String ?? "")
    }
    var body: some View {
        if let server = configuredServer {
            JournalView(server: server)
        } else {
            ContentUnavailableView("App configuration unavailable", systemImage: "network", description: Text("This build needs its service configuration. Please use the latest app build."))
        }
    }
}

struct JournalView: View {
    let server: URL
    @StateObject private var browser = JournalBrowser()
    @State private var opening = true
    var body: some View {
        ZStack {
            Color(red: 0.04, green: 0.06, blue: 0.09).ignoresSafeArea()
            JournalWebView(browser: browser, server: server)
            if opening && browser.error == nil {
                VStack(spacing: 18) {
                    Image("TradeformMark").resizable().scaledToFit().frame(width: 88, height: 88).clipShape(RoundedRectangle(cornerRadius: 22))
                    Text("Tradeform").font(.system(size: 29, weight: .semibold))
                    Text("Turn trades into progress.").font(.subheadline).foregroundStyle(.secondary)
                    ProgressView().padding(.top, 18).accessibilityLabel("Opening your workspace")
                }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(red: 0.04, green: 0.06, blue: 0.09))
            }
            if let error = browser.error {
                ContentUnavailableView {
                    Label("Can't connect right now", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("Your workspace will be here when the connection returns. " + error)
                } actions: {
                    Button("Try again") { browser.reload() }.buttonStyle(.borderedProminent)
                }.background(Color(red: 0.04, green: 0.06, blue: 0.09))
            }
        }
        .onChange(of: browser.loading) { _, loading in if !loading { opening = false } }
        .sheet(item: $browser.shareFile) { ShareSheet(url: $0.url) }
        .alert("Sign-in couldn't finish", isPresented: Binding(get: { browser.authError != nil }, set: { if !$0 { browser.authError = nil } })) {
            Button("OK") { browser.authError = nil }
        } message: { Text(browser.authError ?? "") }
        .alert("Download failed", isPresented: Binding(get: { browser.downloadError != nil }, set: { if !$0 { browser.downloadError = nil } })) {
            Button("OK") { browser.downloadError = nil }
        } message: { Text(browser.downloadError ?? "") }
    }
}
