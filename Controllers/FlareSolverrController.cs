using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using TorrServerManager.Infrastructure;

namespace TorrServerManager.Controllers;

internal sealed record FlareSolverrStatus(
    bool IsInstalled,
    bool ProcessRunning,
    bool HttpResponding,
    int? ProcessId,
    string Version)
{
    public bool IsRunning => ProcessRunning && HttpResponding;
}

internal sealed record FlareSolverrReleaseInfo(string Version, string DownloadUrl, string? Sha256, long Size);

internal sealed class FlareSolverrController : IDisposable
{
    private const string LatestReleaseApi = "https://api.github.com/repos/FlareSolverr/FlareSolverr/releases/latest";
    private const string AssetName = "flaresolverr_windows_x64.zip";
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(3) };
    private readonly HttpClient githubClient = new() { Timeout = TimeSpan.FromMinutes(5) };

    public FlareSolverrController()
    {
        githubClient.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.21.0");
        githubClient.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        githubClient.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
    }

    public string LocalUrl => $"http://127.0.0.1:{AppPaths.FlareSolverrPort}";

    public async Task<FlareSolverrStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var installed = File.Exists(AppPaths.FlareSolverrExecutable);
        var process = FindProcesses().OrderBy(p => p.Id).FirstOrDefault();
        var api = installed ? await ReadApiStatusAsync(cancellationToken) : (false, "не установлен");
        var version = !installed ? "не установлен" : api.Item1 ? api.Item2 : ReadInstalledVersion();

        return new FlareSolverrStatus(
            installed,
            process is not null,
            api.Item1,
            process?.Id,
            version);
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        EnsureInstalled();
        if (FindProcesses().Count > 0)
            return;

        var startInfo = new ProcessStartInfo
        {
            FileName = AppPaths.FlareSolverrExecutable,
            WorkingDirectory = AppPaths.FlareSolverrDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        startInfo.Environment["HOST"] = "127.0.0.1";
        startInfo.Environment["PORT"] = AppPaths.FlareSolverrPort.ToString();
        startInfo.Environment["LOG_LEVEL"] = "info";
        startInfo.Environment["TZ"] = TimeZoneInfo.Local.Id;

        var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить FlareSolverr.");
        AppLog.Write($"Started FlareSolverr, PID {process.Id}.");

        for (var attempt = 0; attempt < 60; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if ((await ReadApiStatusAsync(cancellationToken)).Item1)
                return;
            if (process.HasExited)
                throw new InvalidOperationException($"FlareSolverr завершился с кодом {process.ExitCode}.");
            await Task.Delay(500, cancellationToken);
        }

        throw new TimeoutException("FlareSolverr запущен, но API не ответил за 30 секунд.");
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var processes = FindProcesses();
        foreach (var process in processes)
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
        }

        foreach (var process in processes)
        {
            try { await process.WaitForExitAsync(cancellationToken).WaitAsync(TimeSpan.FromSeconds(8), cancellationToken); }
            catch (InvalidOperationException) { }
            catch (TimeoutException) { throw new TimeoutException("FlareSolverr не остановился за 8 секунд."); }
        }
        AppLog.Write("Stopped FlareSolverr.");
    }

    public async Task RestartAsync(CancellationToken cancellationToken = default)
    {
        await StopAsync(cancellationToken);
        await Task.Delay(400, cancellationToken);
        await StartAsync(cancellationToken);
    }

    public async Task<FlareSolverrReleaseInfo> GetLatestReleaseAsync(CancellationToken cancellationToken = default)
    {
        using var response = await githubClient.GetAsync(LatestReleaseApi, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        var version = root.GetProperty("tag_name").GetString()?.TrimStart('v', 'V')
            ?? throw new InvalidDataException("GitHub не вернул версию FlareSolverr.");

        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            if (!string.Equals(asset.GetProperty("name").GetString(), AssetName, StringComparison.OrdinalIgnoreCase))
                continue;

            var url = asset.GetProperty("browser_download_url").GetString()
                ?? throw new InvalidDataException("GitHub не вернул адрес архива FlareSolverr.");
            var size = asset.TryGetProperty("size", out var sizeElement) ? sizeElement.GetInt64() : 0;
            var digest = asset.TryGetProperty("digest", out var digestElement) ? digestElement.GetString() : null;
            var sha256 = digest?.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) == true
                ? digest[7..]
                : null;
            return new FlareSolverrReleaseInfo(version, url, sha256, size);
        }

        throw new InvalidDataException($"В последнем релизе FlareSolverr нет файла {AssetName}.");
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
        FlareSolverrReleaseInfo release,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var temporaryZip = Path.Combine(AppPaths.FlareSolverrBaseDirectory, $"FlareSolverr.update.{Guid.NewGuid():N}.zip");
        var extractRoot = Path.Combine(AppPaths.FlareSolverrBaseDirectory, $"flaresolverr.new.{Guid.NewGuid():N}");
        var backupDirectory = Path.Combine(AppPaths.FlareSolverrBaseDirectory, "flaresolverr.previous");

        try
        {
            progress?.Report("Скачивание обновления FlareSolverr…");
            await DownloadAsync(release, temporaryZip, progress, cancellationToken);

            progress?.Report("Проверка SHA-256…");
            if (!string.IsNullOrWhiteSpace(release.Sha256))
            {
                var actualHash = await ComputeSha256Async(temporaryZip, cancellationToken);
                if (!actualHash.Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Контрольная сумма обновления FlareSolverr не совпала. Файл не установлен.");
            }

            progress?.Report("Распаковка обновления…");
            ZipFile.ExtractToDirectory(temporaryZip, extractRoot);
            var extractedDirectory = Directory.Exists(Path.Combine(extractRoot, "flaresolverr"))
                ? Path.Combine(extractRoot, "flaresolverr")
                : extractRoot;
            if (!File.Exists(Path.Combine(extractedDirectory, "flaresolverr.exe")))
                throw new InvalidDataException("Архив обновления FlareSolverr имеет неожиданную структуру.");

            progress?.Report("Остановка FlareSolverr…");
            await StopAsync(cancellationToken);

            if (Directory.Exists(backupDirectory))
                Directory.Delete(backupDirectory, recursive: true);
            if (Directory.Exists(AppPaths.FlareSolverrDirectory))
                Directory.Move(AppPaths.FlareSolverrDirectory, backupDirectory);

            try
            {
                Directory.Move(extractedDirectory, AppPaths.FlareSolverrDirectory);
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
                try { Directory.Delete(AppPaths.FlareSolverrDirectory, recursive: true); } catch { }
                RestoreBackup(backupDirectory);
                try { await StartAsync(cancellationToken); } catch { }
                throw;
            }

            AppLog.Write($"Updated FlareSolverr to {release.Version}.");
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
            Directory.Move(backupDirectory, AppPaths.FlareSolverrDirectory);
    }

    private async Task DownloadAsync(
        FlareSolverrReleaseInfo release,
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
                progress?.Report($"Скачивание обновления FlareSolverr… {received * 100 / total}%");
        }
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream, cancellationToken);
        return Convert.ToHexString(hash);
    }

    private async Task<(bool Responding, string Version)> ReadApiStatusAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await httpClient.GetAsync(LocalUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode)
                return (false, "неизвестно");

            using var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
            var version = document.RootElement.TryGetProperty("version", out var versionElement)
                ? versionElement.GetString() ?? "неизвестно"
                : "неизвестно";
            return (true, version);
        }
        catch (HttpRequestException) { return (false, "неизвестно"); }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { return (false, "неизвестно"); }
        catch (JsonException) { return (false, "неизвестно"); }
    }

    private static List<Process> FindProcesses()
    {
        var processes = Process.GetProcessesByName("flaresolverr").ToList();
        return processes.Where(IsOurProcess).ToList();
    }

    private static bool IsOurProcess(Process process)
    {
        try
        {
            return string.Equals(
                process.MainModule?.FileName,
                AppPaths.FlareSolverrExecutable,
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
            return FileVersionInfo.GetVersionInfo(AppPaths.FlareSolverrExecutable).ProductVersion ?? "неизвестно";
        }
        catch { return "неизвестно"; }
    }

    private static void EnsureInstalled()
    {
        if (!File.Exists(AppPaths.FlareSolverrExecutable))
            throw new FileNotFoundException("FlareSolverr не установлен.", AppPaths.FlareSolverrExecutable);
    }

    public void Dispose()
    {
        httpClient.Dispose();
        githubClient.Dispose();
    }
}
