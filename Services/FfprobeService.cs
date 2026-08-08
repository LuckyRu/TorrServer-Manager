using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using TorrServerManager.Infrastructure;

namespace TorrServerManager.Services;

/// <summary>
/// TorrServer's /ffp endpoint is only a wrapper around an external ffprobe executable. The
/// TorrServer Windows release does not ship that executable, so install one beside TorrServer.exe
/// and verify it before starting the server.
/// </summary>
internal sealed class FfprobeService : IDisposable
{
    // BtbN's static LGPL build published on 2026-08-07. The URL is intentionally paired with the
    // digest: if the mutable convenience URL ever points at different bytes, installation fails
    // rather than silently replacing a media-processing binary.
    private const string DownloadUrl =
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip";
    private const string DownloadSha256 =
        "506faa0d46aacf1a73c022283a47f6cf9d9a3731fcd0ccc025d71089692e75b9";

    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromMinutes(10) };

    public async Task EnsureInstalledAsync(CancellationToken cancellationToken = default)
    {
        AppPaths.EnsureDirectories();
        if (await IsUsableAsync(AppPaths.FfprobeExecutable, cancellationToken))
            return;

        var temporaryZip = Path.Combine(AppPaths.StateDirectory, $"ffprobe.{Guid.NewGuid():N}.zip");
        var temporaryExe = Path.Combine(AppPaths.InstallDirectory, $"ffprobe.{Guid.NewGuid():N}.exe");

        try
        {
            httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.0");
            using var response = await httpClient.GetAsync(
                DownloadUrl,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            response.EnsureSuccessStatusCode();
            await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var output = new FileStream(temporaryZip, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, true))
            {
                await input.CopyToAsync(output, cancellationToken);
            }

            var actualSha256 = await ComputeSha256Async(temporaryZip, cancellationToken);
            if (!actualSha256.Equals(DownloadSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Контрольная сумма ffprobe не совпала.");

            // The archive also contains ffmpeg.exe — only ffprobe.exe is extracted. ffmpeg.exe used
            // to back Plugin Hub's own /transcode/ audio endpoint; that endpoint was removed once
            // GST's own HLS output turned out to already declare AAC audio regardless of the source
            // file's codec (see CLAUDE.md, the url_reserve entry), leaving ffmpeg.exe with no caller
            // anywhere in the codebase.
            using (var archive = ZipFile.OpenRead(temporaryZip))
            {
                await ExtractExecutableAsync(archive, "ffprobe.exe", temporaryExe, cancellationToken);
            }

            if (!await IsUsableAsync(temporaryExe, cancellationToken))
                throw new InvalidDataException("Скачанный ffprobe не запускается.");

            File.Move(temporaryExe, AppPaths.FfprobeExecutable, overwrite: true);
        }
        finally
        {
            TryDelete(temporaryZip);
            TryDelete(temporaryExe);
        }

        if (!await IsUsableAsync(AppPaths.FfprobeExecutable, cancellationToken))
            throw new InvalidDataException("Установленный ffprobe не запускается.");
    }

    private static async Task ExtractExecutableAsync(
        ZipArchive archive,
        string fileName,
        string destination,
        CancellationToken cancellationToken)
    {
        var entry = archive.Entries.FirstOrDefault(item =>
            item.FullName.EndsWith($"/bin/{fileName}", StringComparison.OrdinalIgnoreCase) ||
            item.FullName.Equals($"bin/{fileName}", StringComparison.OrdinalIgnoreCase));
        if (entry is null)
            throw new InvalidDataException($"В архиве FFmpeg не найден bin/{fileName}.");

        await using var input = entry.Open();
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, true);
        await input.CopyToAsync(output, cancellationToken);
    }

    private static async Task<bool> IsUsableAsync(string path, CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
            return false;

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = path,
                Arguments = "-version",
                WorkingDirectory = Path.GetDirectoryName(path) ?? AppPaths.InstallDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var process = Process.Start(startInfo);
            if (process is null)
                return false;
            await process.WaitForExitAsync(cancellationToken).WaitAsync(TimeSpan.FromSeconds(15), cancellationToken);
            return process.ExitCode == 0;
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 128, true);
        var hash = await SHA256.HashDataAsync(stream, cancellationToken);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { /* Best effort cleanup. */ }
    }

    public void Dispose() => httpClient.Dispose();
}
