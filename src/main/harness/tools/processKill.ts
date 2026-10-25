import { execFile, spawnSync, type ChildProcess } from 'node:child_process'

/**
 * Set once at app quit. Electron exits ~60 ms after 'before-quit', which cuts an async
 * taskkill off mid-run and orphans the grandchildren of a `cmd.exe /c` tool shell, so
 * during shutdown the Windows kill must block until taskkill has finished.
 */
let syncKill = false

/** Make Windows tree kills synchronous (shutdown) or non-blocking again (default). */
export function setSyncProcessKill(enabled: boolean): void {
  syncKill = enabled
}

function killDirect(proc: ChildProcess | number): void {
  if (typeof proc === 'number') return
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
}

/**
 * Terminate a process and its entire child process tree.
 * On Windows, runs `taskkill /pid <pid> /T /F` (blocking only in sync-kill mode).
 * On POSIX, sends `SIGKILL`.
 */
export function killProcessTree(proc: ChildProcess | number): void {
  const pid = typeof proc === 'number' ? proc : proc.pid
  if (!pid) return

  if (process.platform === 'win32') {
    if (syncKill) {
      try {
        const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 5000
        })
        if (result.error || result.status !== 0) killDirect(proc)
      } catch {
        killDirect(proc)
      }
      return
    }
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      killDirect(proc)
    })
    return
  }

  if (typeof proc !== 'number') {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
