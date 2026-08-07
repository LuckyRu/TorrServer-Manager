using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using TorrServerManager.Infrastructure;

namespace TorrServerManager.Controllers;

internal sealed record ServerStatus(
    bool ProcessRunning,
    bool HttpResponding,
    int? ProcessId,
    DateTime? StartedAt,
    string Version,
    string LanAddress)
{
    public bool IsRunning => ProcessRunning && HttpResponding;
}

internal sealed partial class ServerController : IDisposable
{
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(2) };

    public string LocalUrl => $"http://127.0.0.1:{AppPaths.Port}";
    public string LanUrl => $"http://{GetPreferredLanAddress()}:{AppPaths.Port}";

    public async Task<ServerStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var process = FindServerProcesses().OrderBy(p => p.Id).FirstOrDefault();
        var responding = await IsHttpRespondingAsync(cancellationToken);
        DateTime? startedAt = null;

        if (process is not null)
        {
            try { startedAt = process.StartTime; }
            catch { /* Process may have exited between checks. */ }
        }

        return new ServerStatus(
            process is not null,
            responding,
            process?.Id,
            startedAt,
            await GetInstalledVersionAsync(cancellationToken),
            LanUrl);
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        AppPaths.EnsureDirectories();
        if (!File.Exists(AppPaths.ServerExecutable))
            throw new FileNotFoundException("Не найден TorrServer.exe.", AppPaths.ServerExecutable);

        if (FindServerProcesses().Count > 0)
            return;

        var startInfo = new ProcessStartInfo
        {
            FileName = AppPaths.ServerExecutable,
            WorkingDirectory = AppPaths.InstallDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        startInfo.ArgumentList.Add("--path");
        startInfo.ArgumentList.Add(AppPaths.DataDirectory);
        startInfo.ArgumentList.Add("--logpath");
        startInfo.ArgumentList.Add(AppPaths.ServerLog);

        var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить TorrServer.");
        AppLog.Write($"Started TorrServer, PID {process.Id}.");

        for (var attempt = 0; attempt < 20; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await IsHttpRespondingAsync(cancellationToken))
                return;
            if (process.HasExited)
                throw new InvalidOperationException($"TorrServer завершился с кодом {process.ExitCode}.");
            await Task.Delay(500, cancellationToken);
        }

        throw new TimeoutException("TorrServer запущен, но веб-интерфейс не ответил за 10 секунд.");
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var processes = FindServerProcesses();
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
            catch (TimeoutException) { throw new TimeoutException("TorrServer не остановился за 8 секунд."); }
        }
        AppLog.Write("Stopped TorrServer.");
    }

    public async Task RestartAsync(CancellationToken cancellationToken = default)
    {
        await StopAsync(cancellationToken);
        await Task.Delay(400, cancellationToken);
        await StartAsync(cancellationToken);
    }

    public async Task<bool> IsHttpRespondingAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var response = await httpClient.GetAsync(LocalUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            return response.StatusCode is >= HttpStatusCode.OK and < HttpStatusCode.InternalServerError;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { return false; }
    }

    public async Task<string> GetInstalledVersionAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(AppPaths.ServerExecutable))
            return "не установлен";

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = AppPaths.ServerExecutable,
                Arguments = "--version",
                WorkingDirectory = AppPaths.InstallDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var process = Process.Start(startInfo)!;
            var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken).WaitAsync(TimeSpan.FromSeconds(8), cancellationToken);
            var text = (await outputTask) + " " + (await errorTask);
            var match = VersionRegex().Match(text);
            return match.Success ? match.Value : "неизвестно";
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            return "неизвестно";
        }
    }

    public static string GetPreferredLanAddress()
    {
        var candidates = NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up)
            .Where(n => n.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
            .Select(a => a.Address)
            .Where(a => !IPAddress.IsLoopback(a) && !a.ToString().StartsWith("169.254.", StringComparison.Ordinal))
            .ToList();

        var privateAddress = candidates.FirstOrDefault(IsPrivateIPv4);
        return (privateAddress ?? candidates.FirstOrDefault() ?? IPAddress.Loopback).ToString();
    }

    private static bool IsPrivateIPv4(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 ||
               (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
               (bytes[0] == 192 && bytes[1] == 168);
    }

    private static List<Process> FindServerProcesses()
    {
        var processes = Process.GetProcessesByName("TorrServer").ToList();
        return processes.Where(IsOurServerProcess).ToList();
    }

    private static bool IsOurServerProcess(Process process)
    {
        try
        {
            return string.Equals(
                process.MainModule?.FileName,
                AppPaths.ServerExecutable,
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return true;
        }
    }

    [GeneratedRegex(@"MatriX(?:\.\d+)+", RegexOptions.IgnoreCase)]
    private static partial Regex VersionRegex();

    public void Dispose() => httpClient.Dispose();
}
