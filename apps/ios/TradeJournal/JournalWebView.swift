import SwiftUI
import WebKit
import AuthenticationServices
import CryptoKit
import Security

struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL
}

@MainActor
final class JournalBrowser: ObservableObject {
    weak var webView: WKWebView?
    @Published var loading = false
    @Published var canGoBack = false
    @Published var error: String?
    @Published var authError: String?
    @Published var downloadError: String?
    @Published var shareFile: SharedFile?

    func navigate(to path: String, server: URL) {
        error = nil
        webView?.load(URLRequest(url: server.appendingPathComponent(path)))
    }

    func reload() {
        error = nil
        webView?.reload()
    }
}

struct JournalWebView: UIViewRepresentable {
    @ObservedObject var browser: JournalBrowser
    let server: URL

    func makeCoordinator() -> Coordinator { Coordinator(browser: browser, server: server) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = false
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.refresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        browser.webView = webView
        webView.load(URLRequest(url: server))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.stopLoading()
        uiView.navigationDelegate = nil
        uiView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, ASWebAuthenticationPresentationContextProviding {
        let browser: JournalBrowser
        let server: URL
        private var downloads: [ObjectIdentifier: URL] = [:]

        init(browser: JournalBrowser, server: URL) {
            self.browser = browser
            self.server = server
        }

        private var authenticationSession: ASWebAuthenticationSession?
        private var nativeVerifier: String?
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            browser.webView?.window ?? ASPresentationAnchor()
        }
        private func googleSignIn(_ url: URL) {
            guard authenticationSession == nil else { return }
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                browser.authError = "Please try signing in again."; return
            }
            let verifier = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            nativeVerifier = verifier
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "nativeChallenge", value: challenge)]
            let session = ASWebAuthenticationSession(url: components.url!, callbackURLScheme: "tradejournal") { [weak self] callback, error in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.authenticationSession = nil
                    defer { self.nativeVerifier = nil }
                    if let error {
                        if (error as NSError).code != ASWebAuthenticationSessionError.canceledLogin.rawValue { self.browser.authError = "Please try signing in again." }
                        return
                    }
                    guard let callback, callback.host == "auth", let ticket = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "ticket" })?.value, let verifier = self.nativeVerifier else {
                        self.browser.authError = "Please try signing in again."; return
                    }
                    var request = URLRequest(url: self.server.appendingPathComponent("api/oauth/google/native"))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.httpBody = try? JSONSerialization.data(withJSONObject: ["ticket": ticket, "verifier": verifier])
                    self.browser.webView?.load(request)
                }
            }
            session.presentationContextProvider = self
            authenticationSession = session
            if !session.start() { authenticationSession = nil; nativeVerifier = nil; browser.authError = "Please try signing in again." }
        }

        @objc func refresh(_ control: UIRefreshControl) { browser.reload() }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            browser.loading = true
            browser.error = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(webView) }

        private func finish(_ webView: WKWebView) {
            browser.loading = false
            browser.canGoBack = webView.canGoBack
            webView.scrollView.refreshControl?.endRefreshing()
        }

        private func fail(_ webView: WKWebView, error: Error) {
            finish(webView)
            if (error as NSError).code != NSURLErrorCancelled {
                browser.error = "Check that your server is running and reachable from this device. " + error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(webView, error: error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(webView, error: error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            let trusted = ServerAddress.sameOrigin(url, server)
            if trusted && url.path == "/api/oauth/google/start" {
                decisionHandler(.cancel); googleSignIn(url); return
            }
            if action.shouldPerformDownload && (trusted || url.scheme == "blob") {
                decisionHandler(.download)
            } else if trusted || url.scheme == "blob" || url.absoluteString == "about:blank" {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                // Links outside the journal open in the system browser; they never inherit its cookies.
                if action.navigationType == .linkActivated,
                   ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") {
                    UIApplication.shared.open(url)
                }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .download)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            finish(webView)
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            finish(webView)
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let name = (suggestedFilename as NSString).lastPathComponent
                let destination = directory.appendingPathComponent(name.isEmpty ? "journal-export" : name)
                downloads[ObjectIdentifier(download)] = destination
                completionHandler(destination)
            } catch {
                browser.downloadError = error.localizedDescription
                completionHandler(nil)
            }
        }

        func downloadDidFinish(_ download: WKDownload) {
            if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
                browser.shareFile = SharedFile(url: url)
            }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
                try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            }
            browser.downloadError = error.localizedDescription
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if action.targetFrame == nil, let url = action.request.url {
                if ServerAddress.sameOrigin(url, server) { webView.load(action.request) }
                else if ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            }
            return nil
        }

        private func present(_ alert: UIAlertController, from webView: WKWebView) -> Bool {
            guard var presenter = webView.window?.rootViewController else { return false }
            while let presented = presenter.presentedViewController { presenter = presented }
            presenter.present(alert, animated: true)
            return true
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: "Tradeform", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            if !present(alert, from: webView) { completionHandler() }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: "Tradeform", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "Continue", style: .default) { _ in completionHandler(true) })
            if !present(alert, from: webView) { completionHandler(false) }
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: "Tradeform", message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "Save", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
            if !present(alert, from: webView) { completionHandler(nil) }
        }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        return controller
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
