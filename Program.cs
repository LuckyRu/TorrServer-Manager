using TorrServerManager.Infrastructure;
using TorrServerManager.UI;

namespace TorrServerManager;

internal static class Program
{
    private const string MutexName = @"Local\TorrServerManager.SingleInstance";
    private const string ShowEventName = @"Local\TorrServerManager.Show";

    [STAThread]
    private static void Main(string[] args)
    {
        using var mutex = new Mutex(true, MutexName, out var createdNew);
        if (!createdNew)
        {
            SignalExistingInstance();
            return;
        }

        ApplicationConfiguration.Initialize();

        Application.ThreadException += (_, e) => AppLog.Write(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            AppLog.Write(e.ExceptionObject as Exception ?? new Exception(e.ExceptionObject?.ToString()));

        var background = args.Any(a => a.Equals("--background", StringComparison.OrdinalIgnoreCase));
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        using var form = new MainForm(background);
        _ = form.Handle;

        var eventThread = new Thread(() =>
        {
            while (!form.IsDisposed)
            {
                showEvent.WaitOne();
                if (form.IsDisposed)
                    break;

                try
                {
                    form.BeginInvoke(form.ShowFromTray);
                }
                catch (InvalidOperationException)
                {
                    break;
                }
            }
        })
        {
            IsBackground = true,
            Name = "TorrServerManager.ShowEvent"
        };
        eventThread.Start();

        Application.Run(form);
        showEvent.Set();
    }

    private static void SignalExistingInstance()
    {
        try
        {
            using var showEvent = EventWaitHandle.OpenExisting(ShowEventName);
            showEvent.Set();
        }
        catch
        {
            // The first instance may still be creating its window.
        }
    }
}
