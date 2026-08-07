using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrServerManager.Controllers;
using TorrServerManager.Infrastructure;

namespace TorrServerManager.Services;

internal sealed record ReleaseInfo(
    string Version,
    string DownloadUrl,
    string? Sha256,
    long Size,
    string ReleasePageUrl);

internal sealed partial class UpdateService : IDisposable
{
    private const string LatestReleaseApi = "https://api.github.com/repos/YouROK/TorrServer/releases/latest";
    private const string AssetName = "TorrServer-windows-amd64.exe";
    private readonly HttpClient httpClient;
    private readonly ServerController controller;

    public UpdateService(ServerController controller)
    {
        this.controller = controller;
        httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.0");
        httpClient.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        httpClient.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
    }

    public async Task<ReleaseInfo> GetLatestReleaseAsync(CancellationToken cancellationToken = default)
    {
        using var response = await httpClient.GetAsync(LatestReleaseApi, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        var tag = root.GetProperty("tag_name").GetString()
            ?? throw new InvalidDataException("GitHub не вернул версию релиза.");
        var page = root.TryGetProperty("html_url", out var pageElement)
            ? pageElement.GetString() ?? "https://github.com/YouROK/TorrServer/releases"
            : "https://github.com/YouROK/TorrServer/releases";

        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            if (!string.Equals(asset.GetProperty("name").GetString(), AssetName, StringComparison.OrdinalIgnoreCase))
                continue;

            var url = asset.GetProperty("browser_download_url").GetString()
                ?? throw new InvalidDataException("GitHub не вернул адрес файла обновления.");
            var size = asset.TryGetProperty("size", out var sizeElement) ? sizeElement.GetInt64() : 0;
            string? digest = null;
            if (asset.TryGetProperty("digest", out var digestElement))
                digest = digestElement.GetString();
            var sha256 = digest?.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) == true
                ? digest[7..]
                : null;
            return new ReleaseInfo(tag, url, sha256, size, page);
        }

        throw new InvalidDataException($"В последнем релизе нет файла {AssetName}.");
    }

    public static bool IsNewer(string candidate, string installed)
    {
        var left = ParseVersionParts(candidate);
        var right = ParseVersionParts(installed);
        var count = Math.Max(left.Length, right.Length);
        for (var i = 0; i < count; i++)
        {
            var l = i < left.Length ? left[i] : 0;
            var r = i < right.Length ? right[i] : 0;
            if (l != r)
                return l > r;
        }
        return false;
    }

    public async Task InstallUpdateAsync(
        ReleaseInfo release,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        AppPaths.EnsureDirectories();
        var temporaryFile = Path.Combine(AppPaths.InstallDirectory, $"TorrServer.update.{Guid.NewGuid():N}.exe");
        var backupFile = Path.Combine(AppPaths.InstallDirectory, "TorrServer.previous.exe");

        try
        {
            progress?.Report("Скачивание обновления…");
            await DownloadAsync(release, temporaryFile, progress, cancellationToken);

            progress?.Report("Проверка SHA-256…");
            if (!string.IsNullOrWhiteSpace(release.Sha256))
            {
                var actualHash = await ComputeSha256Async(temporaryFile, cancellationToken);
                if (!actualHash.Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Контрольная сумма обновления не совпала. Файл не установлен.");
            }

            var downloadedVersion = await ReadVersionAsync(temporaryFile, cancellationToken);
            if (!downloadedVersion.Equals(release.Version, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"Версия скачанного файла ({downloadedVersion}) не совпадает с релизом ({release.Version}).");

            progress?.Report("Остановка TorrServer…");
            await controller.StopAsync(cancellationToken);

            if (File.Exists(AppPaths.ServerExecutable))
                File.Copy(AppPaths.ServerExecutable, backupFile, overwrite: true);
            File.Move(temporaryFile, AppPaths.ServerExecutable, overwrite: true);

            progress?.Report("Запуск новой версии…");
            try
            {
                await controller.StartAsync(cancellationToken);
            }
            catch
            {
                await RollBackAsync(backupFile);
                throw;
            }

            AppLog.Write($"Updated TorrServer to {release.Version}.");
            progress?.Report($"Установлена {release.Version}");
        }
        finally
        {
            try { if (File.Exists(temporaryFile)) File.Delete(temporaryFile); }
            catch { /* Best-effort cleanup. */ }
        }
    }

    private async Task DownloadAsync(
        ReleaseInfo release,
        string destination,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
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
                progress?.Report($"Скачивание обновления… {received * 100 / total}%");
        }
    }

    private async Task RollBackAsync(string backupFile)
    {
        AppLog.Write("Update failed; rolling back TorrServer.");
        try { await controller.StopAsync(); } catch { }
        if (!File.Exists(backupFile))
            return;
        File.Copy(backupFile, AppPaths.ServerExecutable, overwrite: true);
        await controller.StartAsync();
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream, cancellationToken);
        return Convert.ToHexString(hash);
    }

    private static async Task<string> ReadVersionAsync(string executable, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = "--version",
            WorkingDirectory = Path.GetDirectoryName(executable),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using var process = Process.Start(startInfo)!;
        var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken).WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        var match = VersionRegex().Match((await outputTask) + " " + (await errorTask));
        return match.Success ? match.Value : throw new InvalidDataException("Не удалось определить версию обновления.");
    }

    private static int[] ParseVersionParts(string value)
    {
        var match = VersionRegex().Match(value);
        return match.Success
            ? match.Value["MatriX".Length..].TrimStart('.').Split('.').Select(v => int.TryParse(v, out var n) ? n : 0).ToArray()
            : [];
    }

    [GeneratedRegex(@"MatriX(?:\.\d+)+", RegexOptions.IgnoreCase)]
    private static partial Regex VersionRegex();

    public void Dispose() => httpClient.Dispose();
}
