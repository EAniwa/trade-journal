import Foundation

enum ServerAddress {
    /// The server routes are rooted at /; reverse proxies must expose that root.
    static func parse(_ text: String) -> URL? {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else { return nil }
        // Cleartext is supported only for development and private network servers.
        if scheme == "http" && !isLocal(host) { return nil }
        parts.scheme = scheme
        parts.path = ""
        return parts.url
    }

    static func isLocal(_ host: String) -> Bool {
        let host = host.lowercased()
        if host == "localhost" || host == "[::1]" || host == "::1" || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 10 || octets[0] == 127
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 172 && (16...31).contains(octets[1]))
    }

    static func sameOrigin(_ url: URL, _ server: URL) -> Bool {
        func port(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }
        return url.scheme?.lowercased() == server.scheme?.lowercased()
            && url.host?.lowercased() == server.host?.lowercased() && port(url) == port(server)
    }
}
