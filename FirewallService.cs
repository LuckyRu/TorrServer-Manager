using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace TorrServerManager;

internal static class FirewallService
{
    private const string TorrServerRuleName = "TorrServer (LAN)";
    private const string PluginHubRuleName = "TorrServer Manager (Lampa Hub)";

    public static async Task EnsureRulesAsync(CancellationToken cancellationToken = default)
    {
        var missing = await GetMissingRulesAsync(cancellationToken);
        if (missing.Count == 0)
            return;

        await CreateMissingRulesAsync(missing, cancellationToken);

        var stillMissing = await GetMissingRulesAsync(cancellationToken);
        if (stillMissing.Count > 0)
            throw new InvalidOperationException(
                $"Не удалось создать правила файервола: {string.Join(", ", stillMissing)}.");

        AppLog.Write("Firewall rules ensured for LAN access.");
    }

    private static async Task<List<string>> GetMissingRulesAsync(CancellationToken cancellationToken)
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
        return missing;
    }

    private static async Task CreateMissingRulesAsync(List<string> missing, CancellationToken cancellationToken)
    {
        var statements = new List<string>();
        if (missing.Contains(TorrServerRuleName))
            statements.Add(BuildCreateStatement(TorrServerRuleName, AppPaths.Port, AppPaths.ServerExecutable));
        if (missing.Contains(PluginHubRuleName))
            statements.Add(BuildCreateStatement(PluginHubRuleName, AppPaths.PluginHubPort, AppPaths.ManagerExecutable));

        var script = string.Join(Environment.NewLine, statements);
        await RunPowerShellAsync(script, elevated: true, cancellationToken);
    }

    private static string BuildCreateStatement(string name, int port, string programPath) =>
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
                throw new InvalidOperationException($"Настройка файервола завершилась с кодом {process.ExitCode}.");
            return output;
        }
        catch (Win32Exception exception) when (exception.NativeErrorCode == 1223)
        {
            throw new OperationCanceledException("Настройка файервола отменена в окне UAC.", exception, cancellationToken);
        }
    }
}
