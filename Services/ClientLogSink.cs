using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TorrServerManager.Infrastructure;

namespace TorrServerManager.Services;

/// <summary>
/// Receives Torrent Mod logs from Lampa clients (a TV has no devtools) and appends them to
/// <see cref="AppPaths.ClientLog"/>. Any LAN device may write here, so every batch is bounded,
/// rate-limited per address and flattened to single lines before it touches the file.
/// </summary>
internal sealed class ClientLogSink
{
    private const int MaxBodyBytes = 64 * 1024;
    private const int MaxEntriesPerBatch = 500;
    private const int MaxMessageChars = 2000;
    private const int MaxRequestsPerMinute = 120;
    private const long MaxBytesPerMinute = 2L * 1024 * 1024;
    private const long RotateAtBytes = 10L * 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly object fileLock = new();
    private readonly object rateLock = new();
    private readonly Dictionary<string, RateWindow> rates = new(StringComparer.Ordinal);

    private sealed class RateWindow
    {
        public DateTime StartedUtc;
        public int Requests;
        public long Bytes;
    }

    private sealed record Batch(
        string? Client,
        string? Version,
        string? Platform,
        string? Ua,
        string? Page,
        string? Lampa,
        List<Entry>? Entries);

    private sealed record Entry(long T, string? L, string? S, string? M);

    /// <returns>false when the sender is over its rate and the batch was dropped.</returns>
    public async Task<bool> AcceptAsync(HttpListenerRequest request, CancellationToken cancellationToken)
    {
        if (request.ContentLength64 > MaxBodyBytes)
            throw new InvalidDataException("Слишком большой журнал.");

        var body = await ReadBoundedAsync(request.InputStream, cancellationToken);
        var address = request.RemoteEndPoint?.Address?.ToString() ?? "?";
        if (!TryConsume(address, body.Length))
            return false;

        var batch = JsonSerializer.Deserialize<Batch>(body, JsonOptions)
            ?? throw new InvalidDataException("Пустой журнал.");
        var entries = batch.Entries ?? [];
        if (entries.Count > MaxEntriesPerBatch)
            throw new InvalidDataException("Слишком много записей в журнале.");

        var client = ShortClientId(batch.Client);
        var prefix = $"{client}  {address}";
        var lines = new StringBuilder();
        if (!string.IsNullOrEmpty(batch.Ua))
        {
            lines.Append(Stamp(DateTimeOffset.Now)).Append("  ").Append(prefix).Append("  ---- ")
                .Append(Flatten($"{batch.Platform}, Lampa {batch.Lampa}, Torrent Mod {batch.Version}, {batch.Page}, UA: {batch.Ua}", MaxMessageChars))
                .Append('\n');
        }
        foreach (var entry in entries)
        {
            var time = entry.T > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(entry.T).ToLocalTime() : DateTimeOffset.Now;
            lines.Append(Stamp(time)).Append("  ").Append(prefix).Append("  ")
                .Append(Flatten(entry.L ?? "info", 8).ToUpperInvariant().PadRight(5)).Append(' ')
                .Append(Flatten(entry.S ?? "", 64)).Append(": ")
                .Append(Flatten(entry.M ?? "", MaxMessageChars))
                .Append('\n');
        }
        Append(lines.ToString());
        return true;
    }

    // Matches TorrServer's shortSum, so a line here and a `client=c:…` line in server.log name
    // the same viewer.
    internal static string ShortClientId(string? client)
    {
        if (string.IsNullOrWhiteSpace(client))
            return "c:-";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(client.Trim()));
        return "c:" + Convert.ToHexString(hash, 0, 8).ToLowerInvariant();
    }

    internal static string Flatten(string value, int maxChars)
    {
        var builder = new StringBuilder(Math.Min(value.Length, maxChars));
        foreach (var character in value)
        {
            if (builder.Length >= maxChars)
            {
                builder.Append('…');
                break;
            }
            builder.Append(char.IsControl(character) ? ' ' : character);
        }
        return builder.ToString();
    }

    private static string Stamp(DateTimeOffset time) => time.ToString("yyyy-MM-dd HH:mm:ss.fff");

    private static async Task<byte[]> ReadBoundedAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > MaxBodyBytes)
                throw new InvalidDataException("Слишком большой журнал.");
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private bool TryConsume(string address, long bytes)
    {
        var now = DateTime.UtcNow;
        lock (rateLock)
        {
            if (rates.Count > 256)
            {
                foreach (var stale in rates.Where(pair => now - pair.Value.StartedUtc > TimeSpan.FromMinutes(1)).Select(pair => pair.Key).ToList())
                    rates.Remove(stale);
            }
            if (!rates.TryGetValue(address, out var window) || now - window.StartedUtc > TimeSpan.FromMinutes(1))
            {
                window = new RateWindow { StartedUtc = now };
                rates[address] = window;
            }
            if (window.Requests + 1 > MaxRequestsPerMinute || window.Bytes + bytes > MaxBytesPerMinute)
                return false;
            window.Requests++;
            window.Bytes += bytes;
            return true;
        }
    }

    private void Append(string text)
    {
        if (text.Length == 0)
            return;
        lock (fileLock)
        {
            AppPaths.EnsureDirectories();
            var file = new FileInfo(AppPaths.ClientLog);
            if (file.Exists && file.Length > RotateAtBytes)
                File.Move(AppPaths.ClientLog, AppPaths.ClientLogPrevious, overwrite: true);
            File.AppendAllText(AppPaths.ClientLog, text, new UTF8Encoding(false));
        }
    }
}
