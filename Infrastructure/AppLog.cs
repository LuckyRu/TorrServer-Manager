namespace TorrServerManager.Infrastructure;

internal static class AppLog
{
    private static readonly object Sync = new();

    public static void Write(Exception exception) => Write(exception.ToString());

    public static void Write(string message)
    {
        try
        {
            AppPaths.EnsureDirectories();
            lock (Sync)
            {
                File.AppendAllText(
                    AppPaths.ManagerLog,
                    $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never terminate the tray application.
        }
    }
}
