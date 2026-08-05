using System.Diagnostics;

namespace TorrServerManager;

internal sealed class MainForm : Form
{
    private static readonly Color Accent = Color.FromArgb(37, 99, 235);
    private static readonly Color Green = Color.FromArgb(22, 163, 74);
    private static readonly Color Amber = Color.FromArgb(217, 119, 6);
    private static readonly Color Red = Color.FromArgb(220, 38, 38);
    private static readonly Color Muted = Color.FromArgb(100, 116, 139);

    private readonly ServerController controller = new();
    private readonly JackettController jackettController = new();
    private readonly UpdateService updateService;
    private readonly PluginHub pluginHub = new();
    private readonly NotifyIcon trayIcon = new();
    private readonly System.Windows.Forms.Timer statusTimer = new() { Interval = 2500 };
    private readonly SemaphoreSlim refreshLock = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();

    private readonly Label statusDot = new();
    private readonly Label statusText = new();
    private readonly Label statusDetails = new();
    private readonly Label versionValue = new();
    private readonly LinkLabel addressValue = new();
    private readonly Label updateText = new();
    private readonly Label jackettDot = new();
    private readonly Label jackettStatusText = new();
    private readonly Label jackettDetails = new();
    private readonly Label jackettVersionValue = new();
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
    private Icon? currentIcon;
    private int? currentIconColor;

    public MainForm(bool startInBackground)
    {
        updateService = new UpdateService(controller);
        AppPaths.EnsureDirectories();

        Text = "TorrServer Manager";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(620, 640);
        MinimumSize = new Size(620, 640);
        MaximumSize = new Size(780, 760);
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
            Text = "Сервер для Lampa и устройств в локальной сети",
            ForeColor = Muted,
            AutoSize = true,
            Location = new Point(27, 52)
        };
        Controls.Add(title);
        Controls.Add(subtitle);

        var statusPanel = CreateCard(new Rectangle(24, 82, 572, 112));
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
        statusDetails.AutoSize = true;
        statusDetails.Location = new Point(59, 50);
        var versionCaption = CreateCaption("Версия", new Point(340, 18));
        versionValue.Text = "—";
        versionValue.AutoSize = true;
        versionValue.Location = new Point(430, 18);
        var addressCaption = CreateCaption("Для Lampa", new Point(340, 51));
        addressValue.Text = controller.LanUrl;
        addressValue.AutoSize = true;
        addressValue.Location = new Point(430, 51);
        addressValue.LinkColor = Accent;
        addressValue.LinkClicked += (_, _) => OpenWebInterface(useLanAddress: true);
        statusPanel.Controls.AddRange([statusDot, statusText, statusDetails, versionCaption, versionValue, addressCaption, addressValue]);
        Controls.Add(statusPanel);

        startButton = CreateButton("Запустить", Accent, new Point(24, 214), 106);
        stopButton = CreateButton("Остановить", Color.FromArgb(71, 85, 105), new Point(140, 214), 112);
        restartButton = CreateButton("Перезапустить", Color.FromArgb(71, 85, 105), new Point(262, 214), 132);
        openButton = CreateButton("Открыть веб", Green, new Point(404, 214), 132);
        Controls.AddRange([startButton, stopButton, restartButton, openButton]);

        var hubPanel = CreateCard(new Rectangle(24, 274, 572, 80));
        var hubTitle = new Label
        {
            Text = "Плагины Lampa",
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 12)
        };
        var hubAddress = new LinkLabel
        {
            Text = pluginHub.LanLoaderUrl,
            AutoSize = true,
            Location = new Point(19, 43),
            LinkColor = Accent
        };
        hubAddress.LinkClicked += (_, _) => OpenPluginHub();
        var hubButton = CreateButton("Управлять", Color.FromArgb(124, 58, 237), new Point(440, 19), 108);
        hubButton.Click += (_, _) => OpenPluginHub();
        hubPanel.Controls.AddRange([hubTitle, hubAddress, hubButton]);
        Controls.Add(hubPanel);

        var jackettPanel = CreateCard(new Rectangle(24, 370, 572, 132));
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
        jackettDetails.AutoSize = true;
        jackettDetails.Location = new Point(185, 39);
        var jackettVersionCaption = CreateCaption("Версия", new Point(410, 39));
        jackettVersionValue.Text = "—";
        jackettVersionValue.AutoSize = true;
        jackettVersionValue.Location = new Point(468, 39);
        var rutrackerLink = new LinkLabel
        {
            Text = "RuTracker.org: настроить аккаунт",
            AutoSize = true,
            LinkColor = Accent,
            Location = new Point(20, 64)
        };
        rutrackerLink.LinkClicked += async (_, _) => await ConfigureRutrackerAsync();
        jackettStartButton = CreateButton("Запустить", Accent, new Point(18, 86), 96);
        jackettStopButton = CreateButton("Остановить", Color.FromArgb(71, 85, 105), new Point(122, 86), 100);
        jackettRestartButton = CreateButton("Перезапустить", Color.FromArgb(71, 85, 105), new Point(230, 86), 112);
        jackettOpenButton = CreateButton("Открыть", Green, new Point(350, 86), 94);
        jackettUpdateButton = CreateButton("Обновить", Color.FromArgb(124, 58, 237), new Point(452, 86), 102);
        foreach (var button in new[] { jackettStartButton, jackettStopButton, jackettRestartButton, jackettOpenButton, jackettUpdateButton })
        {
            button.Height = 32;
            button.Top = 88;
        }
        jackettPanel.Controls.AddRange([
            jackettTitle, jackettDot, jackettStatusText, jackettDetails,
            jackettVersionCaption, jackettVersionValue, rutrackerLink,
            jackettStartButton, jackettStopButton, jackettRestartButton, jackettOpenButton, jackettUpdateButton
        ]);
        Controls.Add(jackettPanel);

        var updatePanel = CreateCard(new Rectangle(24, 518, 572, 94));
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
        updateText.Size = new Size(295, 24);
        checkButton = CreateButton("Проверить", Color.FromArgb(71, 85, 105), new Point(330, 24), 100);
        updateButton = CreateButton("Обновить", Accent, new Point(440, 24), 108);
        updateButton.Enabled = false;
        updatePanel.Controls.AddRange([updateTitle, updateText, checkButton, updateButton]);
        Controls.Add(updatePanel);

        startButton.Click += async (_, _) => await RunOperationAsync("Запуск…", controller.StartAsync);
        stopButton.Click += async (_, _) => await RunOperationAsync("Остановка…", controller.StopAsync);
        restartButton.Click += async (_, _) => await RunOperationAsync("Перезапуск…", controller.RestartAsync);
        openButton.Click += (_, _) => OpenWebInterface(useLanAddress: false);
        checkButton.Click += async (_, _) => await CheckForUpdatesAsync(showUpToDateMessage: true);
        updateButton.Click += async (_, _) => await InstallAvailableUpdateAsync();
        jackettStartButton.Click += async (_, _) => await RunJackettOperationAsync("Запуск…", jackettController.StartAsync);
        jackettStopButton.Click += async (_, _) => await RunJackettOperationAsync("Остановка…", jackettController.StopAsync);
        jackettRestartButton.Click += async (_, _) => await RunJackettOperationAsync("Перезапуск…", jackettController.RestartAsync);
        jackettOpenButton.Click += (_, _) => OpenJackett();
        jackettUpdateButton.Click += async (_, _) => await CheckAndUpdateJackettAsync();

        ConfigureTrayIcon();
        statusTimer.Tick += async (_, _) => await RefreshStatusAsync();
        Load += async (_, _) =>
        {
            if (startInBackground)
            {
                ShowInTaskbar = false;
                Hide();
            }

            try { pluginHub.Start(); }
            catch (Exception exception)
            {
                AppLog.Write(exception);
                trayIcon.ShowBalloonTip(5000, "Lampa Plugin Hub не запущен", exception.Message, ToolTipIcon.Error);
            }

            try { await controller.StartAsync(lifetime.Token); }
            catch (Exception exception)
            {
                AppLog.Write(exception);
                trayIcon.ShowBalloonTip(5000, "TorrServer не запущен", exception.Message, ToolTipIcon.Error);
            }

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
        var jackettRutrackerItem = new ToolStripMenuItem("Настроить RuTracker.org", null, async (_, _) => await ConfigureRutrackerAsync());
        trayJackettStartItem.Click += async (_, _) => await RunJackettOperationAsync("Запуск…", jackettController.StartAsync);
        trayJackettStopItem.Click += async (_, _) => await RunJackettOperationAsync("Остановка…", jackettController.StopAsync);
        trayJackettRestartItem.Click += async (_, _) => await RunJackettOperationAsync("Перезапуск…", jackettController.RestartAsync);
        var jackettUpdateItem = new ToolStripMenuItem("Проверить обновление", null, async (_, _) => await CheckAndUpdateJackettAsync());
        jackettMenu.DropDownItems.AddRange([
            jackettOpenItem,
            jackettRutrackerItem,
            new ToolStripSeparator(),
            trayJackettStartItem,
            trayJackettStopItem,
            trayJackettRestartItem,
            new ToolStripSeparator(),
            jackettUpdateItem
        ]);
        trayStartItem.Click += async (_, _) => await RunOperationAsync("Запуск…", controller.StartAsync);
        trayStopItem.Click += async (_, _) => await RunOperationAsync("Остановка…", controller.StopAsync);
        trayRestartItem.Click += async (_, _) => await RunOperationAsync("Перезапуск…", controller.RestartAsync);
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

        trayIcon.Text = "TorrServer Manager";
        trayIcon.ContextMenuStrip = menu;
        trayIcon.Visible = true;
        trayIcon.DoubleClick += (_, _) => ShowFromTray();
        SetTrayIcon(Amber);
    }

    private async Task RunOperationAsync(string activity, Func<CancellationToken, Task> operation)
    {
        if (busy)
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
            await RefreshStatusAsync();
        }
    }

    private async Task RunJackettOperationAsync(string activity, Func<CancellationToken, Task> operation)
    {
        if (jackettBusy)
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
            await RefreshStatusAsync();
        }
    }

    private async Task CheckAndUpdateJackettAsync()
    {
        if (jackettBusy)
            return;
        SetJackettBusy(true, "Проверка обновления…");
        try
        {
            var status = await jackettController.GetStatusAsync(lifetime.Token);
            var latest = await jackettController.GetLatestVersionAsync(lifetime.Token);
            if (!JackettController.IsNewer(latest, status.Version))
            {
                MessageBox.Show(this, $"Установлена актуальная версия Jackett {status.Version}.", "Jackett", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var answer = MessageBox.Show(
                this,
                $"Установить Jackett {latest}?\n\nСлужба будет кратковременно перезапущена.",
                "Обновление Jackett",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (answer != DialogResult.Yes)
                return;

            jackettStatusText.Text = "Обновление…";
            await jackettController.TriggerBuiltInUpdateAsync(lifetime.Token);
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
            await RefreshStatusAsync();
        }
    }

    private async Task ConfigureRutrackerAsync()
    {
        if (jackettBusy)
            return;
        using var dialog = new RutrackerCredentialsDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK)
            return;

        SetJackettBusy(true, "Настройка RuTracker…");
        try
        {
            await jackettController.SaveRutrackerCredentialsAsync(
                dialog.Username,
                dialog.Password,
                lifetime.Token);
            MessageBox.Show(
                this,
                "RuTracker.org подключён к общему поиску. Перезапуск Lampa не требуется.",
                "RuTracker.org",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            var answer = MessageBox.Show(
                this,
                $"Не удалось подключить RuTracker.org:\n\n{exception.Message}\n\nОткрыть панель Jackett для проверки или CAPTCHA?",
                "RuTracker.org",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Error);
            if (answer == DialogResult.Yes)
                OpenJackett();
        }
        finally
        {
            SetJackettBusy(false, null);
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
            versionValue.Text = status.Version;
            addressValue.Text = status.LanAddress;

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
                statusDetails.Text = "Процесс TorrServer не найден";
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
            if (jackettStatus.IsRunning)
            {
                jackettDot.ForeColor = Green;
                jackettStatusText.Text = "Работает";
                jackettDetails.Text = $"Настроено источников: {jackettStatus.ConfiguredIndexers}";
            }
            else if (jackettStatus.IsInstalled)
            {
                jackettDot.ForeColor = Red;
                jackettStatusText.Text = "Остановлен";
                jackettDetails.Text = $"Настроено источников: {jackettStatus.ConfiguredIndexers}";
            }
            else
            {
                jackettDot.ForeColor = Red;
                jackettStatusText.Text = "Не установлен";
                jackettDetails.Text = "Локальный Torznab недоступен";
            }

            jackettStartButton.Enabled = !jackettBusy && jackettStatus.IsInstalled && !jackettStatus.IsRunning;
            jackettStopButton.Enabled = !jackettBusy && jackettStatus.IsRunning;
            jackettRestartButton.Enabled = !jackettBusy && jackettStatus.IsRunning;
            jackettOpenButton.Enabled = jackettStatus.IsRunning;
            jackettUpdateButton.Enabled = !jackettBusy && jackettStatus.IsRunning;
            trayJackettStartItem.Enabled = !jackettBusy && jackettStatus.IsInstalled && !jackettStatus.IsRunning;
            trayJackettStopItem.Enabled = !jackettBusy && jackettStatus.IsRunning;
            trayJackettRestartItem.Enabled = !jackettBusy && jackettStatus.IsRunning;
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
                updateText.Text = $"Доступна {release.Version} · установлена {installed}";
                updateButton.Enabled = true;
                trayIcon.ShowBalloonTip(5000, "Доступно обновление", $"TorrServer {release.Version}", ToolTipIcon.Info);
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

    private async Task InstallAvailableUpdateAsync()
    {
        if (availableRelease is null || busy)
            return;
        var answer = MessageBox.Show(
            this,
            $"Установить TorrServer {availableRelease.Version}?\n\nСервер будет кратковременно остановлен.",
            "Обновление TorrServer",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);
        if (answer != DialogResult.Yes)
            return;

        SetBusy(true, "Обновление…");
        var progress = new Progress<string>(message => updateText.Text = message);
        try
        {
            await updateService.InstallUpdateAsync(availableRelease, progress, lifetime.Token);
            availableRelease = null;
            updateButton.Enabled = false;
            MessageBox.Show(this, "TorrServer успешно обновлён.", "Обновление", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception exception)
        {
            AppLog.Write(exception);
            MessageBox.Show(this, $"Обновление не установлено.\n\n{exception.Message}", "Обновление", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetBusy(false, null);
            await RefreshStatusAsync();
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
        trayIcon.Visible = false;
        trayIcon.Dispose();
        currentIcon?.Dispose();
        updateService.Dispose();
        jackettController.Dispose();
        pluginHub.Dispose();
        controller.Dispose();
        refreshLock.Dispose();
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
