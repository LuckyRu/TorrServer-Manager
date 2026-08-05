using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TorrServerManager;

internal sealed record JackettStatus(
    bool IsInstalled,
    bool IsRunning,
    string Version,
    int ConfiguredIndexers);

internal sealed class JackettController : IDisposable
{
    private const string ServiceName = "Jackett";
    private const string LatestReleaseApi = "https://api.github.com/repos/Jackett/Jackett/releases/latest";
    private readonly HttpClient localClient = new() { Timeout = TimeSpan.FromSeconds(3) };
    private readonly HttpClient githubClient = new() { Timeout = TimeSpan.FromSeconds(20) };

    public JackettController()
    {
        githubClient.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.2");
        githubClient.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        githubClient.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
    }

    public string LocalUrl => $"http://127.0.0.1:{AppPaths.JackettPort}";

    public async Task<JackettStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var installed = File.Exists(AppPaths.JackettExecutable);
        return new JackettStatus(
            installed,
            installed && await IsHttpRespondingAsync(cancellationToken),
            installed ? ReadInstalledVersion() : "не установлен",
            CountConfiguredIndexers());
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        EnsureInstalled();
        if (await IsHttpRespondingAsync(cancellationToken))
            return;
        await RunElevatedServiceCommandAsync("start", cancellationToken);
        await WaitForHttpStateAsync(expected: true, TimeSpan.FromSeconds(35), cancellationToken);
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        EnsureInstalled();
        if (!await IsHttpRespondingAsync(cancellationToken))
            return;
        await RunElevatedServiceCommandAsync("stop", cancellationToken);
        await WaitForHttpStateAsync(expected: false, TimeSpan.FromSeconds(20), cancellationToken);
    }

    public async Task RestartAsync(CancellationToken cancellationToken = default)
    {
        EnsureInstalled();
        await RunElevatedPowerShellAsync("Restart-Service -Name 'Jackett' -Force", cancellationToken);
        await WaitForHttpStateAsync(expected: true, TimeSpan.FromSeconds(40), cancellationToken);
    }

    public async Task<string> GetLatestVersionAsync(CancellationToken cancellationToken = default)
    {
        using var response = await githubClient.GetAsync(LatestReleaseApi, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return document.RootElement.GetProperty("tag_name").GetString()?.TrimStart('v', 'V')
            ?? throw new InvalidDataException("GitHub не вернул версию Jackett.");
    }

    public async Task TriggerBuiltInUpdateAsync(CancellationToken cancellationToken = default)
    {
        EnsureInstalled();
        var cookies = new CookieContainer();
        using var handler = new HttpClientHandler
        {
            CookieContainer = cookies,
            AllowAutoRedirect = true
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(2) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.2");

        using (var dashboard = await client.GetAsync(LocalUrl + "/UI/Dashboard", cancellationToken))
            dashboard.EnsureSuccessStatusCode();

        try
        {
            using var response = await client.PostAsync(
                LocalUrl + "/api/v2.0/server/update",
                new StringContent(string.Empty),
                cancellationToken);
            response.EnsureSuccessStatusCode();
        }
        catch (HttpRequestException)
        {
            // The updater may stop the local service before the HTTP response is completed.
        }

        await Task.Delay(TimeSpan.FromSeconds(4), cancellationToken);
        await WaitForHttpStateAsync(expected: true, TimeSpan.FromMinutes(3), cancellationToken);
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
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TorrServerManager/1.2");

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

    public static bool IsNewer(string candidate, string installed)
    {
        if (!Version.TryParse(candidate.TrimStart('v', 'V'), out var left))
            return false;
        if (!Version.TryParse(installed.TrimStart('v', 'V'), out var right))
            return true;
        return left > right;
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

    private async Task WaitForHttpStateAsync(bool expected, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var started = Stopwatch.StartNew();
        while (started.Elapsed < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await IsHttpRespondingAsync(cancellationToken) == expected)
                return;
            await Task.Delay(750, cancellationToken);
        }

        throw new TimeoutException(expected
            ? "Jackett не ответил после запуска."
            : "Jackett не остановился за отведённое время.");
    }

    private static async Task RunElevatedServiceCommandAsync(string command, CancellationToken cancellationToken)
    {
        await RunElevatedAsync("sc.exe", $"{command} {ServiceName}", cancellationToken);
    }

    private static async Task RunElevatedPowerShellAsync(string command, CancellationToken cancellationToken)
    {
        var escaped = command.Replace("\"", "`\"");
        await RunElevatedAsync(
            "powershell.exe",
            $"-NoProfile -WindowStyle Hidden -Command \"{escaped}\"",
            cancellationToken);
    }

    private static async Task RunElevatedAsync(string fileName, string arguments, CancellationToken cancellationToken)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden
            }) ?? throw new InvalidOperationException("Не удалось запустить административную операцию.");
            await process.WaitForExitAsync(cancellationToken);
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"Команда управления Jackett завершилась с кодом {process.ExitCode}.");
        }
        catch (Win32Exception exception) when (exception.NativeErrorCode == 1223)
        {
            throw new OperationCanceledException("Операция отменена в окне UAC.", exception, cancellationToken);
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
