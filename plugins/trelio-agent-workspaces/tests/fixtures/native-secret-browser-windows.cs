// Runs only on a disposable Windows test desktop. The production helper has
// no test flag or arbitrary-process option. This harness tests its UIA core on
// an unsigned synthetic WPF document; signed-application admission is separate.
using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Interop;

public sealed class FixturePage : Border {
    public string Url = "https://login.example.test/account";
    protected override AutomationPeer OnCreateAutomationPeer() { return new PagePeer(this); }
}
internal sealed class PagePeer : FrameworkElementAutomationPeer, IValueProvider {
    internal PagePeer(FixturePage owner) : base(owner) {}
    protected override AutomationControlType GetAutomationControlTypeCore() { return AutomationControlType.Document; }
    protected override string GetClassNameCore() { return "TrelioFixtureDocument"; }
    public override object GetPattern(PatternInterface pattern) { return pattern == PatternInterface.Value ? this : base.GetPattern(pattern); }
    bool IValueProvider.IsReadOnly { get { return true; } }
    string IValueProvider.Value { get { return ((FixturePage)Owner).Url; } }
    void IValueProvider.SetValue(string value) { throw new InvalidOperationException(); }
}
internal static class Harness {
    static Window window;
    static FixturePage page;
    static StackPanel panel;
    static TextBox username, password, distraction;
    static Button submit;
    static int submitted;
    static IntPtr handle;
    static Type sessionType;
    static AutomationElement root, document;
    static Step step;
    static readonly BindingFlags Hidden = BindingFlags.NonPublic | BindingFlags.Instance;
    static readonly BindingFlags Static = BindingFlags.NonPublic | BindingFlags.Static;
    static object Call(string name, params object[] args) { return sessionType.GetMethod(name, Static).Invoke(null, args); }
    static void Set(object instance, string name, object value) { sessionType.GetField(name, Hidden).SetValue(instance, value); }
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static IDisposable Lease() { return (IDisposable)Activator.CreateInstance(typeof(Step).Assembly.GetType("NativeLease"), true); }
    static string ProbeLease() {
        using (var child = Process.Start(new ProcessStartInfo {
            FileName = typeof(Step).Assembly.Location, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true,
        })) {
            // Unknown client cannot inspect any app, even when the lease is
            // available. The busy/available distinction tests only the mutex.
            // Match the shipping Node pipe byte-for-byte. Framework's
            // StandardInput StreamWriter can prepend the console encoding's
            // UTF-8 BOM on Windows runners, which is not part of this JSONL
            // protocol and would fail parsing before the lease is consulted.
            byte[] request = new UTF8Encoding(false).GetBytes("{\"command\":\"prepare\",\"clientFamily\":\"other\"}\n");
            child.StandardInput.BaseStream.Write(request, 0, request.Length);
            child.StandardInput.BaseStream.Flush();
            string result = child.StandardOutput.ReadLine();
            Check(child.WaitForExit(10000), "lease probe timeout");
            if (result == null || result.Contains("adapter_error")) {
                using (var diagnostic = Process.Start(new ProcessStartInfo {
                    FileName = Assembly.GetExecutingAssembly().Location, Arguments = "--probe-native-session",
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
                })) {
                    string reason = diagnostic.StandardOutput.ReadLine();
                    Check(diagnostic.WaitForExit(10000), "lease diagnostic timeout");
                    // Only an exception type/native fixed reason is returned.
                    throw new Exception("lease probe protocol rejected; constructor: " + reason);
                }
            }
            return result;
        }
    }
    static string Reason(Exception error) {
        while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException;
        var reason = error.GetType().GetField("Reason", BindingFlags.Instance | BindingFlags.NonPublic);
        return reason == null ? error.GetType().Name : (string)reason.GetValue(error);
    }
    static object Prepared() {
        var instance = FormatterServices.GetUninitializedObject(sessionType);
        var args = new object[] { document, step, null };
        var targets = sessionType.GetMethod("Controls", Static).Invoke(null, args);
        var process = Process.GetCurrentProcess();
        Set(instance, "process", process);
        Set(instance, "startedAt", process.StartTime);
        Set(instance, "window", root);
        Set(instance, "container", TreeWalker.RawViewWalker.GetParent(document));
        Set(instance, "document", document);
        Set(instance, "steps", new[] { step });
        Set(instance, "targets", targets);
        Set(instance, "button", args[2]);
        return instance;
    }
    static void Fill(object instance) {
        sessionType.GetMethod("Fill", Hidden).Invoke(instance, new object[] {
            new System.Collections.Generic.Dictionary<string, string> {
                { "username", "synthetic-native-user" }, { "password", "synthetic-native-password" },
            },
        });
    }
    static TextBox Input(string id) {
        var input = new TextBox { Height = 35, Margin = new Thickness(5) };
        AutomationProperties.SetAutomationId(input, id);
        return input;
    }
    [MTAThread]
    static int Main(string[] args) {
        // Process.StandardInput initializes an AutoFlush StreamWriter from
        // Console.InputEncoding on .NET Framework. Set a BOM-free encoding
        // before creating children: even accessing its BaseStream can already
        // emit the writer's preamble under a UTF-8 Windows console.
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--probe-native-session") {
            try {
                Activator.CreateInstance(typeof(Step).Assembly.GetType("Session"), Hidden, null,
                    new object[] { new Request { command = "prepare", clientFamily = "other" } }, null);
                Console.WriteLine("unexpected_acceptance");
            } catch (Exception error) { Console.WriteLine(Reason(error)); }
            return 0;
        }
        if (args.Length == 1 && args[0] == "--hold-native-lease") {
            using (Lease()) { Console.WriteLine("held"); Console.Out.Flush(); Thread.Sleep(Timeout.Infinite); }
            return 0;
        }
        var ready = new ManualResetEvent(false);
        Exception uiError = null;
        var thread = new Thread(() => {
            try {
                window = new Window { Title = "Trelio synthetic UIA fixture", Width = 500, Height = 400 };
                page = new FixturePage();
                panel = new StackPanel();
                username = Input("username"); password = Input("password"); distraction = Input("distraction");
                submit = new Button { Content = "Synthetic submit", Height = 35, Margin = new Thickness(5) };
                AutomationProperties.SetAutomationId(submit, "login");
                submit.Click += (sender, e) => submitted++;
                username.TextChanged += (sender, e) => distraction.Focus();
                panel.Children.Add(username); panel.Children.Add(password); panel.Children.Add(distraction); panel.Children.Add(submit);
                page.Child = panel; window.Content = page;
                window.Show(); window.Activate();
                handle = new WindowInteropHelper(window).Handle;
                ready.Set();
                System.Windows.Threading.Dispatcher.Run();
            } catch (Exception error) { uiError = error; ready.Set(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.IsBackground = true; thread.Start();
        try {
            Check(ready.WaitOne(10000), "fixture window timeout");
            if (uiError != null) throw uiError;
            sessionType = typeof(Step).Assembly.GetType("Session");
            root = AutomationElement.FromHandle(handle);
            // The production traversal must see the same Document/Value pattern
            // that Chromium exposes, and find only controls under that document.
            var clock = Stopwatch.StartNew();
            do {
                var documents = (System.Collections.Generic.List<AutomationElement>)Call("Documents", root);
                if (documents.Count > 0) { document = documents.Single(); break; }
                Thread.Sleep(100);
            } while (clock.Elapsed.TotalSeconds < 10);
            Check(document != null, "UIA document unavailable");
            string url = "https://login.example.test/account";
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(url))).Replace("-", "").ToLowerInvariant();
            step = new Step {
                targetOrigin = "https://login.example.test", targetUrlSha256 = hash, submitId = "login",
                fields = new[] { new Field { fieldKey = "username", id = "username" }, new Field { fieldKey = "password", id = "password" } },
            };

            var stale = Prepared();
            window.Dispatcher.Invoke(new Action(() => page.Url += "?changed"));
            try { Fill(stale); throw new Exception("wrong URL was accepted"); }
            catch (Exception error) { Check(Reason(error) == "target_url_changed", "wrong URL must fail closed"); }
            window.Dispatcher.Invoke(new Action(() => {
                Check(username.Text == "" && password.Text == "", "wrong URL wrote a field");
                page.Url = url; password.IsReadOnly = true;
            }));
            try { Prepared(); throw new Exception("readonly field was accepted"); }
            catch (Exception error) { Check(Reason(error) == "field_write_failed", "readonly must fail before fill"); }
            TextBox duplicate = null;
            window.Dispatcher.Invoke(new Action(() => { password.IsReadOnly = false; duplicate = Input("username"); panel.Children.Insert(0, duplicate); window.UpdateLayout(); }));
            try { Prepared(); throw new Exception("duplicate id was accepted"); }
            catch (Exception error) { Check(Reason(error) == "field_ambiguous", "ambiguous id must fail before fill"); }
            window.Dispatcher.Invoke(new Action(() => { panel.Children.Remove(duplicate); window.UpdateLayout(); }));
            var session = Prepared();
            Fill(session);
            // InvokePattern is explicitly asynchronous. A successful dispatch
            // can return before the provider processes its queued click; wait
            // for the observable effect instead of assuming synchronous UI.
            var submitClock = Stopwatch.StartNew();
            while (submitClock.Elapsed.TotalSeconds < 5
                && (int)window.Dispatcher.Invoke(new Func<int>(() => submitted)) == 0) Thread.Sleep(25);
            window.Dispatcher.Invoke(new Action(() => {
                Check(username.Text == "synthetic-native-user", "username setter failed");
                Check(password.Text == "synthetic-native-password", "password setter failed");
                Check(distraction.Text == "", "focus redirected a secret");
                Check(submitted == 1, "explicit submit must run exactly once");
            }));
            try { Fill(session); throw new Exception("repeated fill was accepted"); }
            catch (Exception error) { Check(Reason(error) == "adapter_error", "session must be one-use"); }
            using (Lease()) Check(ProbeLease().Contains("browser_unavailable"), "parallel helper acquired an owned lease");
            using (var holder = Process.Start(new ProcessStartInfo {
                FileName = Assembly.GetExecutingAssembly().Location, Arguments = "--hold-native-lease",
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
            })) {
                Check(holder.StandardOutput.ReadLine() == "held", "lease holder did not start");
                Check(ProbeLease().Contains("browser_unavailable"), "parallel helper ignored the lease");
                holder.Kill(); holder.WaitForExit();
            }
            Check(ProbeLease().Contains("client_unsupported"), "crashed helper left a stale lease");
            Console.WriteLine("Windows UIA: exact document, readonly, ambiguity, focus-independent setters, explicit submit and one-use passed.");
            return 0;
        } catch (Exception error) {
            // Synthetic fixtures have no real credentials. Still print only a
            // bounded assertion/type, never a field, DOM dump or request.
            Console.Error.WriteLine("Windows UIA fixture failed: " + (error.GetType() == typeof(Exception) ? error.Message : Reason(error)));
            return 1;
        } finally {
            if (window != null) window.Dispatcher.Invoke(new Action(() => window.Close()));
        }
    }
}
