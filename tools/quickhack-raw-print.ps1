param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("List", "Print")]
  [string]$Action,
  [string]$PrinterName,
  [string]$InputPath
)

$ErrorActionPreference = "Stop"

if ($Action -eq "List") {
  Add-Type -AssemblyName System.Drawing
  $defaultPrinter = (New-Object System.Drawing.Printing.PrinterSettings).PrinterName
  $printers = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters |
    ForEach-Object { [string]$_ } |
    Sort-Object |
    ForEach-Object {
      [pscustomobject]@{
        name = $_
        isDefault = ($_ -eq $defaultPrinter)
        isOffline = $false
        status = "UNKNOWN"
      }
    }
  @($printers) | ConvertTo-Json -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($PrinterName)) {
  throw "PrinterName is required."
}
if ([string]::IsNullOrWhiteSpace($InputPath) -or -not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
  throw "InputPath was not found."
}

if (-not ("QuickHack.RawPrinter" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace QuickHack {
  public static class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private class DOC_INFO_1 {
      [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
      [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
      [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr printer, int level, [In] DOC_INFO_1 docInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, IntPtr bytes, int count, out int written);

    public static int Send(string printerName, byte[] bytes) {
      IntPtr printer;
      if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed.");
      }

      try {
        DOC_INFO_1 document = new DOC_INFO_1 {
          pDocName = "QuickHack Logen labels",
          pOutputFile = null,
          pDataType = "RAW"
        };
        if (StartDocPrinter(printer, 1, document) == 0) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed.");
        }
        try {
          if (!StartPagePrinter(printer)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed.");
          }
          try {
            IntPtr unmanaged = Marshal.AllocCoTaskMem(bytes.Length);
            try {
              Marshal.Copy(bytes, 0, unmanaged, bytes.Length);
              int written;
              if (!WritePrinter(printer, unmanaged, bytes.Length, out written)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed.");
              }
              return written;
            } finally {
              Marshal.FreeCoTaskMem(unmanaged);
            }
          } finally {
            EndPagePrinter(printer);
          }
        } finally {
          EndDocPrinter(printer);
        }
      } finally {
        ClosePrinter(printer);
      }
    }
  }
}
"@
}

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $InputPath))
$written = [QuickHack.RawPrinter]::Send($PrinterName, $bytes)
[pscustomobject]@{
  ok = ($written -eq $bytes.Length)
  requestedBytes = $bytes.Length
  writtenBytes = $written
} | ConvertTo-Json -Compress
