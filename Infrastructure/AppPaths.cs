namespace TorrServerManager.Infrastructure;

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
    public static readonly string GStreamerDirectory = Path.Combine(InstallDirectory, "gstreamer", "1.0", "mingw_x86_64");
    public static readonly string ManagerExecutable = Path.Combine(InstallDirectory, "TorrServerManager.exe");
    public static readonly string ServerLog = Path.Combine(LogsDirectory, "server.log");
    public static readonly string ManagerLog = Path.Combine(LogsDirectory, "manager.log");
    // Паника Go и сообщения нативного слоя не попадают в собственный лог TorrServer: они уходят
    // в stderr, который иначе теряется вместе с процессом.
    public static readonly string ServerCrashLog = Path.Combine(LogsDirectory, "server-crash.log");
    public static readonly string PluginHubConfig = Path.Combine(StateDirectory, "lampa-plugins.json");
    // Правила поиска, которые пользователь пополняет без пересборки: студии перевода и их
    // написания. Формат и поведение при отсутствии файла —
    // docs/system-design/torrent-mod-search-architecture.md §4.
    public static readonly string SearchRulesFile = Path.Combine(DataDirectory, "search-rules.json");
    public static readonly string PluginCacheDirectory = Path.Combine(StateDirectory, "lampa-cache");
    public static readonly string PluginCacheState = Path.Combine(PluginCacheDirectory, "cache-state.json");
    public static readonly string LampaAppDirectory = Path.Combine(StateDirectory, "lampa-app");
    public static readonly string LampaAppState = Path.Combine(StateDirectory, "lampa-app-state.json");
    public static readonly string BuiltInPluginDevOverrideDirectory = Path.Combine(StateDirectory, "dev-plugins");
    public static readonly string JackettDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Jackett");
    public static readonly string JackettAppDirectory = Path.Combine(JackettDirectory, "App");
    public static readonly string JackettExecutable = Path.Combine(JackettAppDirectory, "JackettConsole.exe");
    public static readonly string JackettIndexersDirectory = Path.Combine(JackettDirectory, "Indexers");
    public static readonly string JackettServerConfig = Path.Combine(JackettDirectory, "ServerConfig.json");
    public static readonly string FlareSolverrBaseDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FlareSolverr");
    public static readonly string FlareSolverrDirectory = Path.Combine(FlareSolverrBaseDirectory, "flaresolverr");
    public static readonly string FlareSolverrExecutable = Path.Combine(FlareSolverrDirectory, "flaresolverr.exe");
    public const int Port = 8090;
    public const int PluginHubPort = 8095;
    public const int JackettPort = 9117;
    public const int FlareSolverrPort = 8191;

    public static void EnsureDirectories()
    {
        Directory.CreateDirectory(InstallDirectory);
        Directory.CreateDirectory(StateDirectory);
        Directory.CreateDirectory(DataDirectory);
        Directory.CreateDirectory(LogsDirectory);
        Directory.CreateDirectory(PluginCacheDirectory);
    }
}
