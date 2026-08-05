using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TorrServerManager;

internal sealed class ManagedPlugin
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "Новый плагин";
    public string Url { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public string Category { get; set; } = "Другое";
}

internal sealed class PluginHubConfiguration
{
    public string SearchMode { get; set; } = "both";
    public List<ManagedPlugin> Plugins { get; set; } = [];
}

internal sealed class PluginCacheRecord
{
    public string SourceUrl { get; set; } = "";
    public string FileName { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public DateTimeOffset? DownloadedAtUtc { get; set; }
    public DateTimeOffset? LastCheckedAtUtc { get; set; }
    public string LastError { get; set; } = "";
    public string ETag { get; set; } = "";
    public DateTimeOffset? LastModifiedUtc { get; set; }
    public string PreviousFileName { get; set; } = "";
    public string PreviousSha256 { get; set; } = "";
    public DateTimeOffset? PreviousDownloadedAtUtc { get; set; }
}

internal sealed class PluginCacheState
{
    public DateTimeOffset? LastRefreshUtc { get; set; }
    public Dictionary<string, PluginCacheRecord> Plugins { get; set; } = [];
}

internal sealed class PluginApiView
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Url { get; init; } = "";
    public bool Enabled { get; init; }
    public string Category { get; init; } = "";
    public string? LocalPath { get; init; }
    public bool Cached { get; init; }
    public string Sha256 { get; init; } = "";
    public DateTimeOffset? DownloadedAtUtc { get; init; }
    public DateTimeOffset? LastCheckedAtUtc { get; init; }
    public string CacheError { get; init; } = "";
    public bool HasPreviousCopy { get; init; }
    public bool IsBuiltIn { get; init; }
}

internal sealed record PluginRefreshResult(string Id, string Name, bool Success, bool Updated, string Message);

internal sealed class LampaAppState
{
    public string Version { get; set; } = "";
    public string Hash { get; set; } = "";
    public DateTimeOffset? DownloadedAtUtc { get; set; }
    public DateTimeOffset? LastCheckedAtUtc { get; set; }
    public string LastError { get; set; } = "";
}

internal sealed record LampaAppStatus(
    bool Installed,
    string Version,
    DateTimeOffset? DownloadedAtUtc,
    DateTimeOffset? LastCheckedAtUtc,
    string LastError);

internal sealed class PluginHub : IDisposable
{
    private const long MaximumPluginBytes = 12L * 1024 * 1024;
    private const long MaximumLampaAppBytes = 200L * 1024 * 1024;
    private const string LampaAppRepo = "yumata/lampa";
    private const string LampaAppBranch = "main";
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromHours(6);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly object configLock = new();
    private readonly object cacheStateLock = new();
    private readonly object lampaAppStateLock = new();
    private readonly HttpListener listener = new();
    private readonly CancellationTokenSource cancellation = new();
    private readonly SemaphoreSlim refreshLock = new(1, 1);
    private readonly SemaphoreSlim lampaAppRefreshLock = new(1, 1);
    private readonly HttpClient httpClient;
    private Task? listenerTask;
    private Task? refreshTask;
    private PluginHubConfiguration configuration;
    private PluginCacheState cacheState;
    private LampaAppState lampaAppState;

    public PluginHub()
    {
        AppPaths.EnsureDirectories();
        configuration = LoadConfiguration();
        BuiltInPlugins.Ensure(configuration);
        SaveConfiguration(configuration);
        cacheState = LoadCacheState();
        lampaAppState = LoadLampaAppState();

        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 8,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            PooledConnectionLifetime = TimeSpan.FromMinutes(10)
        };
        httpClient = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(25)
        };
        httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager");
        httpClient.DefaultRequestHeaders.Accept.ParseAdd("application/javascript, text/javascript, */*;q=0.8");
    }

    public bool IsRunning => listener.IsListening;
    public string LocalPanelUrl => $"http://127.0.0.1:{AppPaths.PluginHubPort}/";
    public string LanLoaderUrl => $"http://{ServerController.GetPreferredLanAddress()}:{AppPaths.PluginHubPort}/lampa.js";
    public string LampaAppUrl => $"http://{ServerController.GetPreferredLanAddress()}:{AppPaths.PluginHubPort}/app/";

    public void Start()
    {
        if (listener.IsListening)
            return;

        listener.Prefixes.Add($"http://+:{AppPaths.PluginHubPort}/");
        listener.Start();
        listenerTask = Task.Run(() => ListenAsync(cancellation.Token));
        refreshTask = Task.Run(() => RunRefreshLoopAsync(cancellation.Token));
        AppLog.Write($"Lampa Plugin Hub started at {LanLoaderUrl}.");
    }

    private async Task RunRefreshLoopAsync(CancellationToken cancellationToken)
    {
        await RefreshAllSafelyAsync(cancellationToken);
        await RefreshLampaAppSafelyAsync(cancellationToken);
        using var timer = new PeriodicTimer(RefreshInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                await RefreshAllSafelyAsync(cancellationToken);
                await RefreshLampaAppSafelyAsync(cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    private async Task RefreshAllSafelyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await RefreshAllAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception exception)
        {
            AppLog.Write(exception);
        }
    }

    private async Task RefreshLampaAppSafelyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await RefreshLampaAppAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception exception)
        {
            AppLog.Write(exception);
        }
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException) { break; }
            catch (HttpListenerException) when (!listener.IsListening) { break; }
            catch (ObjectDisposedException) { break; }

            _ = Task.Run(() => HandleAsync(context), cancellationToken);
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        try
        {
            AddCommonHeaders(context.Response);
            var path = context.Request.Url?.AbsolutePath.TrimEnd('/') ?? "";

            if (context.Request.HttpMethod == "OPTIONS")
            {
                context.Response.StatusCode = (int)HttpStatusCode.NoContent;
                return;
            }

            if (context.Request.HttpMethod == "GET" && path is "" or "/")
            {
                await WriteTextAsync(context.Response, BuildPanelHtml(), "text/html; charset=utf-8");
                return;
            }

            if (context.Request.HttpMethod == "GET" && path.Equals("/health", StringComparison.OrdinalIgnoreCase))
            {
                var plugins = BuildPluginViews(Snapshot());
                await WriteJsonAsync(context.Response, new
                {
                    ok = true,
                    service = "TorrServerManager Lampa Plugin Hub",
                    loader = LanLoaderUrl,
                    torrServer = $"http://{ServerController.GetPreferredLanAddress()}:{AppPaths.Port}",
                    enabledPlugins = plugins.Count(plugin => plugin.Enabled),
                    cachedPlugins = plugins.Count(plugin => plugin.Enabled && plugin.Cached),
                    failedPlugins = plugins.Count(plugin => plugin.Enabled && !plugin.Cached),
                    lastRefreshUtc = GetLastRefreshUtc()
                });
                return;
            }

            if (context.Request.HttpMethod == "GET" && path.Equals("/api/config", StringComparison.OrdinalIgnoreCase))
            {
                await WriteConfigurationAsync(context.Response);
                return;
            }

            if (context.Request.HttpMethod == "GET" && path.Equals("/api/smart-search", StringComparison.OrdinalIgnoreCase))
            {
                var query = context.Request.QueryString["query"]?.Trim() ?? "";
                if (query.Length is < 2 or > 200)
                    throw new InvalidDataException("Поисковый запрос должен содержать от 2 до 200 символов.");
                await WriteRutrackerSearchAsync(context.Response, query);
                return;
            }

            if (context.Request.HttpMethod == "POST" && path.Equals("/api/config", StringComparison.OrdinalIgnoreCase))
            {
                EnsureLoopback(context.Request);
                if (context.Request.ContentLength64 > 512 * 1024)
                    throw new InvalidDataException("Слишком большой запрос.");

                var updated = await JsonSerializer.DeserializeAsync<PluginHubConfiguration>(
                    context.Request.InputStream,
                    JsonOptions,
                    cancellation.Token);
                if (updated is null)
                    throw new InvalidDataException("Пустая конфигурация.");

                BuiltInPlugins.Ensure(updated);
                Validate(updated);
                SaveConfiguration(updated);
                var refreshed = await RefreshAllAsync(cancellation.Token);
                await WriteJsonAsync(context.Response, new
                {
                    ok = true,
                    refresh = refreshed,
                    plugins = BuildPluginViews(Snapshot())
                });
                return;
            }

            if (context.Request.HttpMethod == "POST" && path.Equals("/api/plugins/refresh", StringComparison.OrdinalIgnoreCase))
            {
                EnsureLoopback(context.Request);
                var refreshed = await RefreshAllAsync(cancellation.Token);
                await WriteJsonAsync(context.Response, new
                {
                    ok = true,
                    refresh = refreshed,
                    plugins = BuildPluginViews(Snapshot())
                });
                return;
            }

            if (context.Request.HttpMethod == "GET" && path.Equals("/lampa.js", StringComparison.OrdinalIgnoreCase))
            {
                await WriteTextAsync(context.Response, LoaderScript, "application/javascript; charset=utf-8");
                return;
            }

            if (context.Request.HttpMethod == "GET" && path.StartsWith("/plugins/", StringComparison.OrdinalIgnoreCase))
            {
                await WriteCachedPluginAsync(context.Response, path);
                return;
            }

            if (context.Request.HttpMethod == "GET" &&
                (path.Equals("/app", StringComparison.OrdinalIgnoreCase) || path.StartsWith("/app/", StringComparison.OrdinalIgnoreCase)))
            {
                var relative = path.Length > "/app/".Length ? path["/app/".Length..] : "";
                await WriteLampaAppFileAsync(context.Response, relative);
                return;
            }

            await WriteErrorAsync(context.Response, HttpStatusCode.NotFound, "Страница не найдена.");
        }
        catch (UnauthorizedAccessException exception)
        {
            await TryWriteErrorAsync(context.Response, HttpStatusCode.Forbidden, exception.Message);
        }
        catch (JsonException exception)
        {
            await TryWriteErrorAsync(context.Response, HttpStatusCode.BadRequest, exception.Message);
        }
        catch (InvalidDataException exception)
        {
            await TryWriteErrorAsync(context.Response, HttpStatusCode.BadRequest, exception.Message);
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            await TryWriteErrorAsync(context.Response, HttpStatusCode.InternalServerError, "Внутренняя ошибка Plugin Hub.");
        }
        finally
        {
            try { context.Response.Close(); } catch { }
        }
    }

    private async Task WriteConfigurationAsync(HttpListenerResponse response)
    {
        await WriteJsonAsync(response, new
        {
            torrServerUrl = $"http://{ServerController.GetPreferredLanAddress()}:{AppPaths.Port}",
            searchMode = Snapshot().SearchMode,
            plugins = BuildPluginViews(Snapshot()),
            cache = new
            {
                mode = "local-only",
                refreshHours = RefreshInterval.TotalHours,
                lastRefreshUtc = GetLastRefreshUtc()
            }
        });
    }

    private async Task WriteRutrackerSearchAsync(HttpListenerResponse response, string query)
    {
        var serverConfigPath = Path.Combine(AppPaths.JackettDirectory, "ServerConfig.json");
        if (!File.Exists(serverConfigPath))
            throw new InvalidDataException("Jackett ещё не настроен.");

        using var config = JsonDocument.Parse(await File.ReadAllTextAsync(serverConfigPath, cancellation.Token));
        if (!config.RootElement.TryGetProperty("APIKey", out var apiKeyProperty))
            throw new InvalidDataException("В конфигурации Jackett отсутствует API key.");
        var apiKey = apiKeyProperty.GetString();
        if (string.IsNullOrWhiteSpace(apiKey))
            throw new InvalidDataException("В конфигурации Jackett отсутствует API key.");

        var url = $"http://127.0.0.1:{AppPaths.JackettPort}/api/v2.0/indexers/rutracker-ru/results" +
            $"?apikey={Uri.EscapeDataString(apiKey)}&Query={Uri.EscapeDataString(query)}";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var result = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation.Token);
        result.EnsureSuccessStatusCode();
        var json = await result.Content.ReadAsStringAsync(cancellation.Token);
        using var document = JsonDocument.Parse(json);
        if (!document.RootElement.TryGetProperty("Results", out var results) || results.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("Jackett вернул некорректный ответ RuTracker.");

        await WriteTextAsync(response, results.GetRawText(), "application/json; charset=utf-8");
    }

    private async Task WriteCachedPluginAsync(HttpListenerResponse response, string path)
    {
        var filePart = path["/plugins/".Length..];
        if (!filePart.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Некорректный адрес локального плагина.");

        var cacheKey = filePart[..^3];
        if (cacheKey.Length != 24 || cacheKey.Any(character => !Uri.IsHexDigit(character)))
            throw new InvalidDataException("Некорректный адрес локального плагина.");

        var plugin = Snapshot().Plugins.FirstOrDefault(item =>
            CacheKey(item.Id).Equals(cacheKey, StringComparison.OrdinalIgnoreCase));
        if (plugin is null || !TryGetCurrentCacheFile(plugin, out var filePath, out var record))
        {
            await WriteErrorAsync(response, HttpStatusCode.NotFound, "Локальная копия плагина ещё не готова.");
            return;
        }

        response.ContentType = "application/javascript; charset=utf-8";
        response.ContentLength64 = new FileInfo(filePath).Length;
        response.Headers["ETag"] = $"\"{record.Sha256}\"";
        response.Headers["X-Plugin-Source"] = Uri.EscapeDataString(plugin.Url);
        await using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        await stream.CopyToAsync(response.OutputStream, cancellation.Token);
    }

    private async Task WriteLampaAppFileAsync(HttpListenerResponse response, string relativePath)
    {
        relativePath = Uri.UnescapeDataString(relativePath);
        if (relativePath.Length == 0)
            relativePath = "index.html";

        if (relativePath.Contains("..", StringComparison.Ordinal) || Path.IsPathRooted(relativePath))
        {
            await WriteErrorAsync(response, HttpStatusCode.BadRequest, "Некорректный путь.");
            return;
        }

        var root = Path.GetFullPath(AppPaths.LampaAppDirectory) + Path.DirectorySeparatorChar;
        var fullPath = Path.GetFullPath(Path.Combine(AppPaths.LampaAppDirectory, relativePath));
        if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            await WriteErrorAsync(response, HttpStatusCode.NotFound, "Приложение Lampa ещё не загружено или файл не найден.");
            return;
        }

        if (relativePath.Replace('\\', '/').Equals("msx/start.json", StringComparison.OrdinalIgnoreCase))
        {
            var domain = $"{ServerController.GetPreferredLanAddress()}:{AppPaths.PluginHubPort}/app";
            var text = (await File.ReadAllTextAsync(fullPath, cancellation.Token)).Replace("{domain}", domain, StringComparison.Ordinal);
            await WriteTextAsync(response, text, "application/json; charset=utf-8");
            return;
        }

        response.ContentType = GetLampaAppContentType(fullPath);
        response.ContentLength64 = new FileInfo(fullPath).Length;
        await using var stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        await stream.CopyToAsync(response.OutputStream, cancellation.Token);
    }

    private static string GetLampaAppContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" or ".mjs" => "application/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".webmanifest" => "application/manifest+json",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".ico" => "image/x-icon",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".ttf" => "font/ttf",
        ".eot" => "application/vnd.ms-fontobject",
        ".mp3" => "audio/mpeg",
        ".mp4" => "video/mp4",
        ".xml" => "application/xml",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream"
    };

    private PluginHubConfiguration Snapshot()
    {
        lock (configLock)
        {
            var json = JsonSerializer.Serialize(configuration, JsonOptions);
            return JsonSerializer.Deserialize<PluginHubConfiguration>(json, JsonOptions)!;
        }
    }

    private PluginHubConfiguration LoadConfiguration()
    {
        try
        {
            if (!File.Exists(AppPaths.PluginHubConfig))
                return new PluginHubConfiguration();
            var loaded = JsonSerializer.Deserialize<PluginHubConfiguration>(
                File.ReadAllText(AppPaths.PluginHubConfig),
                JsonOptions) ?? new PluginHubConfiguration();
            Validate(loaded);
            return loaded;
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            return new PluginHubConfiguration();
        }
    }

    private PluginCacheState LoadCacheState()
    {
        try
        {
            if (!File.Exists(AppPaths.PluginCacheState))
                return new PluginCacheState();
            return JsonSerializer.Deserialize<PluginCacheState>(
                File.ReadAllText(AppPaths.PluginCacheState),
                JsonOptions) ?? new PluginCacheState();
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            return new PluginCacheState();
        }
    }

    private void SaveConfiguration(PluginHubConfiguration updated)
    {
        AppPaths.EnsureDirectories();
        WriteJsonAtomically(AppPaths.PluginHubConfig, updated);
        lock (configLock)
            configuration = updated;
        AppLog.Write($"Saved Lampa Plugin Hub configuration with {updated.Plugins.Count} plugin(s).");
    }

    private void SaveCacheState()
    {
        lock (cacheStateLock)
            WriteJsonAtomically(AppPaths.PluginCacheState, cacheState);
    }

    private static void WriteJsonAtomically<T>(string path, T value)
    {
        var temporary = path + ".tmp";
        var json = JsonSerializer.Serialize(value, JsonOptions);
        File.WriteAllText(temporary, json, new UTF8Encoding(false));
        File.Move(temporary, path, overwrite: true);
    }

    private static void Validate(PluginHubConfiguration candidate)
    {
        if (candidate.SearchMode is not ("rutor" or "torznab" or "both"))
            throw new InvalidDataException("Неизвестный режим поиска TorrServer.");
        if (candidate.Plugins.Count > 50)
            throw new InvalidDataException("Допускается не более 50 плагинов.");

        var urls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var plugin in candidate.Plugins)
        {
            plugin.Id = string.IsNullOrWhiteSpace(plugin.Id) ? Guid.NewGuid().ToString("N") : plugin.Id.Trim();
            plugin.Name = string.IsNullOrWhiteSpace(plugin.Name) ? "Без названия" : plugin.Name.Trim();
            plugin.Category = string.IsNullOrWhiteSpace(plugin.Category) ? "Другое" : plugin.Category.Trim();
            plugin.Url = plugin.Url.Trim();

            if (plugin.Id.Length > 100 || plugin.Name.Length > 100 || plugin.Category.Length > 50 || plugin.Url.Length > 2048)
                throw new InvalidDataException("Идентификатор, название, категория или URL плагина слишком длинные.");
            if (!BuiltInPlugins.IsBuiltIn(plugin.Url) &&
                (!Uri.TryCreate(plugin.Url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")))
                throw new InvalidDataException($"Некорректный URL плагина «{plugin.Name}».");
            if (!ids.Add(plugin.Id))
                throw new InvalidDataException($"Идентификатор плагина «{plugin.Name}» добавлен дважды.");
            if (!urls.Add(plugin.Url))
                throw new InvalidDataException($"URL плагина «{plugin.Name}» добавлен дважды.");
        }
    }

    private List<PluginApiView> BuildPluginViews(PluginHubConfiguration snapshot)
    {
        return snapshot.Plugins.Select(plugin =>
        {
            var cached = TryGetCurrentCacheFile(plugin, out _, out var record);
            return new PluginApiView
            {
                Id = plugin.Id,
                Name = plugin.Name,
                Url = plugin.Url,
                Enabled = plugin.Enabled,
                Category = plugin.Category,
                LocalPath = cached ? $"/plugins/{CacheKey(plugin.Id)}.js" : null,
                Cached = cached,
                Sha256 = cached ? record.Sha256 : "",
                DownloadedAtUtc = cached ? record.DownloadedAtUtc : null,
                LastCheckedAtUtc = record.LastCheckedAtUtc,
                CacheError = record.LastError,
                HasPreviousCopy = !string.IsNullOrWhiteSpace(record.PreviousFileName) &&
                    File.Exists(GetSafeCachePath(record.PreviousFileName)),
                IsBuiltIn = BuiltInPlugins.IsBuiltIn(plugin.Url)
            };
        }).ToList();
    }

    private bool TryGetCurrentCacheFile(ManagedPlugin plugin, out string filePath, out PluginCacheRecord record)
    {
        lock (cacheStateLock)
        {
            if (!cacheState.Plugins.TryGetValue(plugin.Id, out var found))
            {
                filePath = "";
                record = new PluginCacheRecord();
                return false;
            }

            record = CloneCacheRecord(found);
        }

        if (!record.SourceUrl.Equals(plugin.Url, StringComparison.OrdinalIgnoreCase) ||
            string.IsNullOrWhiteSpace(record.FileName) || string.IsNullOrWhiteSpace(record.Sha256))
        {
            filePath = "";
            return false;
        }

        filePath = GetSafeCachePath(record.FileName);
        return File.Exists(filePath);
    }

    private static PluginCacheRecord CloneCacheRecord(PluginCacheRecord source) => new()
    {
        SourceUrl = source.SourceUrl,
        FileName = source.FileName,
        Sha256 = source.Sha256,
        DownloadedAtUtc = source.DownloadedAtUtc,
        LastCheckedAtUtc = source.LastCheckedAtUtc,
        LastError = source.LastError,
        ETag = source.ETag,
        LastModifiedUtc = source.LastModifiedUtc,
        PreviousFileName = source.PreviousFileName,
        PreviousSha256 = source.PreviousSha256,
        PreviousDownloadedAtUtc = source.PreviousDownloadedAtUtc
    };

    private DateTimeOffset? GetLastRefreshUtc()
    {
        lock (cacheStateLock)
            return cacheState.LastRefreshUtc;
    }

    private async Task<List<PluginRefreshResult>> RefreshAllAsync(CancellationToken cancellationToken)
    {
        await refreshLock.WaitAsync(cancellationToken);
        try
        {
            var results = new List<PluginRefreshResult>();
            foreach (var plugin in Snapshot().Plugins.Where(plugin => plugin.Enabled))
                results.Add(await RefreshPluginAsync(plugin, cancellationToken));

            lock (cacheStateLock)
                cacheState.LastRefreshUtc = DateTimeOffset.UtcNow;
            SaveCacheState();
            return results;
        }
        finally
        {
            refreshLock.Release();
        }
    }

    private async Task<PluginRefreshResult> RefreshPluginAsync(ManagedPlugin plugin, CancellationToken cancellationToken)
    {
        PluginCacheRecord existing;
        lock (cacheStateLock)
        {
            existing = cacheState.Plugins.TryGetValue(plugin.Id, out var found)
                ? CloneCacheRecord(found)
                : new PluginCacheRecord();
        }

        var sameSource = existing.SourceUrl.Equals(plugin.Url, StringComparison.OrdinalIgnoreCase);
        var currentFileName = CacheKey(plugin.Id) + ".js";
        var currentPath = GetSafeCachePath(currentFileName);
        var partialPath = GetSafeCachePath(CacheKey(plugin.Id) + ".partial");
        Exception? lastException = null;

        if (BuiltInPlugins.IsBuiltIn(plugin.Url))
            return await RefreshBuiltInPluginAsync(plugin, existing, sameSource, currentFileName, currentPath, partialPath, cancellationToken);

        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, plugin.Url);
                request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
                if (sameSource && File.Exists(currentPath))
                {
                    if (EntityTagHeaderValue.TryParse(existing.ETag, out var entityTag))
                        request.Headers.IfNoneMatch.Add(entityTag);
                    if (existing.LastModifiedUtc is DateTimeOffset modified)
                        request.Headers.IfModifiedSince = modified;
                }

                using var response = await httpClient.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    cancellationToken);

                if (response.StatusCode == HttpStatusCode.NotModified && sameSource && File.Exists(currentPath))
                {
                    existing.LastCheckedAtUtc = DateTimeOffset.UtcNow;
                    existing.LastError = "";
                    StoreCacheRecord(plugin.Id, existing);
                    SaveCacheState();
                    return new PluginRefreshResult(plugin.Id, plugin.Name, true, false, "Локальная копия актуальна.");
                }

                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength is long contentLength && contentLength > MaximumPluginBytes)
                    throw new InvalidDataException($"Размер превышает {MaximumPluginBytes / 1024 / 1024} МБ.");

                await DownloadWithLimitAsync(response, partialPath, cancellationToken);
                ValidateDownloadedPlugin(partialPath, response.Content.Headers.ContentType?.MediaType);
                string hash;
                using (var hashStream = File.OpenRead(partialPath))
                    hash = Convert.ToHexString(SHA256.HashData(hashStream));
                var now = DateTimeOffset.UtcNow;

                if (sameSource && File.Exists(currentPath) && hash.Equals(existing.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    File.Delete(partialPath);
                    existing.LastCheckedAtUtc = now;
                    existing.LastError = "";
                    existing.ETag = response.Headers.ETag?.ToString() ?? existing.ETag;
                    existing.LastModifiedUtc = response.Content.Headers.LastModified ?? existing.LastModifiedUtc;
                    StoreCacheRecord(plugin.Id, existing);
                    SaveCacheState();
                    return new PluginRefreshResult(plugin.Id, plugin.Name, true, false, "Изменений нет.");
                }

                var previousFileName = CacheKey(plugin.Id) + ".previous.js";
                var previousPath = GetSafeCachePath(previousFileName);
                if (sameSource && File.Exists(currentPath))
                {
                    File.Copy(currentPath, previousPath, overwrite: true);
                    existing.PreviousFileName = previousFileName;
                    existing.PreviousSha256 = existing.Sha256;
                    existing.PreviousDownloadedAtUtc = existing.DownloadedAtUtc;
                }
                else
                {
                    existing.PreviousFileName = "";
                    existing.PreviousSha256 = "";
                    existing.PreviousDownloadedAtUtc = null;
                }

                File.Move(partialPath, currentPath, overwrite: true);
                existing.SourceUrl = plugin.Url;
                existing.FileName = currentFileName;
                existing.Sha256 = hash;
                existing.DownloadedAtUtc = now;
                existing.LastCheckedAtUtc = now;
                existing.LastError = "";
                existing.ETag = response.Headers.ETag?.ToString() ?? "";
                existing.LastModifiedUtc = response.Content.Headers.LastModified;
                StoreCacheRecord(plugin.Id, existing);
                SaveCacheState();
                AppLog.Write($"Cached Lampa plugin {plugin.Name}: {hash}.");
                return new PluginRefreshResult(plugin.Id, plugin.Name, true, true, "Локальная копия обновлена.");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                lastException = exception;
                try { if (File.Exists(partialPath)) File.Delete(partialPath); } catch { }
                if (attempt < 3)
                    await Task.Delay(TimeSpan.FromMilliseconds(attempt * 750), cancellationToken);
            }
        }

        var message = CompactError(lastException);
        existing.LastCheckedAtUtc = DateTimeOffset.UtcNow;
        existing.LastError = message;
        if (string.IsNullOrWhiteSpace(existing.SourceUrl))
            existing.SourceUrl = plugin.Url;
        StoreCacheRecord(plugin.Id, existing);
        SaveCacheState();
        AppLog.Write($"Could not refresh Lampa plugin {plugin.Name}; keeping cached copy. {message}");
        return new PluginRefreshResult(
            plugin.Id,
            plugin.Name,
            sameSource && File.Exists(currentPath),
            false,
            sameSource && File.Exists(currentPath)
                ? $"Обновление не удалось, оставлена предыдущая копия: {message}"
                : $"Локальная копия недоступна: {message}");
    }

    private async Task<PluginRefreshResult> RefreshBuiltInPluginAsync(
        ManagedPlugin plugin,
        PluginCacheRecord existing,
        bool sameSource,
        string currentFileName,
        string currentPath,
        string partialPath,
        CancellationToken cancellationToken)
    {
        var bytes = BuiltInPlugins.Read(plugin.Url);
        await File.WriteAllBytesAsync(partialPath, bytes, cancellationToken);
        ValidateDownloadedPlugin(partialPath, "application/javascript");
        var hash = Convert.ToHexString(SHA256.HashData(bytes));
        var now = DateTimeOffset.UtcNow;

        if (sameSource && File.Exists(currentPath) && hash.Equals(existing.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(partialPath);
            existing.LastCheckedAtUtc = now;
            existing.LastError = "";
            StoreCacheRecord(plugin.Id, existing);
            SaveCacheState();
            return new PluginRefreshResult(plugin.Id, plugin.Name, true, false, "Встроенный плагин актуален.");
        }

        var previousFileName = CacheKey(plugin.Id) + ".previous.js";
        var previousPath = GetSafeCachePath(previousFileName);
        if (sameSource && File.Exists(currentPath))
        {
            File.Copy(currentPath, previousPath, overwrite: true);
            existing.PreviousFileName = previousFileName;
            existing.PreviousSha256 = existing.Sha256;
            existing.PreviousDownloadedAtUtc = existing.DownloadedAtUtc;
        }
        else
        {
            existing.PreviousFileName = "";
            existing.PreviousSha256 = "";
            existing.PreviousDownloadedAtUtc = null;
        }

        File.Move(partialPath, currentPath, overwrite: true);
        existing.SourceUrl = plugin.Url;
        existing.FileName = currentFileName;
        existing.Sha256 = hash;
        existing.DownloadedAtUtc = now;
        existing.LastCheckedAtUtc = now;
        existing.LastError = "";
        existing.ETag = "";
        existing.LastModifiedUtc = null;
        StoreCacheRecord(plugin.Id, existing);
        SaveCacheState();
        AppLog.Write($"Cached built-in Lampa plugin {plugin.Name}: {hash}.");
        return new PluginRefreshResult(plugin.Id, plugin.Name, true, true, "Встроенный плагин обновлён.");
    }

    public LampaAppStatus GetLampaAppStatus()
    {
        var installed = File.Exists(Path.Combine(AppPaths.LampaAppDirectory, "index.html"));
        lock (lampaAppStateLock)
            return new LampaAppStatus(installed, lampaAppState.Version, lampaAppState.DownloadedAtUtc, lampaAppState.LastCheckedAtUtc, lampaAppState.LastError);
    }

    public async Task RefreshLampaAppAsync(CancellationToken cancellationToken)
    {
        await lampaAppRefreshLock.WaitAsync(cancellationToken);
        try
        {
            await RefreshLampaAppCoreAsync(cancellationToken);
        }
        finally
        {
            lampaAppRefreshLock.Release();
        }
    }

    private async Task RefreshLampaAppCoreAsync(CancellationToken cancellationToken)
    {
        string version;
        string hash;
        try
        {
            (version, hash) = await FetchLampaAssemblyInfoAsync(cancellationToken);
        }
        catch (Exception exception)
        {
            UpdateLampaAppState(state =>
            {
                state.LastCheckedAtUtc = DateTimeOffset.UtcNow;
                state.LastError = CompactError(exception);
            });
            throw;
        }

        string existingHash;
        lock (lampaAppStateLock)
            existingHash = lampaAppState.Hash;
        var indexExists = File.Exists(Path.Combine(AppPaths.LampaAppDirectory, "index.html"));

        if (indexExists && !string.IsNullOrEmpty(hash) && hash.Equals(existingHash, StringComparison.OrdinalIgnoreCase))
        {
            UpdateLampaAppState(state =>
            {
                state.LastCheckedAtUtc = DateTimeOffset.UtcNow;
                state.LastError = "";
            });
            return;
        }

        var temporaryZip = Path.Combine(AppPaths.StateDirectory, $"lampa-app.{Guid.NewGuid():N}.zip");
        var extractRoot = Path.Combine(AppPaths.StateDirectory, $"lampa-app.extract.{Guid.NewGuid():N}");
        var backupDirectory = AppPaths.LampaAppDirectory + ".previous";

        try
        {
            await DownloadLampaAppArchiveAsync(temporaryZip, cancellationToken);
            ZipFile.ExtractToDirectory(temporaryZip, extractRoot);

            var contentRoot = LocateLampaAppContent(extractRoot)
                ?? throw new InvalidDataException("В архиве Lampa не найден index.html.");

            if (Directory.Exists(backupDirectory))
                Directory.Delete(backupDirectory, recursive: true);
            if (Directory.Exists(AppPaths.LampaAppDirectory))
                Directory.Move(AppPaths.LampaAppDirectory, backupDirectory);

            try
            {
                Directory.Move(contentRoot, AppPaths.LampaAppDirectory);
            }
            catch
            {
                if (!Directory.Exists(AppPaths.LampaAppDirectory) && Directory.Exists(backupDirectory))
                    Directory.Move(backupDirectory, AppPaths.LampaAppDirectory);
                throw;
            }

            UpdateLampaAppState(state =>
            {
                state.Version = version;
                state.Hash = hash;
                state.DownloadedAtUtc = DateTimeOffset.UtcNow;
                state.LastCheckedAtUtc = DateTimeOffset.UtcNow;
                state.LastError = "";
            });
            AppLog.Write($"Updated Lampa app to version {version}.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            UpdateLampaAppState(state =>
            {
                state.LastCheckedAtUtc = DateTimeOffset.UtcNow;
                state.LastError = CompactError(exception);
            });
            throw;
        }
        finally
        {
            try { if (File.Exists(temporaryZip)) File.Delete(temporaryZip); } catch { }
            try { if (Directory.Exists(extractRoot)) Directory.Delete(extractRoot, recursive: true); } catch { }
        }
    }

    private async Task<(string Version, string Hash)> FetchLampaAssemblyInfoAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"https://raw.githubusercontent.com/{LampaAppRepo}/{LampaAppBranch}/assembly.json");
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var version = document.RootElement.GetProperty("app_version").GetString()
            ?? throw new InvalidDataException("В assembly.json Lampa нет app_version.");
        var hash = document.RootElement.TryGetProperty("hash", out var hashProperty) ? hashProperty.GetString() ?? "" : "";
        return (version, hash);
    }

    private async Task DownloadLampaAppArchiveAsync(string destination, CancellationToken cancellationToken)
    {
        var url = $"https://codeload.github.com/{LampaAppRepo}/zip/refs/heads/{LampaAppBranch}";
        using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var target = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0)
                break;
            total += read;
            if (total > MaximumLampaAppBytes)
                throw new InvalidDataException($"Архив Lampa превышает {MaximumLampaAppBytes / 1024 / 1024} МБ.");
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
    }

    private static string? LocateLampaAppContent(string extractRoot)
    {
        if (File.Exists(Path.Combine(extractRoot, "index.html")))
            return extractRoot;
        foreach (var directory in Directory.GetDirectories(extractRoot))
        {
            if (File.Exists(Path.Combine(directory, "index.html")))
                return directory;
        }
        return null;
    }

    private void UpdateLampaAppState(Action<LampaAppState> mutate)
    {
        lock (lampaAppStateLock)
            mutate(lampaAppState);
        SaveLampaAppState();
    }

    private void SaveLampaAppState()
    {
        lock (lampaAppStateLock)
            WriteJsonAtomically(AppPaths.LampaAppState, lampaAppState);
    }

    private LampaAppState LoadLampaAppState()
    {
        try
        {
            if (!File.Exists(AppPaths.LampaAppState))
                return new LampaAppState();
            return JsonSerializer.Deserialize<LampaAppState>(
                File.ReadAllText(AppPaths.LampaAppState),
                JsonOptions) ?? new LampaAppState();
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            return new LampaAppState();
        }
    }

    private static async Task DownloadWithLimitAsync(
        HttpResponseMessage response,
        string destination,
        CancellationToken cancellationToken)
    {
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var target = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0)
                break;
            total += read;
            if (total > MaximumPluginBytes)
                throw new InvalidDataException($"Размер превышает {MaximumPluginBytes / 1024 / 1024} МБ.");
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
    }

    private static void ValidateDownloadedPlugin(string path, string? mediaType)
    {
        var info = new FileInfo(path);
        if (info.Length < 24)
            throw new InvalidDataException("Сервер вернул пустой или слишком короткий файл.");
        if (mediaType?.Contains("html", StringComparison.OrdinalIgnoreCase) == true)
            throw new InvalidDataException("Вместо JavaScript сервер вернул HTML-страницу.");

        using var stream = File.OpenRead(path);
        var prefixBytes = new byte[Math.Min(1024, (int)info.Length)];
        var read = stream.Read(prefixBytes, 0, prefixBytes.Length);
        var prefix = Encoding.UTF8.GetString(prefixBytes, 0, read).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        if (prefix.StartsWith("<!doctype html", StringComparison.OrdinalIgnoreCase) ||
            prefix.StartsWith("<html", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Вместо JavaScript сервер вернул HTML-страницу.");
        if (prefix.IndexOf('\0') >= 0)
            throw new InvalidDataException("Файл не похож на текстовый JavaScript.");
    }

    private void StoreCacheRecord(string pluginId, PluginCacheRecord record)
    {
        lock (cacheStateLock)
            cacheState.Plugins[pluginId] = CloneCacheRecord(record);
    }

    private static string CacheKey(string pluginId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(pluginId));
        return Convert.ToHexString(hash)[..24].ToLowerInvariant();
    }

    private static string GetSafeCachePath(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName) || Path.GetFileName(fileName) != fileName)
            return "";
        return Path.Combine(AppPaths.PluginCacheDirectory, fileName);
    }

    private static string CompactError(Exception? exception)
    {
        if (exception is null)
            return "неизвестная ошибка";
        var message = exception.Message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length <= 300 ? message : message[..300];
    }

    private static void EnsureLoopback(HttpListenerRequest request)
    {
        if (!IsLoopback(request.RemoteEndPoint?.Address))
            throw new UnauthorizedAccessException("Изменять и обновлять плагины можно только с этого компьютера.");
    }

    private string BuildPanelHtml()
    {
        var loaderUrl = WebUtility.HtmlEncode(LanLoaderUrl);
        return """
                 <!doctype html>
                 <html lang="ru">
                 <head>
                   <meta charset="utf-8">
                   <meta name="viewport" content="width=device-width,initial-scale=1">
                   <title>Lampa Plugin Hub</title>
                   <style>
                     :root{color-scheme:dark;--bg:#0f172a;--card:#172033;--muted:#94a3b8;--line:#334155;--blue:#3b82f6;--green:#22c55e;--red:#ef4444;--amber:#f59e0b}
                     *{box-sizing:border-box}body{margin:0;background:var(--bg);color:#f8fafc;font:15px/1.45 Segoe UI,Arial,sans-serif}
                     main{width:min(980px,calc(100% - 32px));margin:32px auto}.hero{margin-bottom:22px}h1{font-size:28px;margin:0 0 6px}h2{font-size:18px;margin:0 0 15px}.muted{color:var(--muted)}
                     .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:14px 0;box-shadow:0 12px 32px #02061733}
                     .url{display:flex;gap:10px;align-items:center;background:#0b1220;border:1px solid var(--line);border-radius:9px;padding:12px;margin-top:10px;overflow:auto}.url code{flex:1;white-space:nowrap;color:#bfdbfe}
                     button{border:0;border-radius:8px;padding:10px 14px;background:var(--blue);color:white;font-weight:600;cursor:pointer}button.secondary{background:#475569}button.danger{background:#7f1d1d}button:disabled{opacity:.55;cursor:default}
                     select,input{background:#0b1220;border:1px solid var(--line);border-radius:8px;color:white;padding:10px;width:100%}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.toolbar{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}
                     .plugin{display:grid;grid-template-columns:36px 1fr 46px;gap:10px;align-items:start;padding:15px 0;border-bottom:1px solid var(--line)}.plugin:last-child{border-bottom:0}.plugin input[type=checkbox]{width:20px;height:20px;margin-top:11px}.plugin-fields{display:grid;grid-template-columns:1fr 1.7fr .7fr;gap:10px}.cache-status{grid-column:1/-1;font-size:13px}.empty{text-align:center;color:var(--muted);padding:24px}
                     .notice{border-left:3px solid var(--green);padding:10px 14px;background:#052e1633;color:#bbf7d0;border-radius:6px;margin-bottom:8px}.warning{color:#fde68a}.ok{color:#86efac}.error{color:#fca5a5}
                     @media(max-width:760px){.grid,.plugin-fields{grid-template-columns:1fr}.plugin{grid-template-columns:32px 1fr 42px}.cache-status{grid-column:auto}}
                   </style>
                 </head>
                 <body>
                   <main>
                     <div class="hero"><h1>Lampa Plugin Hub</h1><div class="muted">Локальное управление TorrServer и плагинами Lampa</div></div>
                     <section class="card">
                       <h2>1. Один раз добавьте в Lampa на телевизоре</h2>
                       <div>Настройки → Расширения → Добавить плагин</div>
                       <div class="url"><code id="loaderUrl">__LOADER_URL__</code><button onclick="copyLoader()">Копировать</button></div>
                     </section>
                     <section class="card">
                       <h2>2. Настройка TorrServer</h2>
                       <div class="grid">
                         <label>Адрес сервера<input id="torrUrl" readonly></label>
                         <label>Поиск торрентов<select id="searchMode"><option value="both">Rutor + Torznab</option><option value="rutor">Только Rutor</option><option value="torznab">Только Torznab</option></select></label>
                       </div>
                     </section>
                     <section class="card">
                       <h2>3. Плагины</h2>
                       <div class="notice"><b>Локальный режим.</b> Плагины скачивает этот компьютер. Телевизор получает только сохранённые копии по локальной сети. При ошибке обновления рабочая копия сохраняется.</div>
                       <div id="plugins"></div>
                       <div class="toolbar"><button class="secondary" id="refreshButton" onclick="refreshPlugins()">Обновить локальные копии</button><button class="secondary" onclick="addPlugin()">Добавить плагин</button><button id="saveButton" onclick="saveConfig()">Сохранить</button></div>
                       <div id="message" class="muted"></div>
                     </section>
                   </main>
                   <script>
                     let model={searchMode:'both',plugins:[]};
                     const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
                     const dt=s=>s?new Date(s).toLocaleString('ru-RU'):'—';
                     function cacheText(p){if(p.cached){let t=`<span class="ok">● ${p.isBuiltIn?'Встроен в менеджер':'Локальная копия готова'}</span> · ${dt(p.downloadedAtUtc)} · SHA-256 ${esc((p.sha256||'').slice(0,12))}`;if(p.cacheError)t+=`<br><span class="warning">Последнее обновление не удалось, рабочая копия сохранена: ${esc(p.cacheError)}</span>`;return t}return `<span class="error">● Локальной копии нет${p.cacheError?': '+esc(p.cacheError):'. Нажмите «Обновить локальные копии».'}</span>`}
                     async function loadConfig(){const r=await fetch('/api/config',{cache:'no-store'});model=await r.json();document.querySelector('#torrUrl').value=model.torrServerUrl;document.querySelector('#searchMode').value=model.searchMode;render()}
                     function render(){const box=document.querySelector('#plugins');if(!model.plugins.length){box.innerHTML='<div class="empty">Список пуст.</div>';return}box.innerHTML=model.plugins.map((p,i)=>{const lock=p.isBuiltIn?'readonly title="Встроенный модуль обновляется вместе с менеджером"':'';return `<div class="plugin"><input type="checkbox" ${p.enabled?'checked':''} onchange="edit(${i},'enabled',this.checked)"><div class="plugin-fields"><input value="${esc(p.name)}" ${lock} onchange="edit(${i},'name',this.value)" placeholder="Название"><input value="${esc(p.url)}" ${lock} onchange="edit(${i},'url',this.value)" placeholder="https://.../plugin.js"><input value="${esc(p.category)}" ${lock} onchange="edit(${i},'category',this.value)" placeholder="Категория"><div class="cache-status">${cacheText(p)}</div></div><button class="danger" ${p.isBuiltIn?'disabled title="Встроенный модуль можно отключить, но нельзя удалить"':''} onclick="removePlugin(${i})">×</button></div>`}).join('')}
                     function edit(i,key,value){model.plugins[i][key]=value}function addPlugin(){model.plugins.push({id:crypto.randomUUID().replaceAll('-',''),name:'Новый плагин',url:'',enabled:true,category:'Другое',cached:false});render()}function removePlugin(i){model.plugins.splice(i,1);render()}
                     function busy(value,text){document.querySelector('#saveButton').disabled=value;document.querySelector('#refreshButton').disabled=value;const msg=document.querySelector('#message');msg.className='muted';msg.textContent=text||''}
                     async function saveConfig(){model.searchMode=document.querySelector('#searchMode').value;busy(true,'Сохранение и загрузка плагинов на компьютер…');try{const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(model)});const body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));await loadConfig();const failed=model.plugins.filter(p=>p.enabled&&!p.cached);const msg=document.querySelector('#message');msg.className=failed.length?'warning':'ok';msg.textContent=failed.length?'Сохранено, но не все плагины удалось скачать. Рабочие копии не затронуты.':'Сохранено. Все включённые плагины доступны локально.'}catch(e){const msg=document.querySelector('#message');msg.className='error';msg.textContent=e.message}finally{document.querySelector('#saveButton').disabled=false;document.querySelector('#refreshButton').disabled=false}}
                     async function refreshPlugins(){busy(true,'Проверка и обновление локальных копий…');try{const r=await fetch('/api/plugins/refresh',{method:'POST'});const body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));await loadConfig();const failed=model.plugins.filter(p=>p.enabled&&!p.cached);const msg=document.querySelector('#message');msg.className=failed.length?'warning':'ok';msg.textContent=failed.length?'Обновление завершено с ошибками. Старые рабочие копии сохранены.':'Локальные копии проверены и обновлены.'}catch(e){const msg=document.querySelector('#message');msg.className='error';msg.textContent=e.message}finally{document.querySelector('#saveButton').disabled=false;document.querySelector('#refreshButton').disabled=false}}
                     function copyLoader(){navigator.clipboard.writeText(document.querySelector('#loaderUrl').textContent)}
                     loadConfig().catch(e=>{document.querySelector('#message').className='error';document.querySelector('#message').textContent=e.message});
                   </script>
                 </body>
                 </html>
                 """.Replace("__LOADER_URL__", loaderUrl, StringComparison.Ordinal);
    }

    private const string LoaderScript = """
        (function () {
          'use strict';
          var current = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
          var base = current.replace(/\/lampa\.js(?:\?.*)?$/i, '');

          function setValue(name, value) {
            try {
              if (window.Lampa && Lampa.Storage && typeof Lampa.Storage.set === 'function') Lampa.Storage.set(name, value);
              else window.localStorage.setItem(name, typeof value === 'string' ? value : JSON.stringify(value));
            } catch (error) { console.warn('TorrServer Plugin Hub: setting failed', name, error); }
          }

          function loadNext(plugins, index) {
            if (index >= plugins.length) return;
            var plugin = plugins[index];
            var script = document.createElement('script');
            script.src = base + plugin.localPath + '?v=' + encodeURIComponent((plugin.sha256 || '').slice(0, 16));
            script.async = false;
            script.onload = function () { loadNext(plugins, index + 1); };
            script.onerror = function () { console.warn('Plugin Hub: local copy failed', plugin.name, script.src); loadNext(plugins, index + 1); };
            (document.head || document.body || document.documentElement).appendChild(script);
          }

          fetch(base + '/api/config', { cache: 'no-store' })
            .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
            .then(function (config) {
              setValue('torrserver_url', config.torrServerUrl);
              setValue('torrserver_use_link', 'one');
              setValue('torrserver_search_type', config.searchMode || 'both');
              var allEnabled = (config.plugins || []).filter(function (plugin) { return plugin.enabled; });
              var available = allEnabled.filter(function (plugin) { return plugin.cached && plugin.localPath; });
              var missing = allEnabled.filter(function (plugin) { return !plugin.cached || !plugin.localPath; });
              if (missing.length) console.warn('Plugin Hub: local copies unavailable', missing.map(function (plugin) { return plugin.name; }));
              loadNext(available, 0);
              console.log('TorrServer Plugin Hub: local-only mode', available.length + ' plugin(s)');
            })
            .catch(function (error) { console.warn('TorrServer Plugin Hub is unavailable', error); });
        })();
        """;

    private static void AddCommonHeaders(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
        response.Headers["Cache-Control"] = "no-store, max-age=0";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["X-Frame-Options"] = "DENY";
    }

    private static bool IsLoopback(IPAddress? address) =>
        address is not null && (IPAddress.IsLoopback(address) ||
            (address.IsIPv4MappedToIPv6 && IPAddress.IsLoopback(address.MapToIPv4())));

    private static async Task WriteJsonAsync(HttpListenerResponse response, object value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        await WriteTextAsync(response, json, "application/json; charset=utf-8");
    }

    private static async Task WriteErrorAsync(HttpListenerResponse response, HttpStatusCode status, string message)
    {
        response.StatusCode = (int)status;
        await WriteJsonAsync(response, new { error = message });
    }

    private static async Task TryWriteErrorAsync(HttpListenerResponse response, HttpStatusCode status, string message)
    {
        try { await WriteErrorAsync(response, status, message); } catch { }
    }

    private static async Task WriteTextAsync(HttpListenerResponse response, string text, string contentType)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        response.ContentType = contentType;
        response.ContentEncoding = Encoding.UTF8;
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes);
    }

    public void Dispose()
    {
        cancellation.Cancel();
        if (listener.IsListening)
            listener.Stop();
        listener.Close();
        try { listenerTask?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        try { refreshTask?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        httpClient.Dispose();
        refreshLock.Dispose();
        cancellation.Dispose();
    }
}
