using System.Diagnostics;
using System.Security.Cryptography;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using TorrServerManager.Infrastructure;

namespace TorrServerManager.Services;

internal sealed class GStreamerService : IDisposable
{
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromMinutes(20) };
    private const string RuntimeDownloadUrl =
        "https://gstreamer.freedesktop.org/data/pkg/windows/1.28.5/mingw/gstreamer-1.0-mingw-x86_64-1.28.5.exe";
    private const string RuntimeDownloadSha256 =
        "a88231a501980304cebe34716574f1580eb79d2e35ce9e58338fff2401165a6c";

    public async Task EnsureInstalledAsync(CancellationToken cancellationToken = default)
    {
        if (File.Exists(Path.Combine(AppPaths.GStreamerDirectory, "bin", "gst-launch-1.0.exe")))
            return;

        AppPaths.EnsureDirectories();
        Directory.CreateDirectory(AppPaths.GStreamerDirectory);
        var installer = Path.Combine(AppPaths.StateDirectory, $"gstreamer.{Guid.NewGuid():N}.exe");
        try
        {
            using var response = await httpClient.GetAsync(RuntimeDownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            response.EnsureSuccessStatusCode();
            await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var output = new FileStream(installer, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, true))
            {
                await input.CopyToAsync(output, cancellationToken);
            }

            await using (var stream = new FileStream(installer, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 128, true))
            {
                var hash = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
                if (!hash.Equals(RuntimeDownloadSha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Контрольная сумма GStreamer runtime не совпала.");
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = installer,
                WorkingDirectory = AppPaths.InstallDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            foreach (var argument in new[]
            {
                "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/TYPE=runtime",
                "/DIR=" + AppPaths.GStreamerDirectory
            })
                startInfo.ArgumentList.Add(argument);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Не удалось запустить установщик GStreamer.");
            await process.WaitForExitAsync(cancellationToken).WaitAsync(TimeSpan.FromMinutes(15), cancellationToken);
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"Установщик GStreamer завершился с кодом {process.ExitCode}.");
        }
        finally
        {
            try { if (File.Exists(installer)) File.Delete(installer); }
            catch { }
        }

        if (!File.Exists(Path.Combine(AppPaths.GStreamerDirectory, "bin", "gst-launch-1.0.exe")))
            throw new InvalidDataException("GStreamer runtime не установился рядом с TorrServer.");
    }

    public async Task ConfigureAsync(CancellationToken cancellationToken = default)
    {
        var settingsUrl = $"http://127.0.0.1:{AppPaths.Port}/gst/settings";
        using var response = await httpClient.GetAsync(settingsUrl, cancellationToken);
        response.EnsureSuccessStatusCode();
        var root = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken))?.AsObject()
            ?? throw new InvalidDataException("TorrServer не вернул настройки GStreamer.");
        var config = root["config"]?.AsObject()
            ?? throw new InvalidDataException("В ответе TorrServer нет настроек GStreamer.");
        config["GSTPath"] = AppPaths.GStreamerDirectory;
        // AVI/DVDRip files are not a reliable browser container. Keep H.264/H.265 passthrough for
        // modern containers, but make GStreamer transcode AVI video to H.264 while it already
        // converts incompatible audio to AAC.
        config["TranscodeAVI"] = true;

        using var update = await httpClient.PostAsJsonAsync(
            settingsUrl,
            new { action = "set", config },
            cancellationToken);
        update.EnsureSuccessStatusCode();

        using var echo = await httpClient.GetAsync($"http://127.0.0.1:{AppPaths.Port}/gst/echo", cancellationToken);
        echo.EnsureSuccessStatusCode();
    }

    public void Dispose() => httpClient.Dispose();
}
