using System;
using System.Threading;

[assembly: System.Reflection.AssemblyTitle("QuickHack MSIX PostgreSQL Preview Child")]
[assembly: System.Reflection.AssemblyCompany("QuickHack")]
[assembly: System.Reflection.AssemblyProduct("QuickHack MSIX Service Feasibility Fixture")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

internal static class QuickHackPreviewPostgresqlChild
{
    private static int Main(string[] args)
    {
        if (args.Length != 1 || !String.Equals(args[0], "--quickhack-msix-preview", StringComparison.Ordinal))
        {
            Console.Error.WriteLine("This executable is only valid inside the QuickHack MSIX service preview.");
            return 64;
        }
        while (true)
        {
            Thread.Sleep(1000);
        }
    }
}
