using TorrServerManager.Infrastructure;

namespace TorrServerManager.Services;

internal sealed class ProcessRecoveryTracker(string serviceName)
{
    private const int UnhealthyThreshold = 3;
    private int consecutiveFailures;
    private int consecutiveUnhealthyChecks;
    private DateTimeOffset nextAttemptAt = DateTimeOffset.MinValue;
    private bool incidentActive;

    public bool Observe(bool healthy, bool processRunning)
    {
        if (healthy)
        {
            MarkHealthy();
            return false;
        }

        if (!incidentActive)
        {
            incidentActive = true;
            AppLog.Write($"Supervisor detected {serviceName} failure: " +
                (processRunning ? "process is running, API is unavailable." : "process is not running."));
        }

        if (!processRunning)
        {
            consecutiveUnhealthyChecks = 0;
            return true;
        }

        consecutiveUnhealthyChecks++;
        return consecutiveUnhealthyChecks >= UnhealthyThreshold;
    }

    public bool CanAttempt(DateTimeOffset now) => now >= nextAttemptAt;

    public void MarkAttemptSucceeded()
    {
        AppLog.Write($"Supervisor recovered {serviceName}.");
        Reset();
    }

    public void MarkAttemptFailed(Exception exception)
    {
        consecutiveFailures++;
        var delaySeconds = Math.Min(300, 5 * Math.Pow(2, Math.Min(consecutiveFailures - 1, 6)));
        var delay = TimeSpan.FromSeconds(delaySeconds);
        nextAttemptAt = DateTimeOffset.UtcNow + delay;
        consecutiveUnhealthyChecks = 0;
        AppLog.Write($"Supervisor could not recover {serviceName}; retry in {delay.TotalSeconds:0}s. {exception}");
    }

    public void Reset()
    {
        consecutiveFailures = 0;
        consecutiveUnhealthyChecks = 0;
        nextAttemptAt = DateTimeOffset.MinValue;
        incidentActive = false;
    }

    private void MarkHealthy()
    {
        if (incidentActive)
            AppLog.Write($"Supervisor observed {serviceName} healthy again.");
        Reset();
    }
}
