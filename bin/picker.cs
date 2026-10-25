using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_NOCHANGEDIR = 0x00000008;
    private const uint FOS_PATHMUSTEXIST = 0x00001000;
    private const uint SIGDN_FILESYSPATH = 0x80058000;

    [STAThread]
    private static int Main(string[] args)
    {
        string title = "选择下载目录";
        string initial = null;
        bool probe = false;
        int autoCloseMs = 0;
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "--title" && index + 1 < args.Length) title = args[++index];
            else if (args[index] == "--initial" && index + 1 < args.Length) initial = args[++index];
            else if (args[index] == "--probe") probe = true;
            else if (args[index] == "--auto-close-ms" && index + 1 < args.Length) int.TryParse(args[++index], out autoCloseMs);
        }
        if (probe)
        {
            WriteOut("ok");
            return 0;
        }

        int initResult = CoInitializeEx(IntPtr.Zero, 0x2);
        try
        {
            IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_PATHMUSTEXIST);
            dialog.SetTitle(title);
            if (!string.IsNullOrEmpty(initial))
            {
                try
                {
                    IShellItem folder;
                    SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
                    dialog.SetFolder(folder);
                }
                catch
                {
                    // 初始目录不可用时保持系统默认位置。
                }
            }

            if (autoCloseMs > 0)
            {
                Thread closer = new Thread(delegate()
                {
                    Thread.Sleep(autoCloseMs);
                    IntPtr window = FindWindow(null, title);
                    if (window != IntPtr.Zero) PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
                });
                closer.IsBackground = true;
                closer.Start();
            }

            Thread front = new Thread(delegate()
            {
                Thread.Sleep(200);
                IntPtr window = FindWindow(null, title);
                if (window != IntPtr.Zero)
                {
                    SetForegroundWindow(window);
                    BringWindowToTop(window);
                }
            });
            front.IsBackground = true;
            front.Start();

            IntPtr owner = IntPtr.Zero;
            int result = dialog.Show(owner);
            if (result != 0)
            {
                if (unchecked((uint)result) == 0x800704C7u) return 2;
                WriteError("show failed: 0x" + result.ToString("X8")
                    + " init=0x" + initResult.ToString("X8")
                    + " apartment=" + Thread.CurrentThread.GetApartmentState());
                return 3;
            }

            IShellItem selected;
            dialog.GetResult(out selected);
            IntPtr buffer;
            selected.GetDisplayName(SIGDN_FILESYSPATH, out buffer);
            string path = Marshal.PtrToStringUni(buffer);
            Marshal.FreeCoTaskMem(buffer);
            if (string.IsNullOrEmpty(path)) return 2;
            WriteOut(path);
            return 0;
        }
        catch (Exception error)
        {
            WriteError(error.Message);
            return 1;
        }
    }

    private static void WriteOut(string value)
    {
        using (StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
        {
            writer.Write(value);
            writer.Flush();
        }
    }

    private static void WriteError(string value)
    {
        using (StreamWriter writer = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
        {
            writer.Write(value);
            writer.Flush();
        }
    }

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint coInit);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        [MarshalAs(UnmanagedType.LPStruct)] Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW
    {
    }

    [ComImport]
    [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);

        void SetFileTypes(uint count, IntPtr filterSpec);

        void SetFileTypeIndex(uint index);

        void GetFileTypeIndex(out uint index);

        void Advise(IntPtr events, out uint cookie);

        void Unadvise(uint cookie);

        void SetOptions(uint options);

        void GetOptions(out uint options);

        void SetDefaultFolder(IShellItem folder);

        void SetFolder(IShellItem folder);

        void GetFolder(out IShellItem folder);

        void GetCurrentSelection(out IShellItem item);

        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);

        void GetFileName(out IntPtr name);

        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);

        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);

        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);

        void GetResult(out IShellItem item);

        void AddPlace(IShellItem item, uint flags);

        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);

        void Close(int result);

        void SetClientGuid(ref Guid guid);

        void ClearClientData();

        void SetFilter(IntPtr filter);

        void GetResults(out IntPtr enumString);

        void GetSelectedItems(out IntPtr items);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);

        void GetParent(out IShellItem parent);

        void GetDisplayName(uint nameType, out IntPtr name);

        void GetAttributes(uint mask, out uint attributes);

        void Compare(IShellItem other, uint hint, out int order);
    }
}
