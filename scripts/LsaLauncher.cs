using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class LsaLauncher
{
    private static void Main(string[] args)
    {
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);
        var directory = AppDomain.CurrentDomain.BaseDirectory;
        var executable = Path.Combine(directory, "LSA-electron.exe");
        var info = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = directory,
            Arguments = JoinArguments(args),
        };
        Process.Start(info);
    }

    private static string JoinArguments(string[] args)
    {
        var builder = new StringBuilder();
        for (var i = 0; i < args.Length; i++)
        {
            if (i > 0) builder.Append(' ');
            builder.Append('"').Append(args[i].Replace("\"", "\\\"")).Append('"');
        }
        return builder.ToString();
    }
}
