using System.Text.Json;
using System.Text.RegularExpressions;

namespace TorrServerManager.Services;

internal sealed record ReleaseInfo(string Version, string HtmlUrl);
internal sealed record InstalledBuildInfo(string FullTag, string UpstreamTag, bool IsDownstream, bool IsDev);

internal sealed partial class UpdateService : IDisposable
{
    private const string LatestReleaseApi = "https://api.github.com/repos/YouROK/TorrServer/releases/latest";
    public const string SourceRepositoryUrl = "https://github.com/LuckyRu/TorrServer";
    private readonly HttpClient httpClient;

    public UpdateService()
    {
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
        var htmlUrl = root.TryGetProperty("html_url", out var htmlUrlProperty)
            ? htmlUrlProperty.GetString()
            : null;
        return new ReleaseInfo(tag, htmlUrl ?? $"https://github.com/YouROK/TorrServer/releases/tag/{tag}");
    }

    public static bool TryParseInstalledBuild(string value, out InstalledBuildInfo build)
    {
        var match = VersionRegex().Match(value.Trim());
        if (!match.Success)
        {
            build = null!;
            return false;
        }

        build = new InstalledBuildInfo(
            match.Value,
            match.Groups["upstream"].Value,
            match.Groups["downstream"].Success,
            match.Groups["dev"].Success);
        return true;
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

    private static int[] ParseVersionParts(string value)
    {
        var match = VersionRegex().Match(value);
        return match.Success
            ? match.Groups["upstream"].Value["MatriX".Length..].TrimStart('.').Split('.').Select(v => int.TryParse(v, out var n) ? n : 0).ToArray()
            : [];
    }

    [GeneratedRegex(@"^(?<upstream>MatriX(?:\.\d+)+)(?<downstream>-TorrentMod(?:\.\d+)+)?(?<dev>-dev\.\d+\.g[0-9a-f]+(?:\.dirty)?)?$", RegexOptions.IgnoreCase)]
    private static partial Regex VersionRegex();

    public void Dispose() => httpClient.Dispose();
}
