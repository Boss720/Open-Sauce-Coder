import { execFile, type ChildProcess } from 'node:child_process'

/**
 * Terminate a process and its entire child process tree.
 * On Windows, spawns `taskkill /pid <pid> /T /F`.
 * On POSIX, sends `SIGKILL`.
 */
export function killProcessTree(proc: ChildProcess | number): void {
  const pid = typeof proc === 'number' ? proc : proc.pid
  if (!pid) return

  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      if (typeof proc !== 'number') {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
      }
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
