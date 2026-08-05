namespace TorrServerManager;

internal static class AppPaths
{
    public static readonly string InstallDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs", "TorrServer");

    public static readonly string StateDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TorrServer");

    public static readonly string DataDirectory = Path.Combine(StateDirectory, "data");
    public static readonly string LogsDirectory = Path.Combine(StateDirectory, "logs");
    public static readonly string ServerExecutable = Path.Combine(InstallDirectory, "TorrServer.exe");
    public static readonly string ManagerExecutable = Path.Combine(InstallDirectory, "TorrServerManager.exe");
    public static readonly string ServerLog = Path.Combine(LogsDirectory, "server.log");
    public static readonly string ManagerLog = Path.Combine(LogsDirectory, "manager.log");
    public static readonly string PluginHubConfig = Path.Combine(StateDirectory, "lampa-plugins.json");
    public static readonly string PluginCacheDirectory = Path.Combine(StateDirectory, "lampa-cache");
    public static readonly string PluginCacheState = Path.Combine(PluginCacheDirectory, "cache-state.json");
    public static readonly string JackettDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Jackett");
    public static readonly string JackettExecutable = Path.Combine(JackettDirectory, "App", "JackettConsole.exe");
    public static readonly string JackettIndexersDirectory = Path.Combine(JackettDirectory, "Indexers");
    public const int Port = 8090;
    public const int PluginHubPort = 8095;
    public const int JackettPort = 9117;

    public static void EnsureDirectories()
    {
        Directory.CreateDirectory(InstallDirectory);
        Directory.CreateDirectory(StateDirectory);
        Directory.CreateDirectory(DataDirectory);
        Directory.CreateDirectory(LogsDirectory);
        Directory.CreateDirectory(PluginCacheDirectory);
    }
}
