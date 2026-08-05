using System.Reflection;

namespace TorrServerManager;

internal static class BuiltInPlugins
{
    public const string SmartTsId = "smart_ts";
    public const string SmartTsUrl = "builtin://smart-ts";
    public const string SmartTsName = "Smart TS — сезоны, серии и предзагрузка";
    public const string SmartTsCategory = "Торренты";

    public static bool IsBuiltIn(string? url) =>
        SmartTsUrl.Equals(url, StringComparison.OrdinalIgnoreCase);

    public static byte[] Read(string url)
    {
        if (!IsBuiltIn(url))
            throw new InvalidDataException("Неизвестный встроенный плагин.");

        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("TorrServerManager.SmartTsPlugin.js")
            ?? throw new InvalidDataException("Встроенный Smart TS отсутствует в приложении.");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    public static void Ensure(PluginHubConfiguration configuration)
    {
        var plugin = configuration.Plugins.FirstOrDefault(item =>
            SmartTsId.Equals(item.Id, StringComparison.OrdinalIgnoreCase));

        if (plugin is null)
        {
            configuration.Plugins.Add(new ManagedPlugin
            {
                Id = SmartTsId,
                Name = SmartTsName,
                Url = SmartTsUrl,
                Enabled = true,
                Category = SmartTsCategory
            });
            return;
        }

        plugin.Id = SmartTsId;
        plugin.Name = SmartTsName;
        plugin.Url = SmartTsUrl;
        plugin.Category = SmartTsCategory;
    }
}
