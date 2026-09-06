// Windows UI Automation transport. This file deliberately targets the system
// .NET Framework compiler, so desktop users do not need a downloaded runtime.
// Field values are never read, logged, passed through argv or put on clipboard.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

internal sealed class Stop : Exception {
    internal readonly string Status;
    internal readonly string Reason;
    internal Stop(string reason, bool unavailable = false) { Reason = reason; Status = unavailable ? "unavailable" : "failed"; }
}
public sealed class Field {
    public string fieldKey { get; set; }
    public string id { get; set; }
}
public sealed class Step {
    public string targetOrigin { get; set; }
    public string targetUrlSha256 { get; set; }
    public Field[] fields { get; set; }
    public string submitId { get; set; }
}
public sealed class Request {
    public string command { get; set; }
    public string clientFamily { get; set; }
    public Step[] steps { get; set; }
    public Dictionary<string, string> values { get; set; }
}
internal static class Signature {
    // WinVerifyTrust validates the Authenticode chain, not just an unverified
    // certificate subject copied from the PE file. No UI, user certificate
    // prompt or signature-exception path is allowed.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileInfo {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string path;
        public IntPtr handle;
        public IntPtr knownSubject;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TrustData {
        public uint cbStruct;
        public IntPtr policy;
        public IntPtr sip;
        public uint uiChoice;
        public uint revocation;
        public uint unionChoice;
        public IntPtr file;
        public uint stateAction;
        public IntPtr state;
        public IntPtr url;
        public uint providerFlags;
        public uint uiContext;
    }
    [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int WinVerifyTrust(IntPtr hwnd, [In] ref Guid action, [In, Out] ref TrustData data);
    internal static bool Trusted(string file, string family) {
        FileInfo info = new FileInfo { cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo)), path = file };
        IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
        Marshal.StructureToPtr(info, pointer, false);
        var data = new TrustData {
            cbStruct = (uint)Marshal.SizeOf(typeof(TrustData)), uiChoice = 2,
            unionChoice = 1, file = pointer, stateAction = 1,
            // Cache-only chain retrieval avoids a secret operation depending on
            // certificate-network availability. OS trust is still mandatory.
            providerFlags = 0x1000
        };
        Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try {
            if (WinVerifyTrust(new IntPtr(-1), ref action, ref data) != 0) return false;
            using (var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(file))) {
                string publisher = certificate.GetNameInfo(X509NameType.SimpleName, false);
                string product = FileVersionInfo.GetVersionInfo(file).ProductName ?? "";
                return family == "codex"
                    ? new[] { "OpenAI OpCo, LLC", "OpenAI, L.L.C.", "OpenAI" }.Contains(publisher)
                        && new[] { "Codex", "OpenAI Codex" }.Contains(product)
                    : new[] { "Anthropic PBC", "Anthropic, PBC" }.Contains(publisher) && product == "Claude";
            }
        } catch { return false; }
        finally {
            data.stateAction = 2;
            WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            Marshal.DestroyStructure(pointer, typeof(FileInfo));
            Marshal.FreeHGlobal(pointer);
        }
    }
}

internal sealed class Session {
    private readonly Process process;
    private readonly DateTime startedAt;
    private readonly AutomationElement window;
    private readonly AutomationElement container;
    private readonly Step[] steps;
    private AutomationElement document;
    private AutomationElement[] targets;
    private AutomationElement button;
    private bool used;
    private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    private static bool Equal(AutomationElement a, AutomationElement b) {
        return a != null && b != null && Automation.Compare(a, b);
    }
    private static bool IsDocument(AutomationElement element) { return element.Current.ControlType == ControlType.Document; }
    internal static string DocumentUrl(AutomationElement element) {
        object pattern;
        // Chromium exposes the top document URL via ValuePattern. Never query
        // this property for Edit controls, including username/password fields.
        return IsDocument(element) && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)
            ? ((ValuePattern)pattern).Current.Value : null;
    }
    internal static bool Matches(string value, Step step) {
        Uri uri;
        if (value == null || !Uri.TryCreate(value, UriKind.Absolute, out uri)
            || uri.Scheme != "https" || uri.UserInfo.Length != 0
            || uri.GetLeftPart(UriPartial.Authority) != step.targetOrigin) return false;
        using (var hash = SHA256.Create()) {
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant()
                == step.targetUrlSha256;
        }
    }
    private static List<AutomationElement> Walk(AutomationElement root, bool stopAtDocuments) {
        var result = new List<AutomationElement>();
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(root);
        var clock = Stopwatch.StartNew();
        var walker = TreeWalker.RawViewWalker;
        while (queue.Count > 0) {
            if (queue.Count + result.Count > 12000 || clock.Elapsed.TotalSeconds > 12) throw new Stop("timeout");
            var current = queue.Dequeue();
            result.Add(current);
            if (stopAtDocuments && !Equal(current, root) && IsDocument(current)) continue;
            for (var child = walker.GetFirstChild(current); child != null; child = walker.GetNextSibling(child)) queue.Enqueue(child);
        }
        return result;
    }
    private static bool Belongs(AutomationElement child, AutomationElement ancestor) {
        var cursor = child;
        for (int i = 0; i < 128 && cursor != null; i++, cursor = TreeWalker.RawViewWalker.GetParent(cursor)) {
            if (Equal(cursor, ancestor)) return true;
        }
        return false;
    }
    private static List<AutomationElement> Documents(AutomationElement root) {
        return Walk(root, false).Where(element => {
            if (!IsDocument(element) || element.Current.IsOffscreen || element.Current.BoundingRectangle.IsEmpty) return false;
            if (DocumentUrl(element) == null) return false;
            var parent = TreeWalker.RawViewWalker.GetParent(element);
            for (int i = 0; i < 128 && parent != null; i++, parent = TreeWalker.RawViewWalker.GetParent(parent)) {
                string parentUrl = DocumentUrl(parent);
                if (parentUrl != null && (parentUrl.StartsWith("https://", StringComparison.Ordinal)
                    || parentUrl.StartsWith("http://", StringComparison.Ordinal))) return false;
            }
            return true;
        }).ToList();
    }
    private static AutomationElement Find(List<AutomationElement> nodes, AutomationElement doc, string id, bool isButton) {
        var candidates = nodes.Where(element => element.Current.AutomationId == id && Belongs(element, doc)).ToArray();
        if (candidates.Length == 0) throw new Stop("field_not_found");
        if (candidates.Length != 1) throw new Stop("field_ambiguous");
        var target = candidates[0];
        var state = target.Current;
        if (!state.IsEnabled || state.IsOffscreen || state.BoundingRectangle.IsEmpty
            || !state.BoundingRectangle.IntersectsWith(doc.Current.BoundingRectangle)) throw new Stop("field_not_found");
        object pattern;
        if (isButton) {
            if (state.ControlType != ControlType.Button) throw new Stop("field_selector_invalid");
            if (!target.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new Stop("field_write_failed");
        } else {
            if (state.ControlType != ControlType.Edit) throw new Stop("field_selector_invalid");
            if (!target.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)
                || ((ValuePattern)pattern).Current.IsReadOnly) throw new Stop("field_write_failed");
        }
        return target;
    }
    private static AutomationElement[] Controls(AutomationElement doc, Step step, out AutomationElement button) {
        var nodes = Walk(doc, true);
        var result = step.fields.Select(field => Find(nodes, doc, field.id, false)).ToArray();
        button = step.submitId == null ? null : Find(nodes, doc, step.submitId, true);
        return result;
    }
    internal Session(Request request) {
        if (request.clientFamily != "codex" && request.clientFamily != "claude-code") throw new Stop("client_unsupported", true);
        if (request.steps == null || request.steps.Length == 0 || request.steps.Length > 10
            || request.steps.Any(step => step.fields == null || step.fields.Length == 0 || step.fields.Length > 50))
            throw new Stop("adapter_error");
        steps = request.steps;
        var names = request.clientFamily == "codex" ? new[] { "Codex", "ChatGPT" } : new[] { "Claude" };
        var applications = Process.GetProcesses().Where(candidate => names.Contains(candidate.ProcessName, StringComparer.OrdinalIgnoreCase)).ToArray();
        var candidates = new List<Tuple<Process, AutomationElement, AutomationElement>>();
        int exposed = 0, windowCount = 0;
        foreach (var application in applications) {
            var handles = new List<IntPtr>();
            EnumWindows((handle, parameter) => {
                uint pid; GetWindowThreadProcessId(handle, out pid);
                if (pid == application.Id && IsWindowVisible(handle)) handles.Add(handle);
                return true;
            }, IntPtr.Zero);
            if (handles.Count == 0) continue; // Ignore Chromium background helpers.
            windowCount += handles.Count;
            if (!Signature.Trusted(application.MainModule.FileName, request.clientFamily)) throw new Stop("adapter_error");
            foreach (var handle in handles) {
                var root = AutomationElement.FromHandle(handle);
                var documents = Documents(root);
                exposed += documents.Count;
                foreach (var doc in documents.Where(doc => Matches(DocumentUrl(doc), steps[0])))
                    candidates.Add(Tuple.Create(application, root, doc));
            }
        }
        if (windowCount == 0) throw new Stop("application_unavailable", true);
        if (candidates.Count == 0) {
            if (exposed == 0) throw new Stop("accessibility_unavailable", true);
            throw new Stop("target_url_changed");
        }
        if (candidates.Count != 1) throw new Stop("field_ambiguous");
        process = candidates[0].Item1;
        startedAt = process.StartTime;
        window = candidates[0].Item2;
        document = candidates[0].Item3;
        container = TreeWalker.RawViewWalker.GetParent(document);
        if (container == null || Documents(container).Count != 1) throw new Stop("accessibility_unavailable", true);
        targets = Controls(document, steps[0], out button);
    }
    private void CheckDocument(Step step) {
        if (process.HasExited || process.StartTime != startedAt || !Belongs(container, window) || !Belongs(document, container)
            || !Matches(DocumentUrl(document), step)) throw new Stop("target_url_changed");
    }
    internal void Fill(Dictionary<string, string> values) {
        if (used) throw new Stop("adapter_error");
        used = true;
        var keys = steps.SelectMany(step => step.fields.Select(field => field.fieldKey)).ToArray();
        if (keys.Distinct().Count() != keys.Length || !new HashSet<string>(keys).SetEquals(values.Keys)
            || values.Values.Any(value => value == null)) throw new Stop("adapter_error");
        for (int index = 0; index < steps.Length; index++) {
            var step = steps[index];
            if (index > 0) {
                var clock = Stopwatch.StartNew();
                AutomationElement next = null;
                while (clock.Elapsed.TotalSeconds < 20) {
                    var documents = Documents(container).ToArray();
                    if (documents.Length > 1) throw new Stop("field_ambiguous");
                    if (documents.Length == 1) {
                        var candidate = documents[0];
                        if (!Matches(DocumentUrl(candidate), step) && !Matches(DocumentUrl(candidate), steps[index - 1]))
                            throw new Stop("target_url_changed");
                        if (Matches(DocumentUrl(candidate), step)) {
                            try {
                                AutomationElement ignored;
                                Controls(candidate, step, out ignored);
                                next = candidate;
                                break;
                            } catch (Stop error) { if (error.Reason != "field_not_found") throw; }
                        }
                    }
                    Thread.Sleep(100);
                }
                if (next == null) throw new Stop("timeout");
                document = next;
                targets = Controls(document, step, out button);
            }
            CheckDocument(step);
            AutomationElement currentButton;
            var current = Controls(document, step, out currentButton);
            if (current.Length != targets.Length || !current.Zip(targets, Equal).All(equal => equal)
                || !(button == null && currentButton == null || Equal(button, currentButton))) throw new Stop("field_write_failed");
            for (int field = 0; field < targets.Length; field++) {
                CheckDocument(step);
                AutomationElement freshButton;
                var fresh = Controls(document, step, out freshButton);
                if (fresh.Length != targets.Length || !fresh.Zip(targets, Equal).All(equal => equal)) throw new Stop("field_write_failed");
                var target = targets[field];
                if (!Belongs(target, document) || target.Current.AutomationId != step.fields[field].id) throw new Stop("field_write_failed");
                var pattern = (ValuePattern)target.GetCurrentPattern(ValuePattern.Pattern);
                if (pattern.Current.IsReadOnly) throw new Stop("field_write_failed");
                // Direct element setter: changing keyboard focus cannot redirect
                // the value into an unrelated window or the assistant prompt.
                pattern.SetValue(values[step.fields[field].fieldKey]);
            }
            if (button != null) {
                CheckDocument(step);
                AutomationElement freshButton;
                Controls(document, step, out freshButton);
                if (!Equal(button, freshButton) || !Belongs(button, document)) throw new Stop("field_write_failed");
                ((InvokePattern)button.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
            }
        }
    }
}
internal static class Program {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    private static void Reply(string status, string reason = null) {
        var reply = new Dictionary<string, string> { { "status", status } };
        if (reason != null) reply.Add("reasonCode", reason);
        Console.WriteLine(Json.Serialize(reply));
        Console.Out.Flush();
    }
    [MTAThread]
    private static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        using (var lifetime = new Timer(state => Environment.Exit(1), null, 120000, Timeout.Infinite)) {
            Session session = null;
            for (int count = 0; count < 2; count++) {
                string line = Console.ReadLine();
                if (line == null) return 0;
                try {
                    if (Encoding.UTF8.GetByteCount(line) > 8 * 1024 * 1024) throw new Stop("adapter_error");
                    var request = Json.Deserialize<Request>(line);
                    if (request.command == "prepare" && session == null) {
                        session = new Session(request);
                        Reply("ready");
                    } else if (request.command == "fill" && session != null && request.values != null) {
                        session.Fill(request.values);
                        Reply("succeeded");
                        return 0;
                    } else throw new Stop("adapter_error");
                } catch (Stop error) { Reply(error.Status, error.Reason); return 1; }
                  catch { Reply("failed", "adapter_error"); return 1; }
            }
        }
        return 0;
    }
}
