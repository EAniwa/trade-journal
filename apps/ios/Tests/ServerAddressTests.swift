import Foundation

@main
struct ServerAddressTests {
    static func main() {
        let valid = ["https://journal.example.com", " https://journal.example.com/\n", "http://localhost:3000", "http://192.168.1.20:3000", "http://10.0.0.2", "http://172.16.0.1", "http://journal.local:3000"]
        let invalid = ["", "journal.example.com", "ftp://journal.example.com", "http://public.example.com", "https://user:password@example.com", "https://example.com/journal", "https://example.com?key=secret", "https://example.com#fragment", "http://192.168.1.999", "http://172.32.0.1", "https://example.com:0", "https://example.com:65536"]
        for input in valid { precondition(ServerAddress.parse(input) != nil, "Rejected valid URL: \(input)") }
        for input in invalid { precondition(ServerAddress.parse(input) == nil, "Accepted invalid URL: \(input)") }
        let server = URL(string: "https://journal.example.com")!
        precondition(ServerAddress.sameOrigin(URL(string: "https://journal.example.com:443/trades")!, server))
        precondition(!ServerAddress.sameOrigin(URL(string: "https://journal.example.com:444")!, server))
        precondition(!ServerAddress.sameOrigin(URL(string: "http://journal.example.com")!, server))
        precondition(!ServerAddress.sameOrigin(URL(string: "https://evil.example.com")!, server))
        print("Passed \(valid.count + invalid.count + 4) server address and origin checks")
    }
}
