using System.Diagnostics;
using System.Reflection;
using TorrServerManager.Controllers;
using TorrServerManager.Infrastructure;
using TorrServerManager.Services;

namespace TorrServerManager.UI;

internal sealed class MainForm : Form
{
    private static readonly Color Accent = Color.FromArgb(37, 99, 235);
    private static readonly Color Green = Color.FromArgb(22, 163, 74);
    private static readonly Color Amber = Color.FromArgb(217, 119, 6);
    private static readonly Color Red = Color.FromArgb(220, 38, 38);
    private static readonly Color Muted = Color.FromArgb(100, 116, 139);

    private static readonly string AppVersion = ReadAppVersion();

    private static string ReadAppVersion()
    {
        var raw = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
            ?? "?";
        var buildMetadataIndex = raw.IndexOf('+');
        return buildMetadataIndex < 0 ? raw : raw[..buildMetadataIndex];
    }

    private readonly ServerController controller = new();
    private readonly FfprobeService ffprobeService = new();
    private readonly GStreamerService gStreamerService = new();
    private readonly JackettController jackettController = new();
    private readonly FlareSolverrController flareSolverrController = new();
    private readonly UpdateService updateService;
    private readonly PluginHub pluginHub = new();
    private readonly NotifyIcon trayIcon = new();
    private readonly System.Windows.Forms.Timer statusTimer = new() { Interval = 2500 };
    private readonly System.Threading.Timer flareSolverrUpdateTimer;
    private readonly System.Threading.Timer supervisorTimer;
    private readonly SemaphoreSlim refreshLock = new(1, 1);
    private readonly SemaphoreSlim supervisorLock = new(1, 1);
    private readonly SemaphoreSlim torrServerOperationLock = new(1, 1);
    private readonly SemaphoreSlim jackettStackOperationLock = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly ProcessRecoveryTracker torrServerRecovery = new("TorrServer");
    private readonly ProcessRecoveryTracker jackettRecovery = new("Jackett");
    private readonly ProcessRecoveryTracker flareSolverrRecovery = new("FlareSolverr");

    private readonly Label statusDot = new();
    private readonly Label statusText = new();
    private readonly Label statusDetails = new();
    private readonly Label versionValue = new();
    private readonly LinkLabel addressValue = new();
    private readonly LinkLabel hubAddress = new();
    private readonly LinkLabel lampaAppAddress = new();
    private readonly Label lampaAppCaption = new();
    private readonly Label updateText = new();
    private readonly Label jackettDot = new();
    private readonly Label jackettStatusText = new();
    private readonly Label jackettDetails = new();
    private readonly Label jackettVersionValue = new();
    private readonly Label jackettLanAddress = new();
    private readonly Label jackettApiKeyValue = new();
    private readonly Label flareSolverrDot = new();
    private readonly Label flareSolverrStatusText = new();
    private readonly Label flareSolverrDetails = new();
    private readonly Label flareSolverrVersionValue = new();
    private readonly Button startButton;
    private readonly Button stopButton;
    private readonly Button restartButton;
    private readonly Button openButton;
    private readonly Button checkButton;
    private readonly Button updateButton;
    private readonly Button jackettStartButton;
    private readonly Button jackettStopButton;
    private readonly Button jackettRestartButton;
    private readonly Button jackettOpenButton;
    private readonly Button jackettUpdateButton;
    private readonly Button flareSolverrStartButton;
    private readonly Button flareSolverrStopButton;
    private readonly Button flareSolverrRestartButton;
    private readonly Button lampaAppUpdateButton;

    private readonly ToolStripMenuItem trayStartItem = new("Запустить");
    private readonly ToolStripMenuItem trayStopItem = new("Остановить");
    private readonly ToolStripMenuItem trayRestartItem = new("Перезапустить");
    private readonly ToolStripMenuItem trayJackettStartItem = new("Запустить");
    private readonly ToolStripMenuItem trayJackettStopItem = new("Остановить");
    private readonly ToolStripMenuItem trayJackettRestartItem = new("Перезапустить");
    private ReleaseInfo? availableRelease;
    private bool allowExit;
    private bool busy;
    private bool jackettBusy;
    private bool flareSolverrBusy;
    private bool lampaAppBusy;
    private volatile bool torrServerDesiredRunning = true;
    private volatile bool jackettDesiredRunning = true;
    private volatile bool flareSolverrDesiredRunning = true;
    private Icon? currentIcon;
    private int? currentIconColor;

    public MainForm(bool startInBackground)
    {
        updateService = new UpdateService();
        flareSolverrUpdateTimer = new System.Threading.Timer(
            _ => _ = CheckFlareSolverrUpdateInBackgroundAsync(),
            null,
            Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan);
        supervisorTimer = new System.Threading.Timer(
            _ => _ = SuperviseProcessesAsync(),
            null,
            Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan);
        AppPaths.EnsureDirectories();

        Text = $"TorrServer Manager v{AppVersion}";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(620, 990);
        MinimumSize = new Size(620, 930);
        MaximumSize = new Size(780, 1080);
        BackColor = Color.FromArgb(245, 247, 250);
        Font = new Font("Segoe UI", 10F);
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = false;

        var title = new Label
        {
            Text = "TorrServer Manager",
            Font = new Font("Segoe UI Semibold", 18F, FontStyle.Bold),
            ForeColor = Color.FromArgb(15, 23, 42),
            AutoSize = true,
            Location = new Point(24, 18)
        };
        var subtitle = new Label
        {
            Text = $"Сервер для Lampa и устройств в локальной сети · v{AppVersion}",
            ForeColor = Muted,
            AutoSize = true,
            Location = new Point(27, 52)
        };
        Controls.Add(title);
        Controls.Add(subtitle);

        var statusPanel = CreateCard(new Rectangle(24, 82, 572, 150));
        statusDot.Text = "●";
        statusDot.Font = new Font("Segoe UI", 22F, FontStyle.Bold);
        statusDot.ForeColor = Amber;
        statusDot.AutoSize = true;
        statusDot.Location = new Point(18, 15);
        statusText.Text = "Проверка…";
        statusText.Font = new Font("Segoe UI Semibold", 14F, FontStyle.Bold);
        statusText.AutoSize = true;
        statusText.Location = new Point(56, 19);
        statusDetails.Text = "Определение состояния сервера";
        statusDetails.ForeColor = Muted;
        statusDetails.AutoSize = false;
        statusDetails.AutoEllipsis = true;
        statusDetails.Size = new Size(265, 24);
        statusDetails.Location = new Point(59, 50);
        var versionCaption = CreateCaption("Версия", new Point(340, 18));
        versionCaption.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        versionValue.Text = "—";
        versionValue.AutoSize = false;
        versionValue.AutoEllipsis = true;
        versionValue.Size = new Size(208, 24);
        versionValue.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        versionValue.Location = new Point(340, 42);
        var addressCaption = CreateCaption("Для Lampa", new Point(18, 88));
        addressValue.Text = controller.LanUrl;
        addressValue.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        addressValue.AutoSize = true;
        addressValue.Location = new Point(18, 110);
        addressValue.LinkColor = Accent;
        addressValue.LinkClicked += (_, _) => OpenWebInterface(useLanAddress: true);
        var addressCopyButton = CreateButton("Копировать", Color.FromArgb(71, 85, 105), new Point(440, 102), 108);
        addressCopyButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        addressCopyButton.Height = 30;
        addressCopyButton.Click += (_, _) => CopyToClipboard(addressCopyButton, addressValue.Text);
        statusPanel.Controls.AddRange([statusDot, statusText, statusDetails, versionCaption, versionValue, addressCaption, addressValue, addressCopyButton]);
        Controls.Add(statusPanel);

        startButton = CreateButton("Запустить", Accent, new Point(24, 252), 106);
        stopButton = CreateButton("Остановить", Color.FromArgb(71, 85, 105), new Point(140, 252), 112);
        restartButton = CreateButton("Перезапустить", Color.FromArgb(71, 85, 105), new Point(262, 252), 132);
        openButton = CreateButton("Открыть веб", Green, new Point(404, 252), 132);
        Controls.Add(CreateButtonRow(new Point(24, 252), new Size(572, 40), 40, startButton, stopButton, restartButton, openButton));

        var lampaPanel = CreateCard(new Rectangle(24, 312, 572, 220));
        var lampaTitle = new Label
        {
            Text = "Lampa",
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 12)
        };
        lampaAppCaption.Text = "Приложение для ТВ и браузера · загрузка версии…";
        lampaAppCaption.ForeColor = Muted;
        lampaAppCaption.AutoSize = false;
        lampaAppCaption.AutoEllipsis = true;
        lampaAppCaption.Size = new Size(400, 24);
        lampaAppCaption.Location = new Point(18, 44);
        lampaAppAddress.Text = pluginHub.LampaAppUrl;
        lampaAppAddress.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        lampaAppAddress.AutoSize = true;
        lampaAppAddress.Location = new Point(18, 68);
        lampaAppAddress.LinkColor = Accent;
        lampaAppAddress.LinkClicked += (_, _) => OpenLampaApp();
        lampaAppUpdateButton = CreateButton("Обновить", Accent, new Point(440, 10), 108);
        lampaAppUpdateButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        lampaAppUpdateButton.Height = 30;
        lampaAppUpdateButton.Click += async (_, _) => await RefreshLampaAppAsync();
        var lampaAppCopyButton = CreateButton("Копировать", Color.FromArgb(71, 85, 105), new Point(440, 62), 108);
        lampaAppCopyButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        lampaAppCopyButton.Height = 30;
        lampaAppCopyButton.Click += (_, _) => CopyToClipboard(lampaAppCopyButton, lampaAppAddress.Text);

        var hubButton = CreateButton("Управлять", Color.FromArgb(124, 58, 237), new Point(440, 120), 108);
        hubButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        hubButton.Height = 30;
        hubButton.Click += (_, _) => OpenPluginHub();
        var hubCaption = new Label
        {
            Text = "Плагины — добавьте вручную в отдельной Lampa: Настройки → Расширения → Добавить плагин",
            ForeColor = Muted,
            AutoSize = false,
            AutoEllipsis = true,
            Size = new Size(400, 24),
            Location = new Point(18, 154)
        };
        hubAddress.Text = pluginHub.LanLoaderUrl;
        hubAddress.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        hubAddress.AutoSize = true;
        hubAddress.Location = new Point(18, 178);
        hubAddress.LinkColor = Accent;
        hubAddress.LinkClicked += (_, _) => OpenPluginHub();
        var hubCopyButton = CreateButton("Копировать", Color.FromArgb(71, 85, 105), new Point(440, 172), 108);
        hubCopyButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        hubCopyButton.Height = 30;
        hubCopyButton.Click += (_, _) => CopyToClipboard(hubCopyButton, hubAddress.Text);
        lampaPanel.Controls.AddRange([
            lampaTitle, lampaAppCaption, lampaAppAddress, lampaAppUpdateButton, lampaAppCopyButton,
            hubButton, hubCaption, hubAddress, hubCopyButton
        ]);
        Controls.Add(lampaPanel);

        var jackettPanel = CreateCard(new Rectangle(24, 548, 572, 184));
        var jackettTitle = new Label
        {
            Text = "Jackett / Torznab",
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 11)
        };
        jackettDot.Text = "●";
        jackettDot.Font = new Font("Segoe UI", 13F, FontStyle.Bold);
        jackettDot.ForeColor = Amber;
        jackettDot.AutoSize = true;
        jackettDot.Location = new Point(18, 35);
        jackettStatusText.Text = "Проверка…";
        jackettStatusText.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        jackettStatusText.AutoSize = true;
        jackettStatusText.Location = new Point(43, 39);
        jackettDetails.Text = "Определение состояния индексаторов";
        jackettDetails.ForeColor = Muted;
        jackettDetails.AutoSize = false;
        jackettDetails.AutoEllipsis = true;
        jackettDetails.Size = new Size(215, 24);
        jackettDetails.Location = new Point(185, 39);
        var jackettVersionCaption = CreateCaption("Версия", new Point(410, 39));
        jackettVersionCaption.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        jackettVersionValue.Text = "—";
        jackettVersionValue.AutoSize = true;
        jackettVersionValue.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        jackettVersionValue.Location = new Point(468, 39);
        jackettStartButton = CreateButton("Запустить", Accent, new Point(18, 62), 96);
        jackettStopButton = CreateButton("Остановить", Color.FromArgb(71, 85, 105), new Point(122, 62), 100);
        jackettRestartButton = CreateButton("Перезапустить", Color.FromArgb(71, 85, 105), new Point(230, 62), 112);
        jackettOpenButton = CreateButton("Открыть", Green, new Point(350, 62), 94);
        jackettUpdateButton = CreateButton("Обновить", Color.FromArgb(124, 58, 237), new Point(452, 62), 102);
        var jackettButtonRow = CreateButtonRow(new Point(18, 62), new Size(536, 32), 32,
            jackettStartButton, jackettStopButton, jackettRestartButton, jackettOpenButton, jackettUpdateButton);
        var jackettLanCaption = new Label
        {
            Text = "Для Lampa: Настройки → Тип парсера «Jackett»",
            ForeColor = Muted,
            AutoSize = true,
            Location = new Point(18, 104)
        };
        jackettLanAddress.Text = pluginHub.JackettProxyUrl;
        jackettLanAddress.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        jackettLanAddress.AutoSize = true;
        jackettLanAddress.Location = new Point(18, 126);
        var jackettLanCopyButton = CreateButton("Копировать", Color.FromArgb(71, 85, 105), new Point(440, 118), 108);
        jackettLanCopyButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        jackettLanCopyButton.Height = 28;
        jackettLanCopyButton.Click += (_, _) => CopyToClipboard(jackettLanCopyButton, jackettLanAddress.Text);
        jackettApiKeyValue.Text = "API-ключ: —";
        jackettApiKeyValue.AutoSize = true;
        jackettApiKeyValue.Location = new Point(18, 152);
        var jackettApiKeyCopyButton = CreateButton("Копировать", Color.FromArgb(71, 85, 105), new Point(440, 150), 108);
        jackettApiKeyCopyButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        jackettApiKeyCopyButton.Height = 28;
        jackettApiKeyCopyButton.Click += (_, _) => CopyToClipboard(jackettApiKeyCopyButton, jackettController.GetApiKey() ?? "");
        jackettPanel.Controls.AddRange([
            jackettTitle, jackettDot, jackettStatusText, jackettDetails,
            jackettVersionCaption, jackettVersionValue,
            jackettButtonRow,
            jackettLanCaption, jackettLanAddress, jackettLanCopyButton, jackettApiKeyValue, jackettApiKeyCopyButton
        ]);
        Controls.Add(jackettPanel);

        var flareSolverrPanel = CreateCard(new Rectangle(24, 748, 572, 132));
        var flareSolverrTitle = new Label
        {
            Text = "FlareSolverr",
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 11)
        };
        var flareSolverrVersionCaption = CreateCaption("Версия", new Point(410, 39));
        flareSolverrVersionCaption.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        flareSolverrVersionValue.Text = "—";
        flareSolverrVersionValue.AutoSize = true;
        flareSolverrVersionValue.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        flareSolverrVersionValue.Location = new Point(468, 39);
        flareSolverrDot.Text = "●";
        flareSolverrDot.Font = new Font("Segoe UI", 13F, FontStyle.Bold);
        flareSolverrDot.ForeColor = Amber;
        flareSolverrDot.AutoSize = true;
        flareSolverrDot.Location = new Point(18, 35);
        flareSolverrStatusText.Text = "Проверка…";
        flareSolverrStatusText.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        flareSolverrStatusText.AutoSize = true;
        flareSolverrStatusText.Location = new Point(43, 39);
        flareSolverrDetails.Text = "Проверка локального API FlareSolverr";
        flareSolverrDetails.ForeColor = Muted;
        flareSolverrDetails.AutoSize = false;
        flareSolverrDetails.AutoEllipsis = true;
        flareSolverrDetails.Size = new Size(215, 24);
        flareSolverrDetails.Location = new Point(185, 39);
        flareSolverrStartButton = CreateButton("Запустить", Accent, new Point(18, 70), 96);
        flareSolverrStopButton = CreateButton("Остановить", Color.FromArgb(71, 85, 105), new Point(122, 70), 100);
        flareSolverrRestartButton = CreateButton("Перезапустить", Color.FromArgb(71, 85, 105), new Point(230, 70), 112);
        var flareSolverrButtonRow = CreateButtonRow(new Point(18, 70), new Size(536, 32), 32,
            flareSolverrStartButton, flareSolverrStopButton, flareSolverrRestartButton);
        flareSolverrPanel.Controls.AddRange([
            flareSolverrTitle, flareSolverrDot, flareSolverrStatusText, flareSolverrDetails,
            flareSolverrVersionCaption, flareSolverrVersionValue,
            flareSolverrButtonRow
        ]);
        Controls.Add(flareSolverrPanel);

        var updatePanel = CreateCard(new Rectangle(24, 896, 572, 94));
        var updateTitle = new Label
        {
            Text = "Обновления TorrServer",
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 14)
        };
        updateText.Text = "Проверка выполняется вручную через GitHub";
        updateText.ForeColor = Muted;
        updateText.AutoEllipsis = true;
        updateText.Location = new Point(19, 45);
        updateText.Size = new Size(300, 24);
        checkButton = CreateButton("Проверить", Color.FromArgb(71, 85, 105), new Point(330, 24), 100);
        updateButton = CreateButton("Инструкция", Accent, new Point(440, 24), 108);
        updateButton.Enabled = false;
        var updateButtonRow = CreateButtonRow(new Point(330, 24), new Size(218, 40), 40, checkButton, updateButton);
        updateButtonRow.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        updatePanel.Controls.AddRange([updateTitle, updateText, updateButtonRow]);
        Controls.Add(updatePanel);

        startButton.Click += async (_, _) => await RunOperationAsync("Запуск…", StartTorrServerAsync);
        stopButton.Click += async (_, _) => await RunOperationAsync("Остановка…", StopTorrServerAsync);
        restartButton.Click += async (_, _) => await RunOperationAsync("Перезапуск…", RestartTorrServerAsync);
        openButton.Click += (_, _) => OpenWebInterface(useLanAddress: false);
        checkButton.Click += async (_, _) => await CheckForUpdatesAsync(showUpToDateMessage: true);
        updateButton.Click += (_, _) => OpenTorrServerUpdateGuide();
        jackettStartButton.Click += async (_, _) => await RunJackettOperationAsync("Запуск…", StartJackettStackAsync);
        jackettStopButton.Click += async (_, _) => await RunJackettOperationAsync("Остановка…", StopJackettStackAsync);
        jackettRestartButton.Click += async (_, _) => await RunJackettOperationAsync("Перезапуск…", RestartJackettStackAsync);
        jackettOpenButton.Click += (_, _) => OpenJackett();
        jackettUpdateButton.Click += async (_, _) => await CheckAndUpdateJackettAsync();
        flareSolverrStartButton.Click += async (_, _) => await RunFlareSolverrOperationAsync("Запуск…", StartFlareSolverrAsync);
        flareSolverrStopButton.Click += async (_, _) => await RunFlareSolverrOperationAsync("Остановка…", StopFlareSolverrAsync);
        flareSolverrRestartButton.Click += async (_, _) => await RunFlareSolverrOperationAsync("Перезапуск…", RestartFlareSolverrAsync);

        ConfigureTrayIcon();
        statusTimer.Tick += async (_, _) => await RefreshStatusAsync();
        Load += async (_, _) =>
        {
            if (startInBackground)
            {
                ShowInTaskbar = false;
                Hide();
            }

            try { await FirewallService.EnsureRulesAsync(lifetime.Token); }
            catch (Exception exception)
            {
                AppLog.Write(exception);
                trayIcon.ShowBalloonTip(5000, "Файервол не настроен", exception.Message, ToolTipIcon.Warning);
            }

            try { pluginHub.Start(); }
            catch (Exception exception)
            {
                AppLog.Write(exception);
                trayIcon.ShowBalloonTip(5000, "Lampa Plugin Hub не запущен", exception.Message, ToolTipIcon.Error);
            }

            try
            {
                await ffprobeService.EnsureInstalledAsync(lifetime.Token);
                await gStreamerService.EnsureInstalledAsync(lifetime.Token);
                await StartTorrServerAsync(lifetime.Token);
                await gStreamerService.ConfigureAsync(lifetime.Token);
            }
            catch (Exception exception)
            {
                AppLog.Write(exception);
                trayIcon.ShowBalloonTip(7000, "TorrServer/GStreamer не запущен", exception.Message, ToolTipIcon.Error);
            }

            try { await StartJackettStackAsync(lifetime.Token); }
            catch (Exception exception)
            {
                AppLog.Write(exception);
                trayIcon.ShowBalloonTip(7000, "Jackett/FlareSolverr не запущены", exception.Message, ToolTipIcon.Error);
            }

            flareSolverrUpdateTimer.Change(TimeSpan.FromSeconds(10), TimeSpan.FromHours(6));
            supervisorTimer.Change(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));

            await RefreshStatusAsync();
            statusTimer.Start();
        };
        FormClosing += OnFormClosing;
        Resize += (_, _) =>
        {
            if (WindowState == FormWindowState.Minimized)
                HideToTray();
        };
    }

    public void ShowFromTray()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    private void ConfigureTrayIcon()
    {
        var menu = new ContextMenuStrip();
        var openManagerItem = new ToolStripMenuItem("Открыть менеджер", null, (_, _) => ShowFromTray()) { Font = new Font("Segoe UI", 9F, FontStyle.Bold) };
        var openWebItem = new ToolStripMenuItem("Открыть веб-интерфейс", null, (_, _) => OpenWebInterface(useLanAddress: false));
        var pluginHubItem = new ToolStripMenuItem("Плагины Lampa", null, (_, _) => OpenPluginHub());
        var jackettMenu = new ToolStripMenuItem("Jackett");
        var jackettOpenItem = new ToolStripMenuItem("Открыть панель", null, (_, _) => OpenJackett());
        trayJackettStartItem.Click += async (_, _) => await RunJackettOperationAsync("Запуск…", StartJackettStackAsync);
        trayJackettStopItem.Click += async (_, _) => await RunJackettOperationAsync("Остановка…", StopJackettStackAsync);
        trayJackettRestartItem.Click += async (_, _) => await RunJackettOperationAsync("Перезапуск…", RestartJackettStackAsync);
        var jackettUpdateItem = new ToolStripMenuItem("Проверить обновление", null, async (_, _) => await CheckAndUpdateJackettAsync());
        jackettMenu.DropDownItems.AddRange([
            jackettOpenItem,
            new ToolStripSeparator(),
            trayJackettStartItem,
            trayJackettStopItem,
            trayJackettRestartItem,
            new ToolStripSeparator(),
            jackettUpdateItem
        ]);
        trayStartItem.Click += async (_, _) => await RunOperationAsync("Запуск…", StartTorrServerAsync);
        trayStopItem.Click += async (_, _) => await RunOperationAsync("Остановка…", StopTorrServerAsync);
        trayRestartItem.Click += async (_, _) => await RunOperationAsync("Перезапуск…", RestartTorrServerAsync);
        var checkItem = new ToolStripMenuItem("Проверить обновления", null, async (_, _) => await CheckForUpdatesAsync(showUpToDateMessage: true));
        var exitItem = new ToolStripMenuItem("Выход", null, (_, _) => ExitApplication());
        menu.Items.AddRange([
            openManagerItem,
            openWebItem,
            pluginHubItem,
            jackettMenu,
            new ToolStripSeparator(),
            trayStartItem,
            trayStopItem,
            trayRestartItem,
            new ToolStripSeparator(),
            checkItem,
            new ToolStripSeparator(),
            exitItem
        ]);

        trayIcon.Text = $"TorrServer Manager v{AppVersion}";
        trayIcon.ContextMenuStrip = menu;
        trayIcon.Visible = true;
        trayIcon.DoubleClick += (_, _) => ShowFromTray();
        SetTrayIcon(Amber);
    }

    private async Task RunOperationAsync(string activity, Func<CancellationToken, Task> operation)
    {
        if (busy || !await torrServerOperationLock.WaitAsync(0))
            return;
        SetBusy(true, activity);
        try
        {
            await operation(lifetime.Token);
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "TorrServer Manager", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetBusy(false, null);
            torrServerOperationLock.Release();
            await RefreshStatusAsync();
        }
    }

    private async Task StartTorrServerAsync(CancellationToken cancellationToken)
    {
        torrServerDesiredRunning = true;
        torrServerRecovery.Reset();
        await controller.StartAsync(cancellationToken);
    }

    private async Task StopTorrServerAsync(CancellationToken cancellationToken)
    {
        torrServerDesiredRunning = false;
        torrServerRecovery.Reset();
        await controller.StopAsync(cancellationToken);
    }

    private async Task RestartTorrServerAsync(CancellationToken cancellationToken)
    {
        torrServerDesiredRunning = true;
        torrServerRecovery.Reset();
        await controller.RestartAsync(cancellationToken);
    }

    private async Task RunJackettOperationAsync(string activity, Func<CancellationToken, Task> operation)
    {
        if (jackettBusy || !await jackettStackOperationLock.WaitAsync(0))
            return;
        SetJackettBusy(true, activity);
        try
        {
            await operation(lifetime.Token);
        }
        catch (OperationCanceledException exception) when (!lifetime.IsCancellationRequested)
        {
            MessageBox.Show(this, exception.Message, "Jackett", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Jackett", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetJackettBusy(false, null);
            jackettStackOperationLock.Release();
            await RefreshStatusAsync();
        }
    }

    private async Task StartJackettStackAsync(CancellationToken cancellationToken)
    {
        flareSolverrDesiredRunning = true;
        jackettDesiredRunning = true;
        flareSolverrRecovery.Reset();
        jackettRecovery.Reset();
        await flareSolverrController.StartAsync(cancellationToken);
        jackettController.ConfigureFlareSolverr(flareSolverrController.LocalUrl);
        await jackettController.StartAsync(cancellationToken);
    }

    private async Task StopJackettStackAsync(CancellationToken cancellationToken)
    {
        jackettDesiredRunning = false;
        flareSolverrDesiredRunning = false;
        jackettRecovery.Reset();
        flareSolverrRecovery.Reset();
        await jackettController.StopAsync(cancellationToken);
        await flareSolverrController.StopAsync(cancellationToken);
    }

    private async Task RestartJackettStackAsync(CancellationToken cancellationToken)
    {
        jackettDesiredRunning = true;
        flareSolverrDesiredRunning = true;
        jackettRecovery.Reset();
        flareSolverrRecovery.Reset();
        await jackettController.StopAsync(cancellationToken);
        await flareSolverrController.StopAsync(cancellationToken);
        await Task.Delay(400, cancellationToken);
        await flareSolverrController.StartAsync(cancellationToken);
        jackettController.ConfigureFlareSolverr(flareSolverrController.LocalUrl);
        await jackettController.StartAsync(cancellationToken);
    }

    private async Task RunFlareSolverrOperationAsync(string activity, Func<CancellationToken, Task> operation)
    {
        if (flareSolverrBusy || !await jackettStackOperationLock.WaitAsync(0))
            return;
        SetFlareSolverrBusy(true, activity);
        try
        {
            await operation(lifetime.Token);
        }
        catch (OperationCanceledException exception) when (!lifetime.IsCancellationRequested)
        {
            MessageBox.Show(this, exception.Message, "FlareSolverr", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "FlareSolverr", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetFlareSolverrBusy(false, null);
            jackettStackOperationLock.Release();
            await RefreshStatusAsync();
        }
    }

    private async Task StartFlareSolverrAsync(CancellationToken cancellationToken)
    {
        flareSolverrDesiredRunning = true;
        flareSolverrRecovery.Reset();
        await flareSolverrController.StartAsync(cancellationToken);
    }

    private async Task StopFlareSolverrAsync(CancellationToken cancellationToken)
    {
        flareSolverrDesiredRunning = false;
        flareSolverrRecovery.Reset();
        await flareSolverrController.StopAsync(cancellationToken);
    }

    private async Task RestartFlareSolverrAsync(CancellationToken cancellationToken)
    {
        flareSolverrDesiredRunning = true;
        flareSolverrRecovery.Reset();
        await flareSolverrController.RestartAsync(cancellationToken);
    }

    private async Task CheckFlareSolverrUpdateInBackgroundAsync()
    {
        if (lifetime.IsCancellationRequested || !await jackettStackOperationLock.WaitAsync(0))
            return;

        try
        {
            var status = await flareSolverrController.GetStatusAsync(lifetime.Token);
            if (!status.IsInstalled)
                return;

            var release = await flareSolverrController.GetLatestReleaseAsync(lifetime.Token);
            var updateAvailable = FlareSolverrController.IsNewer(release.Version, status.Version);
            AppLog.Write($"FlareSolverr update check: installed={status.Version}, latest={release.Version}, result={(updateAvailable ? "update available" : "up to date") }.");
            if (!updateAvailable)
                return;

            AppLog.Write($"FlareSolverr update available: {status.Version} -> {release.Version}. Installing in background.");
            var keepRunning = flareSolverrDesiredRunning;
            await flareSolverrController.InstallUpdateAsync(release, cancellationToken: lifetime.Token);
            if (!keepRunning)
                await flareSolverrController.StopAsync(lifetime.Token);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception)
        {
            AppLog.Write($"FlareSolverr background update failed: {exception}");
        }
        finally
        {
            jackettStackOperationLock.Release();
        }
    }

    private async Task SuperviseProcessesAsync()
    {
        if (lifetime.IsCancellationRequested || !await supervisorLock.WaitAsync(0))
            return;

        try
        {
            await SuperviseFlareSolverrAsync(lifetime.Token);
            await SuperviseJackettAsync(lifetime.Token);
            await SuperviseTorrServerAsync(lifetime.Token);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception)
        {
            AppLog.Write($"Supervisor cycle failed: {exception}");
        }
        finally
        {
            supervisorLock.Release();
        }
    }

    private async Task SuperviseTorrServerAsync(CancellationToken cancellationToken)
    {
        if (!torrServerDesiredRunning)
        {
            torrServerRecovery.Reset();
            return;
        }
        if (!await torrServerOperationLock.WaitAsync(0, cancellationToken))
            return;

        try
        {
            var status = await controller.GetStatusAsync(cancellationToken);
            if (!torrServerRecovery.Observe(status.IsRunning, status.ProcessRunning) ||
                !torrServerRecovery.CanAttempt(DateTimeOffset.UtcNow))
                return;

            AppLog.Write($"Supervisor attempting to recover TorrServer ({(status.ProcessRunning ? "restart" : "start")}).");
            if (status.ProcessRunning)
                await controller.RestartAsync(cancellationToken);
            else
                await controller.StartAsync(cancellationToken);
            torrServerRecovery.MarkAttemptSucceeded();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception exception)
        {
            torrServerRecovery.MarkAttemptFailed(exception);
        }
        finally
        {
            torrServerOperationLock.Release();
        }
    }

    private async Task SuperviseJackettAsync(CancellationToken cancellationToken)
    {
        if (!jackettDesiredRunning)
        {
            jackettRecovery.Reset();
            return;
        }
        if (!await jackettStackOperationLock.WaitAsync(0, cancellationToken))
            return;

        try
        {
            var status = await jackettController.GetStatusAsync(cancellationToken);
            if (!jackettRecovery.Observe(status.IsRunning, status.ProcessRunning) ||
                !jackettRecovery.CanAttempt(DateTimeOffset.UtcNow))
                return;

            AppLog.Write($"Supervisor attempting to recover Jackett ({(status.ProcessRunning ? "restart" : "start")}).");
            jackettController.ConfigureFlareSolverr(flareSolverrController.LocalUrl);
            if (status.ProcessRunning)
                await jackettController.RestartAsync(cancellationToken);
            else
                await jackettController.StartAsync(cancellationToken);
            jackettRecovery.MarkAttemptSucceeded();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception exception)
        {
            jackettRecovery.MarkAttemptFailed(exception);
        }
        finally
        {
            jackettStackOperationLock.Release();
        }
    }

    private async Task SuperviseFlareSolverrAsync(CancellationToken cancellationToken)
    {
        if (!flareSolverrDesiredRunning)
        {
            flareSolverrRecovery.Reset();
            return;
        }
        if (!await jackettStackOperationLock.WaitAsync(0, cancellationToken))
            return;

        try
        {
            var status = await flareSolverrController.GetStatusAsync(cancellationToken);
            if (!flareSolverrRecovery.Observe(status.IsRunning, status.ProcessRunning) ||
                !flareSolverrRecovery.CanAttempt(DateTimeOffset.UtcNow))
                return;

            AppLog.Write($"Supervisor attempting to recover FlareSolverr ({(status.ProcessRunning ? "restart" : "start")}).");
            if (status.ProcessRunning)
                await flareSolverrController.RestartAsync(cancellationToken);
            else
                await flareSolverrController.StartAsync(cancellationToken);
            flareSolverrRecovery.MarkAttemptSucceeded();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception exception)
        {
            flareSolverrRecovery.MarkAttemptFailed(exception);
        }
        finally
        {
            jackettStackOperationLock.Release();
        }
    }

    private async Task CheckAndUpdateJackettAsync()
    {
        if (jackettBusy || !await jackettStackOperationLock.WaitAsync(0))
            return;
        SetJackettBusy(true, "Проверка обновления…");
        try
        {
            var status = await jackettController.GetStatusAsync(lifetime.Token);
            var release = await jackettController.GetLatestReleaseAsync(lifetime.Token);
            if (!JackettController.IsNewer(release.Version, status.Version))
            {
                MessageBox.Show(this, $"Установлена актуальная версия Jackett {status.Version}.", "Jackett", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var answer = MessageBox.Show(
                this,
                $"Установить Jackett {release.Version}?\n\nПроцесс будет кратковременно перезапущен.",
                "Обновление Jackett",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (answer != DialogResult.Yes)
                return;

            jackettStatusText.Text = "Обновление…";
            var progress = new Progress<string>(message => jackettDetails.Text = message);
            var keepRunning = jackettDesiredRunning;
            await jackettController.InstallUpdateAsync(release, progress, lifetime.Token);
            if (!keepRunning)
                await jackettController.StopAsync(lifetime.Token);
            var updated = await jackettController.GetStatusAsync(lifetime.Token);
            MessageBox.Show(this, $"Jackett обновлён до {updated.Version}.", "Jackett", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Обновление Jackett", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetJackettBusy(false, null);
            jackettStackOperationLock.Release();
            await RefreshStatusAsync();
        }
    }

    private async Task RefreshStatusAsync()
    {
        if (!await refreshLock.WaitAsync(0))
            return;
        try
        {
            var status = await controller.GetStatusAsync(lifetime.Token);
            var jackettStatus = await jackettController.GetStatusAsync(lifetime.Token);
            var flareSolverrStatus = await flareSolverrController.GetStatusAsync(lifetime.Token);
            versionValue.Text = status.Version;
            addressValue.Text = status.LanAddress;
            hubAddress.Text = pluginHub.LanLoaderUrl;
            UpdateLampaAppCaption();

            if (status.IsRunning)
            {
                statusDot.ForeColor = Green;
                statusText.Text = "Работает";
                statusDetails.Text = status.ProcessId is int pid
                    ? $"PID {pid} · веб-интерфейс отвечает"
                    : "Веб-интерфейс отвечает";
                SetTrayIcon(Green);
            }
            else if (status.ProcessRunning)
            {
                statusDot.ForeColor = Amber;
                statusText.Text = "Запускается";
                statusDetails.Text = "Процесс работает, ожидается веб-интерфейс";
                SetTrayIcon(Amber);
            }
            else
            {
                statusDot.ForeColor = Red;
                statusText.Text = "Остановлен";
                statusDetails.Text = torrServerDesiredRunning
                    ? "Процесс не найден · автоматическое восстановление"
                    : "Остановлен вручную · автозапуск выключен";
                SetTrayIcon(Red);
            }

            startButton.Enabled = !busy && !status.ProcessRunning;
            stopButton.Enabled = !busy && status.ProcessRunning;
            restartButton.Enabled = !busy && status.ProcessRunning;
            openButton.Enabled = status.HttpResponding;
            trayStartItem.Enabled = !busy && !status.ProcessRunning;
            trayStopItem.Enabled = !busy && status.ProcessRunning;
            trayRestartItem.Enabled = !busy && status.ProcessRunning;

            jackettVersionValue.Text = jackettStatus.Version;
            jackettLanAddress.Text = pluginHub.JackettProxyUrl;
            jackettApiKeyValue.Text = $"API-ключ: {jackettController.GetApiKey() ?? "—"}";
            if (jackettStatus.IsRunning)
            {
                jackettDot.ForeColor = Green;
                jackettStatusText.Text = "Работает";
                jackettDetails.Text = $"Источников: {jackettStatus.ConfiguredIndexers}";
            }
            else if (jackettStatus.ProcessRunning)
            {
                jackettDot.ForeColor = Amber;
                jackettStatusText.Text = "Запускается";
                jackettDetails.Text = "Процесс работает, ожидается веб-интерфейс";
            }
            else if (jackettStatus.IsInstalled)
            {
                jackettDot.ForeColor = Red;
                jackettStatusText.Text = "Остановлен";
                jackettDetails.Text = jackettDesiredRunning
                    ? "Автоматическое восстановление"
                    : "Остановлен вручную · автозапуск выключен";
            }
            else
            {
                jackettDot.ForeColor = Red;
                jackettStatusText.Text = "Не установлен";
                jackettDetails.Text = "Локальный Torznab недоступен";
            }

            jackettStartButton.Enabled = !jackettBusy && jackettStatus.IsInstalled && !jackettStatus.ProcessRunning;
            jackettStopButton.Enabled = !jackettBusy && (jackettStatus.ProcessRunning || flareSolverrStatus.ProcessRunning);
            jackettRestartButton.Enabled = !jackettBusy && jackettStatus.IsInstalled && flareSolverrStatus.IsInstalled;
            jackettOpenButton.Enabled = jackettStatus.IsRunning;
            jackettUpdateButton.Enabled = !jackettBusy && jackettStatus.IsInstalled;
            trayJackettStartItem.Enabled = !jackettBusy && jackettStatus.IsInstalled && !jackettStatus.ProcessRunning;
            trayJackettStopItem.Enabled = !jackettBusy && jackettStatus.ProcessRunning;
            trayJackettRestartItem.Enabled = !jackettBusy && jackettStatus.ProcessRunning;

            flareSolverrDot.ForeColor = flareSolverrStatus.IsRunning ? Green : flareSolverrStatus.ProcessRunning ? Amber : Red;
            flareSolverrStatusText.Text = flareSolverrStatus.IsRunning
                ? "Работает"
                : flareSolverrStatus.ProcessRunning ? "Запускается" : flareSolverrStatus.IsInstalled ? "Остановлен" : "Не установлен";
            flareSolverrDetails.Text = flareSolverrStatus.IsRunning
                ? $"API: {flareSolverrController.LocalUrl} · PID {flareSolverrStatus.ProcessId}"
                : flareSolverrStatus.IsInstalled
                    ? flareSolverrDesiredRunning ? "API недоступен · автоматическое восстановление" : "Остановлен вручную · автозапуск выключен"
                    : "Положите flaresolverr.exe в ProgramData\\FlareSolverr";
            flareSolverrVersionValue.Text = flareSolverrStatus.Version;
            flareSolverrStartButton.Enabled = !flareSolverrBusy && flareSolverrStatus.IsInstalled && !flareSolverrStatus.ProcessRunning;
            flareSolverrStopButton.Enabled = !flareSolverrBusy && flareSolverrStatus.ProcessRunning;
            flareSolverrRestartButton.Enabled = !flareSolverrBusy && flareSolverrStatus.IsInstalled && flareSolverrStatus.ProcessRunning;
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception)
        {
            AppLog.Write(exception);
        }
        finally
        {
            refreshLock.Release();
        }
    }

    private async Task CheckForUpdatesAsync(bool showUpToDateMessage)
    {
        if (busy)
            return;
        SetBusy(true, "Проверка обновлений…");
        updateText.Text = "Связь с официальными релизами GitHub…";
        try
        {
            var installed = await controller.GetInstalledVersionAsync(lifetime.Token);
            var release = await updateService.GetLatestReleaseAsync(lifetime.Token);
            if (UpdateService.IsNewer(release.Version, installed))
            {
                availableRelease = release;
                updateText.Text = $"Доступна {release.Version} · установлена {installed} · нужна пересборка";
                updateButton.Enabled = true;
                trayIcon.ShowBalloonTip(5000, "Доступно обновление", $"TorrServer {release.Version}: нужна пересборка", ToolTipIcon.Info);
            }
            else
            {
                availableRelease = null;
                updateButton.Enabled = false;
                updateText.Text = $"Установлена актуальная версия {installed}";
                if (showUpToDateMessage)
                    MessageBox.Show(this, "Установлена актуальная версия TorrServer.", "Обновления", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            updateText.Text = "Не удалось проверить обновления";
            MessageBox.Show(this, exception.Message, "Проверка обновлений", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetBusy(false, null);
            updateButton.Enabled = availableRelease is not null;
        }
    }

    private void OpenTorrServerUpdateGuide()
    {
        if (availableRelease is null)
            return;
        var answer = MessageBox.Show(
            this,
            $"Доступна версия TorrServer {availableRelease.Version}.\n\n" +
            "Автоматическая установка отключена: текущий бинарник содержит локальные изменения GST. " +
            "Откройте исходники, примените patch и пересоберите TorrServer по инструкции проекта.\n\n" +
            "Открыть исходники TorrServer?",
            "Обновление TorrServer",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Information);
        if (answer != DialogResult.Yes)
            return;
        try
        {
            Process.Start(new ProcessStartInfo(UpdateService.SourceRepositoryUrl) { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Исходники TorrServer", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void SetBusy(bool value, string? activity)
    {
        busy = value;
        checkButton.Enabled = !value;
        updateButton.Enabled = !value && availableRelease is not null;
        if (value && activity is not null)
        {
            statusDot.ForeColor = Amber;
            statusText.Text = activity;
            SetTrayIcon(Amber);
        }
    }

    private void SetJackettBusy(bool value, string? activity)
    {
        jackettBusy = value;
        jackettStartButton.Enabled = !value;
        jackettStopButton.Enabled = !value;
        jackettRestartButton.Enabled = !value;
        jackettUpdateButton.Enabled = !value;
        if (value && activity is not null)
        {
            jackettDot.ForeColor = Amber;
            jackettStatusText.Text = activity;
        }
    }

    private void SetFlareSolverrBusy(bool value, string? activity)
    {
        flareSolverrBusy = value;
        flareSolverrStartButton.Enabled = !value;
        flareSolverrStopButton.Enabled = !value;
        flareSolverrRestartButton.Enabled = !value;
        if (value && activity is not null)
        {
            flareSolverrDot.ForeColor = Amber;
            flareSolverrStatusText.Text = activity;
        }
    }

    private void OpenWebInterface(bool useLanAddress)
    {
        try
        {
            Process.Start(new ProcessStartInfo(useLanAddress ? controller.LanUrl : controller.LocalUrl)
            {
                UseShellExecute = true
        });
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Открытие веб-интерфейса", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OpenPluginHub()
    {
        try
        {
            Process.Start(new ProcessStartInfo(pluginHub.LocalPanelUrl) { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Плагины Lampa", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OpenLampaApp()
    {
        try
        {
            Process.Start(new ProcessStartInfo(pluginHub.LampaAppUrl) { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Lampa", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task RefreshLampaAppAsync()
    {
        if (lampaAppBusy)
            return;
        lampaAppBusy = true;
        lampaAppUpdateButton.Enabled = false;
        var originalText = lampaAppUpdateButton.Text;
        lampaAppUpdateButton.Text = "Обновление…";
        try
        {
            await pluginHub.RefreshLampaAppAsync(lifetime.Token);
        }
        catch (OperationCanceledException) when (!lifetime.IsCancellationRequested) { }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Обновление Lampa", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            lampaAppUpdateButton.Text = originalText;
            lampaAppUpdateButton.Enabled = true;
            lampaAppBusy = false;
            UpdateLampaAppCaption();
        }
    }

    private void UpdateLampaAppCaption()
    {
        var status = pluginHub.GetLampaAppStatus();
        lampaAppAddress.Text = pluginHub.LampaAppUrl;

        if (!status.Installed)
        {
            lampaAppCaption.Text = string.IsNullOrEmpty(status.LastError)
                ? "Приложение для ТВ и браузера · загрузка версии…"
                : $"Приложение для ТВ и браузера · ошибка загрузки: {status.LastError}";
            return;
        }

        lampaAppCaption.Text = string.IsNullOrEmpty(status.LastError)
            ? $"Приложение для ТВ и браузера · версия {status.Version}"
            : $"Приложение для ТВ и браузера · версия {status.Version} · обновление не удалось: {status.LastError}";
    }

    private void OpenJackett()
    {
        try
        {
            Process.Start(new ProcessStartInfo(jackettController.LocalUrl + "/UI/Dashboard") { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, exception.Message, "Jackett", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void HideToTray()
    {
        ShowInTaskbar = false;
        Hide();
    }

    private void ExitApplication()
    {
        allowExit = true;
        trayIcon.Visible = false;
        Close();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!allowExit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }

        statusTimer.Stop();
        lifetime.Cancel();
        flareSolverrUpdateTimer.Dispose();
        supervisorTimer.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        currentIcon?.Dispose();
        updateService.Dispose();
        jackettController.Dispose();
        flareSolverrController.Dispose();
        pluginHub.Dispose();
        controller.Dispose();
        ffprobeService.Dispose();
        gStreamerService.Dispose();
        refreshLock.Dispose();
        supervisorLock.Dispose();
        torrServerOperationLock.Dispose();
        jackettStackOperationLock.Dispose();
        lifetime.Dispose();
    }

    private void SetTrayIcon(Color color)
    {
        if (currentIcon is not null && currentIconColor == color.ToArgb() && trayIcon.Icon is not null)
            return;
        var next = IconFactory.Create(color);
        trayIcon.Icon = next;
        Icon = next;
        var previous = currentIcon;
        currentIcon = next;
        currentIconColor = color.ToArgb();
        previous?.Dispose();
    }

    private static Panel CreateCard(Rectangle bounds) => new()
    {
        Bounds = bounds,
        BackColor = Color.White,
        BorderStyle = BorderStyle.FixedSingle,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
    };

    private static Label CreateCaption(string text, Point location) => new()
    {
        Text = text,
        ForeColor = Muted,
        AutoSize = true,
        Location = location
    };

    private static void CopyToClipboard(Button button, string text)
    {
        if (string.IsNullOrEmpty(text))
            return;
        try { Clipboard.SetText(text); }
        catch { return; }

        var original = button.Text;
        button.Text = "✓ Скопировано";
        var timer = new System.Windows.Forms.Timer { Interval = 1500 };
        timer.Tick += (_, _) =>
        {
            button.Text = original;
            timer.Stop();
            timer.Dispose();
        };
        timer.Start();
    }

    private static FlowLayoutPanel CreateButtonRow(Point location, Size size, int buttonHeight, params Button[] buttons)
    {
        var row = new FlowLayoutPanel
        {
            Location = location,
            Size = size,
            Padding = Padding.Empty,
            Margin = Padding.Empty,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            AutoScroll = false,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
        };

        for (var index = 0; index < buttons.Length; index++)
        {
            var button = buttons[index];
            button.AutoSize = true;
            button.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            button.MinimumSize = new Size(button.Width, buttonHeight);
            button.Height = buttonHeight;
            button.Margin = new Padding(0, 0, index == buttons.Length - 1 ? 0 : 4, 0);
            row.Controls.Add(button);
        }

        return row;
    }

    private static Button CreateButton(string text, Color backColor, Point location, int width) => new()
    {
        Text = text,
        Location = location,
        Size = new Size(width, 40),
        FlatStyle = FlatStyle.Flat,
        BackColor = backColor,
        ForeColor = Color.White,
        Cursor = Cursors.Hand,
        FlatAppearance = { BorderSize = 0 }
    };
}
