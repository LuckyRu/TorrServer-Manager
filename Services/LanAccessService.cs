using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;
using System.Text;
using TorrServerManager.Infrastructure;

namespace TorrServerManager.Services;

/// <summary>
/// What the LAN needs to reach this machine: inbound firewall rules for TorrServer and Plugin Hub,
/// and the URL reservation that lets Plugin Hub listen on every interface without admin rights.
/// Everything missing is created in one elevated step, so there is at most one UAC prompt.
/// </summary>
internal static class LanAccessService
{
    private const string TorrServerRuleName = "TorrServer (LAN)";
    private const string PluginHubRuleName = "TorrServer Manager (Lampa Hub)";
    private const string PluginHubUrlReservation = "URL reservation for Plugin Hub";

    public static string PluginHubUrlPrefix => $"http://+:{AppPaths.PluginHubPort}/";

    public static async Task EnsureAsync(CancellationToken cancellationToken = default)
    {
        var missing = await GetMissingAsync(cancellationToken);
        if (missing.Count == 0)
            return;

        await CreateMissingAsync(missing, cancellationToken);

        var stillMissing = await GetMissingAsync(cancellationToken);
        if (stillMissing.Count > 0)
            throw new InvalidOperationException(
                $"Не удалось настроить доступ из локальной сети: {string.Join(", ", stillMissing)}.");

        AppLog.Write($"LAN access ensured: {string.Join(", ", missing)}.");
    }

    private static async Task<List<string>> GetMissingAsync(CancellationToken cancellationToken)
    {
        var names = new[] { TorrServerRuleName, PluginHubRuleName };
        var script = string.Join(Environment.NewLine, names.Select(name =>
            $"if (Get-NetFirewallRule -DisplayName '{Escape(name)}' -ErrorAction SilentlyContinue) " +
            $"{{ Write-Output 'OK:{Escape(name)}' }} else {{ Write-Output 'MISSING:{Escape(name)}' }}"));

        var output = await RunPowerShellAsync(script, elevated: false, cancellationToken);
        var missing = new List<string>();
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (line.StartsWith("MISSING:", StringComparison.Ordinal))
                missing.Add(line["MISSING:".Length..]);
        }

        if (!await IsUrlReservedAsync(cancellationToken))
            missing.Add(PluginHubUrlReservation);
        return missing;
    }

    // netsh localises everything it prints except the URL itself, which appears only when reserved.
    private static async Task<bool> IsUrlReservedAsync(CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "netsh.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true
        };
        foreach (var argument in new[] { "http", "show", "urlacl", $"url={PluginHubUrlPrefix}" })
            startInfo.ArgumentList.Add(argument);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить netsh.");
        var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        return output.Contains(PluginHubUrlPrefix, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task CreateMissingAsync(List<string> missing, CancellationToken cancellationToken)
    {
        var statements = new List<string>();
        if (missing.Contains(TorrServerRuleName))
            statements.Add(BuildFirewallStatement(TorrServerRuleName, AppPaths.Port, AppPaths.ServerExecutable));
        if (missing.Contains(PluginHubRuleName))
            statements.Add(BuildFirewallStatement(PluginHubRuleName, AppPaths.PluginHubPort, AppPaths.ManagerExecutable));
        if (missing.Contains(PluginHubUrlReservation))
        {
            // The reservation is for the user running the manager, identified by SID: the elevated
            // process may run under another account, and account names are localised.
            var sid = WindowsIdentity.GetCurrent().User?.Value
                ?? throw new InvalidOperationException("Не удалось определить учётную запись пользователя.");
            statements.Add($"netsh http add urlacl 'url={PluginHubUrlPrefix}' 'sddl=D:(A;;GX;;;{sid})' | Out-Null");
        }

        var script = string.Join(Environment.NewLine, statements);
        await RunPowerShellAsync(script, elevated: true, cancellationToken);
    }

    private static string BuildFirewallStatement(string name, int port, string programPath) =>
        $"New-NetFirewallRule -DisplayName '{Escape(name)}' -Direction Inbound -Action Allow " +
        $"-Protocol TCP -LocalPort {port} -Program '{Escape(programPath)}' -Profile Private,Domain | Out-Null";

    private static string Escape(string value) => value.Replace("'", "''");

    private static async Task<string> RunPowerShellAsync(string script, bool elevated, CancellationToken cancellationToken)
    {
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -WindowStyle Hidden -EncodedCommand {encoded}",
            UseShellExecute = elevated,
            CreateNoWindow = !elevated,
            RedirectStandardOutput = !elevated,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        if (elevated)
            startInfo.Verb = "runas";

        try
        {
            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Не удалось запустить PowerShell.");
            var output = elevated ? "" : await process.StandardOutput.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            if (elevated && process.ExitCode != 0)
                throw new InvalidOperationException($"Настройка доступа из сети завершилась с кодом {process.ExitCode}.");
            return output;
        }
        catch (Win32Exception exception) when (exception.NativeErrorCode == 1223)
        {
            throw new OperationCanceledException("Настройка доступа из сети отменена в окне UAC.", exception, cancellationToken);
        }
    }
}
