namespace TorrServerManager;

internal sealed class RutrackerCredentialsDialog : Form
{
    private readonly TextBox usernameBox = new();
    private readonly TextBox passwordBox = new();

    public RutrackerCredentialsDialog()
    {
        Text = "RuTracker.org — авторизация";
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(510, 295);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        Font = new Font("Segoe UI", 10F);
        BackColor = Color.White;

        var title = new Label
        {
            Text = "Подключить аккаунт RuTracker.org",
            Font = new Font("Segoe UI Semibold", 13F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(22, 18)
        };
        var note = new Label
        {
            Text = "Данные передаются только локальному Jackett.\nПароль хранится в конфигурации индексатора на этом ПК.",
            ForeColor = Color.FromArgb(100, 116, 139),
            AutoSize = false,
            Size = new Size(460, 40),
            Location = new Point(24, 51)
        };
        var usernameLabel = new Label { Text = "Логин", AutoSize = true, Location = new Point(24, 105) };
        usernameBox.Location = new Point(130, 101);
        usernameBox.Size = new Size(350, 28);
        var passwordLabel = new Label { Text = "Пароль", AutoSize = true, Location = new Point(24, 145) };
        passwordBox.Location = new Point(130, 141);
        passwordBox.Size = new Size(350, 28);
        passwordBox.UseSystemPasswordChar = true;
        var showPassword = new CheckBox
        {
            Text = "Показать пароль",
            AutoSize = true,
            Location = new Point(130, 177)
        };
        showPassword.CheckedChanged += (_, _) => passwordBox.UseSystemPasswordChar = !showPassword.Checked;

        var cancel = new Button
        {
            Text = "Отмена",
            DialogResult = DialogResult.Cancel,
            Location = new Point(298, 242),
            Size = new Size(88, 36)
        };
        var save = new Button
        {
            Text = "Сохранить",
            DialogResult = DialogResult.OK,
            Location = new Point(394, 242),
            Size = new Size(88, 36),
            BackColor = Color.FromArgb(37, 99, 235),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat
        };
        save.FlatAppearance.BorderSize = 0;

        AcceptButton = save;
        CancelButton = cancel;
        Controls.AddRange([title, note, usernameLabel, usernameBox, passwordLabel, passwordBox, showPassword, cancel, save]);
    }

    public string Username => usernameBox.Text;
    public string Password => passwordBox.Text;
}
