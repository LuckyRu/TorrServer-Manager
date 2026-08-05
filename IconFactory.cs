using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace TorrServerManager;

internal static class IconFactory
{
    public static Icon Create(Color statusColor)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            using var darkBrush = new SolidBrush(Color.FromArgb(31, 41, 55));
            graphics.FillEllipse(darkBrush, 1, 1, 30, 30);
            using var letterFont = new Font("Segoe UI", 14, FontStyle.Bold, GraphicsUnit.Pixel);
            using var letterBrush = new SolidBrush(Color.White);
            var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            graphics.DrawString("T", letterFont, letterBrush, new RectangleF(2, 1, 28, 28), format);
            using var statusBrush = new SolidBrush(statusColor);
            graphics.FillEllipse(statusBrush, 21, 21, 10, 10);
            using var borderPen = new Pen(Color.White, 1.5f);
            graphics.DrawEllipse(borderPen, 21, 21, 10, 10);
        }

        var handle = bitmap.GetHicon();
        try
        {
            using var temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);
}
