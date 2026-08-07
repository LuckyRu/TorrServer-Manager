using System.Reflection;
using TorrServerManager.Infrastructure;
using TorrServerManager.Services;

namespace TorrServerManager.Plugins;

internal sealed record BuiltInPluginDefinition(string Id, string Url, string Name, string Category, string ResourceName);

internal static class BuiltInPlugins
{
    private static readonly BuiltInPluginDefinition[] Definitions =
    [
        new("torrent_mod", "builtin://torrent-mod", "Torrent Mod — поиск и просмотр торрентов", "Торренты", "TorrServerManager.TorrentModPlugin.js")
    ];

    public static bool IsBuiltIn(string? url) =>
        Definitions.Any(definition => definition.Url.Equals(url, StringComparison.OrdinalIgnoreCase));

    public static byte[] Read(string url)
    {
        var definition = Definitions.FirstOrDefault(item => item.Url.Equals(url, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidDataException("Неизвестный встроенный плагин.");

        // Dev-only fast path: drop an updated copy of the .js file into dev-plugins/ (same file
        // name as the EmbeddedResource, e.g. TorrentModPlugin.js) and it's picked up on the next
        // refresh (manual "Обновить локальные копии" or the periodic loop) via the normal
        // SHA-256 cache-diff path in PluginHub — no dotnet build/publish/restart needed.
        const string resourcePrefix = "TorrServerManager.";
        var fileName = definition.ResourceName.StartsWith(resourcePrefix, StringComparison.Ordinal)
            ? definition.ResourceName[resourcePrefix.Length..]
            : definition.ResourceName;
        var overridePath = Path.Combine(AppPaths.BuiltInPluginDevOverrideDirectory, fileName);
        if (File.Exists(overridePath))
            return File.ReadAllBytes(overridePath);

        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(definition.ResourceName)
            ?? throw new InvalidDataException($"Встроенный плагин «{definition.Name}» отсутствует в приложении.");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    public static void Ensure(PluginHubConfiguration configuration)
    {
        foreach (var definition in Definitions)
        {
            var plugin = configuration.Plugins.FirstOrDefault(item =>
                definition.Id.Equals(item.Id, StringComparison.OrdinalIgnoreCase));

            if (plugin is null)
            {
                configuration.Plugins.Add(new ManagedPlugin
                {
                    Id = definition.Id,
                    Name = definition.Name,
                    Url = definition.Url,
                    Enabled = true,
                    Category = definition.Category
                });
                continue;
            }

            plugin.Id = definition.Id;
            plugin.Name = definition.Name;
            plugin.Url = definition.Url;
            plugin.Category = definition.Category;
        }
    }
}
