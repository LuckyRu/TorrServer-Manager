using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TorrServerManager;

internal sealed record JackettStatus(
    bool IsInstalled,
    bool ProcessRunning,
    bool HttpResponding,
    int? ProcessId,
    string Version,
    int ConfiguredIndexers)
{
    public bool IsRunning => ProcessRunning && HttpResponding;
}

internal sealed record JackettReleaseInfo(string Version, string DownloadUrl, string? Sha256, long Size);

internal sealed class JackettController : IDisposable
{
    private const string LatestReleaseApi = "https://api.github.com/repos/Jackett/Jackett/releases/latest";
    private const string AssetName = "Jackett.Binaries.Windows.zip";
    private readonly HttpClient localClient = new() { Timeout = TimeSpan.FromSeconds(3) };
    private readonly HttpClient githubClient = new() { Timeout = TimeSpan.FromMinutes(5) };

    public JackettController()
    {
        githubClient.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.4.1");
        githubClient.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        githubClient.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
    }

    public string LocalUrl => $"http://127.0.0.1:{AppPaths.JackettPort}";

    public async Task<JackettStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var installed = File.Exists(AppPaths.JackettExecutable);
        var process = FindJackettProcesses().OrderBy(p => p.Id).FirstOrDefault();
        var responding = installed && await IsHttpRespondingAsync(cancellationToken);

        return new JackettStatus(
            installed,
            process is not null,
            responding,
            process?.Id,
            installed ? ReadInstalledVersion() : "не установлен",
            CountConfiguredIndexers());
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        EnsureInstalled();
        if (FindJackettProcesses().Count > 0)
            return;

        var startInfo = new ProcessStartInfo
        {
            FileName = AppPaths.JackettExecutable,
            WorkingDirectory = AppPaths.JackettAppDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        startInfo.ArgumentList.Add("-z");
        startInfo.ArgumentList.Add("--DataFolder");
        startInfo.ArgumentList.Add(AppPaths.JackettDirectory);
        startInfo.ArgumentList.Add("-p");
        startInfo.ArgumentList.Add(AppPaths.JackettPort.ToString());
        startInfo.ArgumentList.Add("--NoUpdates");

        var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить Jackett.");
        AppLog.Write($"Started Jackett, PID {process.Id}.");

        for (var attempt = 0; attempt < 40; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await IsHttpRespondingAsync(cancellationToken))
                return;
            if (process.HasExited)
                throw new InvalidOperationException($"Jackett завершился с кодом {process.ExitCode}.");
            await Task.Delay(500, cancellationToken);
        }

        throw new TimeoutException("Jackett запущен, но веб-интерфейс не ответил за 20 секунд.");
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var processes = FindJackettProcesses();
        foreach (var process in processes)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                continue;
            }
        }

        foreach (var process in processes)
        {
            try { await process.WaitForExitAsync(cancellationToken).WaitAsync(TimeSpan.FromSeconds(8), cancellationToken); }
            catch (InvalidOperationException) { }
            catch (TimeoutException) { throw new TimeoutException("Jackett не остановился за 8 секунд."); }
        }
        AppLog.Write("Stopped Jackett.");
    }

    public async Task RestartAsync(CancellationToken cancellationToken = default)
    {
        await StopAsync(cancellationToken);
        await Task.Delay(400, cancellationToken);
        await StartAsync(cancellationToken);
    }

    public async Task<JackettReleaseInfo> GetLatestReleaseAsync(CancellationToken cancellationToken = default)
    {
        using var response = await githubClient.GetAsync(LatestReleaseApi, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        var tag = root.GetProperty("tag_name").GetString()?.TrimStart('v', 'V')
            ?? throw new InvalidDataException("GitHub не вернул версию Jackett.");

        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            if (!string.Equals(asset.GetProperty("name").GetString(), AssetName, StringComparison.OrdinalIgnoreCase))
                continue;

            var url = asset.GetProperty("browser_download_url").GetString()
                ?? throw new InvalidDataException("GitHub не вернул адрес файла Jackett.");
            var size = asset.TryGetProperty("size", out var sizeElement) ? sizeElement.GetInt64() : 0;
            string? digest = null;
            if (asset.TryGetProperty("digest", out var digestElement))
                digest = digestElement.GetString();
            var sha256 = digest?.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) == true
                ? digest[7..]
                : null;
            return new JackettReleaseInfo(tag, url, sha256, size);
        }

        throw new InvalidDataException($"В последнем релизе Jackett нет файла {AssetName}.");
    }

    public static bool IsNewer(string candidate, string installed)
    {
        if (!Version.TryParse(candidate.TrimStart('v', 'V'), out var left))
            return false;
        if (!Version.TryParse(installed.TrimStart('v', 'V'), out var right))
            return true;
        return left > right;
    }

    public async Task InstallUpdateAsync(
        JackettReleaseInfo release,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var temporaryZip = Path.Combine(AppPaths.JackettDirectory, $"Jackett.update.{Guid.NewGuid():N}.zip");
        var extractRoot = Path.Combine(AppPaths.JackettDirectory, $"App.new.{Guid.NewGuid():N}");
        var backupDirectory = Path.Combine(AppPaths.JackettDirectory, "App.previous");

        try
        {
            progress?.Report("Скачивание обновления Jackett…");
            await DownloadAsync(release, temporaryZip, progress, cancellationToken);

            progress?.Report("Проверка SHA-256…");
            if (!string.IsNullOrWhiteSpace(release.Sha256))
            {
                var actualHash = await ComputeSha256Async(temporaryZip, cancellationToken);
                if (!actualHash.Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Контрольная сумма обновления Jackett не совпала. Файл не установлен.");
            }

            progress?.Report("Распаковка обновления…");
            ZipFile.ExtractToDirectory(temporaryZip, extractRoot);
            var extractedApp = Path.Combine(extractRoot, "Jackett");
            if (!Directory.Exists(extractedApp))
                throw new InvalidDataException("Архив обновления Jackett имеет неожиданную структуру.");

            progress?.Report("Остановка Jackett…");
            await StopAsync(cancellationToken);

            if (Directory.Exists(backupDirectory))
                Directory.Delete(backupDirectory, recursive: true);
            if (Directory.Exists(AppPaths.JackettAppDirectory))
                Directory.Move(AppPaths.JackettAppDirectory, backupDirectory);

            try
            {
                Directory.Move(extractedApp, AppPaths.JackettAppDirectory);
            }
            catch
            {
                RestoreBackup(backupDirectory);
                throw;
            }

            progress?.Report("Запуск новой версии…");
            try
            {
                await StartAsync(cancellationToken);
            }
            catch
            {
                try { Directory.Delete(AppPaths.JackettAppDirectory, recursive: true); } catch { }
                RestoreBackup(backupDirectory);
                try { await StartAsync(cancellationToken); } catch { /* best effort */ }
                throw;
            }

            AppLog.Write($"Updated Jackett to {release.Version}.");
            progress?.Report($"Установлена {release.Version}");
        }
        finally
        {
            try { if (File.Exists(temporaryZip)) File.Delete(temporaryZip); } catch { }
            try { if (Directory.Exists(extractRoot)) Directory.Delete(extractRoot, recursive: true); } catch { }
        }
    }

    private static void RestoreBackup(string backupDirectory)
    {
        if (Directory.Exists(backupDirectory))
            Directory.Move(backupDirectory, AppPaths.JackettAppDirectory);
    }

    private async Task DownloadAsync(
        JackettReleaseInfo release,
        string destination,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        using var response = await githubClient.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength ?? release.Size;
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, true);
        var buffer = new byte[1024 * 128];
        long received = 0;
        int read;
        while ((read = await input.ReadAsync(buffer, cancellationToken)) > 0)
        {
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            received += read;
            if (total > 0)
                progress?.Report($"Скачивание обновления Jackett… {received * 100 / total}%");
        }
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream, cancellationToken);
        return Convert.ToHexString(hash);
    }

    public async Task SaveRutrackerCredentialsAsync(
        string username,
        string password,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrEmpty(password))
            throw new InvalidDataException("Введите логин и пароль RuTracker.org.");
        if (!await IsHttpRespondingAsync(cancellationToken))
            throw new InvalidOperationException("Сначала запустите Jackett.");

        var cookies = new CookieContainer();
        using var handler = new HttpClientHandler
        {
            CookieContainer = cookies,
            AllowAutoRedirect = true
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(2) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.4.1");

        using (var dashboard = await client.GetAsync(LocalUrl + "/UI/Dashboard", cancellationToken))
            dashboard.EnsureSuccessStatusCode();

        using var configResponse = await client.GetAsync(
            LocalUrl + "/api/v2.0/indexers/rutracker/config",
            cancellationToken);
        configResponse.EnsureSuccessStatusCode();
        var configText = await configResponse.Content.ReadAsStringAsync(cancellationToken);
        var configuration = JsonNode.Parse(configText)?.AsArray()
            ?? throw new InvalidDataException("Jackett вернул некорректную конфигурацию RuTracker.org.");

        SetConfigValue(configuration, "Username", username.Trim());
        SetConfigValue(configuration, "Password", password);

        using var body = new StringContent(configuration.ToJsonString(), Encoding.UTF8, "application/json");
        using var saveResponse = await client.PostAsync(
            LocalUrl + "/api/v2.0/indexers/rutracker/config",
            body,
            cancellationToken);
        var resultText = await saveResponse.Content.ReadAsStringAsync(cancellationToken);
        saveResponse.EnsureSuccessStatusCode();

        if (!string.IsNullOrWhiteSpace(resultText))
        {
            var result = JsonNode.Parse(resultText);
            if (string.Equals(result?["result"]?.GetValue<string>(), "error", StringComparison.OrdinalIgnoreCase))
            {
                var message = result?["error"]?.GetValue<string>() ?? "RuTracker.org отклонил авторизацию.";
                throw new InvalidOperationException(message);
            }
        }
    }

    private async Task<bool> IsHttpRespondingAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await localClient.GetAsync(
                LocalUrl + "/UI/Dashboard",
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { return false; }
    }

    private static List<Process> FindJackettProcesses()
    {
        var processes = Process.GetProcessesByName("JackettConsole").ToList();
        return processes.Where(IsOurJackettProcess).ToList();
    }

    private static bool IsOurJackettProcess(Process process)
    {
        try
        {
            return string.Equals(
                process.MainModule?.FileName,
                AppPaths.JackettExecutable,
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return true;
        }
    }

    private static string ReadInstalledVersion()
    {
        try
        {
            return FileVersionInfo.GetVersionInfo(AppPaths.JackettExecutable).ProductVersion
                ?? FileVersionInfo.GetVersionInfo(AppPaths.JackettExecutable).FileVersion
                ?? "неизвестно";
        }
        catch { return "неизвестно"; }
    }

    private static int CountConfiguredIndexers()
    {
        try
        {
            return Directory.Exists(AppPaths.JackettIndexersDirectory)
                ? Directory.EnumerateFiles(AppPaths.JackettIndexersDirectory, "*.json", SearchOption.TopDirectoryOnly).Count()
                : 0;
        }
        catch { return 0; }
    }

    private static void SetConfigValue(JsonArray configuration, string name, string value)
    {
        var field = configuration
            .OfType<JsonObject>()
            .FirstOrDefault(item => string.Equals(
                item["name"]?.GetValue<string>(),
                name,
                StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidDataException($"В конфигурации RuTracker.org отсутствует поле {name}.");
        field["value"] = value;
    }

    private static void EnsureInstalled()
    {
        if (!File.Exists(AppPaths.JackettExecutable))
            throw new FileNotFoundException("Jackett не установлен.", AppPaths.JackettExecutable);
    }

    public void Dispose()
    {
        localClient.Dispose();
        githubClient.Dispose();
    }
}
