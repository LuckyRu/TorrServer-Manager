using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
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
            WindowStyle = ProcessWindowStyle.Hidden,
            // Паника Go уходит в stderr и не попадает ни в --logpath, ни в дамп Windows: процесс
            // просто исчезает, а supervisor видит только «process is not running». Без перехвата
            // причина падения теряется целиком.
            RedirectStandardError = true,
            RedirectStandardOutput = true
        };
        startInfo.ArgumentList.Add("--path");
        startInfo.ArgumentList.Add(AppPaths.DataDirectory);
        startInfo.ArgumentList.Add("--logpath");
        startInfo.ArgumentList.Add(AppPaths.ServerLog);

        var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить TorrServer.");
        // Читать оба потока обязательно: перенаправленный и никем не вычитываемый пайп
        // переполняется и вешает дочерний процесс.
        AttachCrashCapture(process);
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

    // Сколько последних строк вывода держим, чтобы восстановить обстоятельства падения.
    private const int CrashContextLines = 400;
    private static readonly object crashLogLock = new();

    // Обычный вывод TorrServer уже идёт в --logpath, поэтому сюда попадает то, чего там нет:
    // паника Go со стеком горутин и сообщения нативного слоя (GStreamer/GLib).
    //
    // Отбирать по «выглядит фатально» нельзя: зависший пайплайн процесс не роняет, и его
    // сообщения так и не попали бы на диск. Отбираем по источнику — шум производит только
    // клиент torrent/DHT (порядка трёх мегабайт в минуту при включённой отладке), а GStreamer и
    // GLib пишут редко и по делу. Шум оседает в кольцевом буфере и выгружается лишь при
    // завершении процесса, когда становится контекстом падения.
    private static void AttachCrashCapture(Process process)
    {
        var pid = process.Id;
        var recent = new Queue<string>();
        var errorFilter = CreateNoiseFilter();
        var outputFilter = CreateNoiseFilter();

        void Remember(string stream, Func<string, bool> isNoise, string? line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            var entry = $"{DateTime.Now:HH:mm:ss} {stream}: {line}";
            lock (recent)
            {
                recent.Enqueue(entry);
                while (recent.Count > CrashContextLines) recent.Dequeue();
            }
            // isNoise ведёт собственное состояние (многострочные записи), поэтому вызывается
            // ровно один раз на строку и до любых ранних выходов.
            var noise = isNoise(line);
            if (!noise) WriteCrashLog(pid, "вывод сервера", [entry]);
        }

        process.EnableRaisingEvents = true;
        process.ErrorDataReceived += (_, args) => Remember("stderr", errorFilter, args.Data);
        process.OutputDataReceived += (_, args) => Remember("stdout", outputFilter, args.Data);
        process.Exited += (_, _) =>
        {
            string reason;
            try { reason = $"процесс завершился, код {process.ExitCode}"; }
            catch { reason = "процесс завершился, код недоступен"; }

            string[] context;
            lock (recent) context = [.. recent];
            WriteCrashLog(pid, reason, context);
        };

        try
        {
            process.BeginErrorReadLine();
            process.BeginOutputReadLine();
        }
        catch (InvalidOperationException)
        {
            // Процесс успел завершиться до подписки — терять из-за этого запуск нельзя.
        }
    }

    // Шум — записи клиента torrent/DHT/UPnP. Они двухстрочные: заголовок вида
    // `[дата УРОВЕНЬ github.com/anacrolix/... файл:строка]`, следом отступ и `msg="..."`.
    // Фильтр помнит, что находится внутри такой записи, поэтому у него есть состояние и на
    // каждый поток нужен свой экземпляр.
    //
    // Паника Go печатает стек с теми же путями anacrolix, но начинается с `panic:`/`goroutine`,
    // и после неё всё до конца вывода пишется без фильтрации — иначе стек потерялся бы.
    private static Func<string, bool> CreateNoiseFilter()
    {
        var insideNoiseRecord = false;
        var fatalSeen = false;

        return line =>
        {
            if (fatalSeen) return false;
            if (line.Contains("panic:", StringComparison.Ordinal) ||
                line.Contains("fatal error:", StringComparison.Ordinal) ||
                line.Contains("SIGSEGV", StringComparison.Ordinal) ||
                line.StartsWith("goroutine ", StringComparison.Ordinal))
            {
                fatalSeen = true;
                return false;
            }

            if (insideNoiseRecord && (line.StartsWith(' ') || line.StartsWith('\t'))) return true;
            insideNoiseRecord = false;

            if (line.StartsWith('[') && line.Contains("github.com/anacrolix/", StringComparison.Ordinal))
            {
                insideNoiseRecord = true;
                return true;
            }
            return false;
        };
    }

    private static void WriteCrashLog(int pid, string reason, IReadOnlyCollection<string> lines)
    {
        if (lines.Count == 0) return;
        try
        {
            lock (crashLogLock)
            {
                var text = new StringBuilder()
                    .AppendLine($"===== {DateTime.Now:yyyy-MM-dd HH:mm:ss} pid {pid}: {reason} =====");
                foreach (var line in lines) text.AppendLine(line);
                File.AppendAllText(AppPaths.ServerCrashLog, text.ToString());
            }
        }
        catch { /* Диагностика не должна ронять запуск сервера. */ }
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

    // The -dev suffix is what build-all.ps1 stamps when the submodule is ahead of its release tag;
    // dropping it here would show a dev build as the release it is merely descended from.
    [GeneratedRegex(@"MatriX(?:\.\d+)+(?:-TorrentMod(?:\.\d+)+)?(?:-dev\.\d+\.g[0-9a-f]+(?:\.dirty)?)?", RegexOptions.IgnoreCase)]
    private static partial Regex VersionRegex();

    public void Dispose() => httpClient.Dispose();
}
