// Generic AX adapter. No focus, clipboard, keyboard simulation, screenshots,
// browser runtime sockets or AXValue reads on fields. Values arrive only after
// successful prepare, through the owning bridge's inherited anonymous stdin.
import Foundation
import AppKit
import ApplicationServices
import Security
import CryptoKit

enum Stop: Error {
    case failed(String)
    case unavailable(String)
}
struct Field: Decodable { let fieldKey: String; let id: String }
struct Step: Decodable {
    let targetOrigin: String
    let targetUrlSha256: String
    let fields: [Field]
    let submitId: String?
}
struct Request: Decodable {
    let command: String
    let clientFamily: String?
    let steps: [Step]?
    let values: [String: String]?
}
func reply(_ status: String, _ reason: String? = nil) {
    var object = ["status": status]
    if let reason = reason { object["reasonCode"] = reason }
    if let data = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func text(_ element: AXUIElement, _ name: String) -> String? {
    return attribute(element, name) as? String
}
func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    return attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}
func rectangle(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &extent),
          extent.width > 0, extent.height > 0 else { return nil }
    return CGRect(origin: point, size: extent)
}
func documentURL(_ element: AXUIElement) -> String? {
    // AXURL is read only for a WebArea, never an input's value.
    guard text(element, kAXRoleAttribute) == "AXWebArea" else { return nil }
    if let url = attribute(element, "AXURL") as? URL { return url.absoluteString }
    return text(element, "AXURL")
}
func matches(_ raw: String?, _ step: Step) -> Bool {
    guard let raw = raw, let url = URL(string: raw), url.scheme == "https",
          url.user == nil, url.password == nil, let host = url.host else { return false }
    let port = url.port.map { $0 == 443 ? "" : ":" + String($0) } ?? ""
    let origin = "https://" + (host.contains(":") && !host.hasPrefix("[") ? "[" + host + "]" : host) + port
    let digest = SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    return origin == step.targetOrigin && digest == step.targetUrlSha256
}
func belongs(_ child: AXUIElement, to ancestor: AXUIElement) -> Bool {
    var cursor: AXUIElement? = child
    for _ in 0..<128 {
        guard let current = cursor else { return false }
        if CFEqual(current, ancestor) { return true }
        cursor = elementAttribute(current, kAXParentAttribute)
    }
    return false
}
func visible(_ element: AXUIElement, in document: AXUIElement) -> Bool {
    guard (attribute(element, "AXHidden") as? Bool) != true,
          let frame = rectangle(element), let page = rectangle(document),
          frame.intersects(page) else { return false }
    return true
}

// Bounded traversal ignores nested WebAreas when resolving fields. An iframe
// may expose an identical DOM id but is never part of the grant's top document.
func walk(_ root: AXUIElement, stopAtWebArea: Bool = false) throws -> [AXUIElement] {
    var queue = [root]
    var result: [AXUIElement] = []
    var index = 0
    let deadline = Date().addingTimeInterval(12)
    while index < queue.count {
        if queue.count > 12000 || Date() > deadline { throw Stop.failed("timeout") }
        let current = queue[index]
        index += 1
        result.append(current)
        if stopAtWebArea && !CFEqual(root, current) && text(current, kAXRoleAttribute) == "AXWebArea" { continue }
        queue.append(contentsOf: children(current))
    }
    return result
}

final class Session {
    let application: NSRunningApplication
    let appElement: AXUIElement
    let steps: [Step]
    let window: AXUIElement
    let container: AXUIElement
    var document: AXUIElement
    var targets: [AXUIElement]
    var button: AXUIElement?
    var used = false
    let requirement: SecRequirement

    static func trust(_ application: NSRunningApplication, _ requirement: SecRequirement) -> Bool {
        var code: SecCode?
        let attributes = [kSecGuestAttributePid as String: application.processIdentifier] as CFDictionary
        return SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess
            && code != nil && SecCodeCheckValidity(code!, SecCSFlags(), requirement) == errSecSuccess
    }
    static func documents(_ root: AXUIElement) throws -> [AXUIElement] {
        return try walk(root).filter { candidate in
            guard documentURL(candidate) != nil, rectangle(candidate) != nil,
                  (attribute(candidate, "AXHidden") as? Bool) != true else { return false }
            // A top-level embedded view can be nested under the Electron shell,
            // but a web document nested in another HTTPS document is an iframe.
            var cursor = elementAttribute(candidate, kAXParentAttribute)
            for _ in 0..<128 {
                guard let parent = cursor else { return true }
                if let url = documentURL(parent), url.hasPrefix("https://") || url.hasPrefix("http://") { return false }
                cursor = elementAttribute(parent, kAXParentAttribute)
            }
            return false
        }
    }
    static func controls(_ document: AXUIElement, _ step: Step) throws -> ([AXUIElement], AXUIElement?) {
        let nodes = try walk(document, stopAtWebArea: true)
        func find(_ id: String, button: Bool) throws -> AXUIElement {
            let found = nodes.filter { text($0, "AXDOMIdentifier") == id && belongs($0, to: document) }
            guard !found.isEmpty else { throw Stop.failed("field_not_found") }
            guard found.count == 1 else { throw Stop.failed("field_ambiguous") }
            let target = found[0]
            guard (attribute(target, kAXEnabledAttribute) as? Bool) == true, visible(target, in: document) else {
                throw Stop.failed("field_not_found")
            }
            if button {
                guard text(target, kAXRoleAttribute) == kAXButtonRole else { throw Stop.failed("field_selector_invalid") }
                var actions: CFArray?
                guard AXUIElementCopyActionNames(target, &actions) == .success,
                      (actions as? [String])?.contains(kAXPressAction) == true else { throw Stop.failed("field_write_failed") }
            } else {
                guard ["AXTextField", "AXTextArea"].contains(text(target, kAXRoleAttribute) ?? "") else {
                    throw Stop.failed("field_selector_invalid")
                }
                var writable = DarwinBoolean(false)
                guard AXUIElementIsAttributeSettable(target, kAXValueAttribute as CFString, &writable) == .success,
                      writable.boolValue else { throw Stop.failed("field_write_failed") }
            }
            return target
        }
        let fields = try step.fields.map { try find($0.id, button: false) }
        let button = try step.submitId.map { try find($0, button: true) }
        return (fields, button)
    }
    init(_ request: Request) throws {
        guard AXIsProcessTrusted() else { throw Stop.unavailable("access_required") }
        let bundle: String
        let team: String
        switch request.clientFamily {
        case "codex": bundle = "com.openai.codex"; team = "2DC432GLL2"
        case "claude-code": bundle = "com.anthropic.claudefordesktop"; team = "Q6L2SF6YDW"
        default: throw Stop.unavailable("client_unsupported")
        }
        guard let steps = request.steps, !steps.isEmpty, steps.count <= 10,
              steps.allSatisfy({ !$0.fields.isEmpty && $0.fields.count <= 50 }) else { throw Stop.failed("adapter_error") }
        self.steps = steps
        var requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"" + bundle + "\" and certificate leaf[subject.OU] = \"" + team + "\""
        guard SecRequirementCreateWithString(rule as CFString, SecCSFlags(), &requirement) == errSecSuccess,
              let requirement = requirement else { throw Stop.failed("adapter_error") }
        self.requirement = requirement
        let applications = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle }
        guard !applications.isEmpty else { throw Stop.unavailable("application_unavailable") }
        var candidates: [(NSRunningApplication, AXUIElement, AXUIElement)] = []
        var exposedDocuments = 0
        for app in applications {
            guard Session.trust(app, requirement) else { throw Stop.failed("adapter_error") }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax, 1)
            // Documented Electron switch; it exposes the accessibility tree but
            // does not grant TCC permission or change any browser/site policy.
            AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            let docs = try Session.documents(ax)
            exposedDocuments += docs.count
            for doc in docs where matches(documentURL(doc), steps[0]) { candidates.append((app, ax, doc)) }
        }
        if candidates.isEmpty {
            if exposedDocuments == 0 { throw Stop.unavailable("accessibility_unavailable") }
            throw Stop.failed("target_url_changed")
        }
        guard candidates.count == 1 else { throw Stop.failed("field_ambiguous") }
        (application, appElement, document) = candidates[0]
        guard let window = elementAttribute(document, kAXWindowAttribute) else { throw Stop.failed("adapter_error") }
        self.window = window
        // Pin the native view containing this single document, not the entire
        // app window. A later step must not jump to a different browser tab.
        guard let container = elementAttribute(document, kAXParentAttribute),
              try Session.documents(container).count == 1 else { throw Stop.unavailable("accessibility_unavailable") }
        self.container = container
        (targets, button) = try Session.controls(document, steps[0])
    }
    func checkDocument(_ step: Step) throws {
        guard !application.isTerminated, Session.trust(application, requirement),
              belongs(container, to: window), belongs(document, to: container),
              matches(documentURL(document), step) else { throw Stop.failed("target_url_changed") }
    }
    func fill(_ values: [String: String]) throws {
        guard !used else { throw Stop.failed("adapter_error") }
        used = true
        let keys = steps.flatMap { $0.fields.map { $0.fieldKey } }
        guard keys.count == Set(keys).count, Set(values.keys) == Set(keys) else { throw Stop.failed("adapter_error") }
        for (index, step) in steps.enumerated() {
            if index > 0 {
                let deadline = Date().addingTimeInterval(20)
                var found: AXUIElement?
                while Date() < deadline {
                    let docs = try Session.documents(container)
                    if docs.count > 1 { throw Stop.failed("field_ambiguous") }
                    if let next = docs.first {
                        if !matches(documentURL(next), step) && !matches(documentURL(next), steps[index - 1]) {
                            throw Stop.failed("target_url_changed")
                        }
                        if matches(documentURL(next), step) {
                            do {
                                _ = try Session.controls(next, step)
                                found = next
                                break
                            } catch Stop.failed("field_not_found") {
                                // Same-document/SPA transitions can expose the
                                // destination URL before its fields are ready.
                            }
                        }
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                }
                guard let next = found else { throw Stop.failed("timeout") }
                document = next
                (targets, button) = try Session.controls(document, step)
            }
            try checkDocument(step)
            let (current, currentButton) = try Session.controls(document, step)
            guard zip(targets, current).allSatisfy({ CFEqual($0.0, $0.1) }),
                  targets.count == current.count,
                  (button == nil && currentButton == nil) || (button != nil && currentButton != nil && CFEqual(button!, currentButton!))
            else { throw Stop.failed("field_write_failed") }
            for (field, target) in zip(step.fields, targets) {
                try checkDocument(step)
                let (fresh, _) = try Session.controls(document, step)
                guard zip(fresh, targets).allSatisfy({ CFEqual($0.0, $0.1) }), fresh.count == targets.count else {
                    throw Stop.failed("field_write_failed")
                }
                guard belongs(target, to: document), text(target, "AXDOMIdentifier") == field.id,
                      let value = values[field.fieldKey] else { throw Stop.failed("field_write_failed") }
                // Chromium's AX kSetValue dispatches input/change events. It
                // writes the bound element directly even if focus moves.
                guard AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString) == .success else {
                    throw Stop.failed("field_write_failed")
                }
            }
            if let button = button {
                try checkDocument(step)
                let (_, freshButton) = try Session.controls(document, step)
                guard freshButton != nil, CFEqual(button, freshButton!), belongs(button, to: document),
                      AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
                    throw Stop.failed("field_write_failed")
                }
            }
        }
    }
}

// A fixed wall-clock lifetime limits an abandoned stdin session. Unexpected
// errors are always replaced with safe reason codes, never localized OS text.
let lifetime = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
lifetime.schedule(deadline: .now() + 120)
lifetime.setEventHandler { exit(1) }
lifetime.resume()
var session: Session?
var requestCount = 0
while let line = readLine(strippingNewline: true) {
    do {
        guard line.utf8.count <= 8 * 1024 * 1024, requestCount < 2 else { throw Stop.failed("adapter_error") }
        requestCount += 1
        let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
        if request.command == "prepare", session == nil {
            session = try Session(request)
            reply("ready")
        } else if request.command == "fill", let current = session, let values = request.values {
            try current.fill(values)
            reply("succeeded")
            break
        } else { throw Stop.failed("adapter_error") }
    } catch Stop.unavailable(let reason) { reply("unavailable", reason); break }
      catch Stop.failed(let reason) { reply("failed", reason); break }
      catch { reply("failed", "adapter_error"); break }
}
