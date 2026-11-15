import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { net } from 'electron';

const execFileAsync = promisify(execFile);
const readNetworkListManager = [
  "$ErrorActionPreference = 'Stop'",
  "$networkClass = [type]::GetTypeFromCLSID([guid]'DCB00C01-570F-4A9B-8D69-199FDBA5723B')",
  "$manager = [Activator]::CreateInstance($networkClass)",
  "if ($manager.IsConnectedToInternet) { 'online' } else { 'offline' }",
].join('\n');

export async function hasInternetConnection(signal?: AbortSignal): Promise<boolean> {
  if (!net.isOnline()) return false;
  if (process.platform !== 'win32') return true;

  const windows = process.env['SystemRoot'];
  if (!windows) return false;
  // Chromium can report online with only a LAN or disconnected VPN adapter.
  // Query the OS's Internet connectivity state without contacting the provider.
  try {
    const { stdout } = await execFileAsync(
      join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', readNetworkListManager],
      { windowsHide: true, timeout: 3000, signal },
    );
    return stdout.trim() === 'online';
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn('[network] 无法读取 Windows 网络连接状态，暂停云端识别');
    return false;
  }
}
