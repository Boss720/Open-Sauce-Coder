import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Convert a user-facing project name into a stable, Windows-safe folder name. */
export function projectSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project'
}

/**
 * Resolve a path while requiring it to be strictly inside baseDir.
 * Existing symlink/reparse-point segments are rejected so containment cannot
 * be bypassed after lexical normalization.
 */
export function assertSubpath(
  baseDir: string,
  relativeOrAbsPath: string,
  options?: { allowRoot?: boolean }
): string {
  const allowRoot = Boolean(options?.allowRoot)
  if (!baseDir.trim() || (!allowRoot && !relativeOrAbsPath.trim())) {
    throw new Error('Path and base directory must be non-empty.')
  }

  const base = resolve(baseDir)
  const target = isAbsolute(relativeOrAbsPath)
    ? resolve(relativeOrAbsPath)
    : resolve(base, relativeOrAbsPath)
  const rel = relative(base, target)

  if (allowRoot) {
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Path must stay strictly inside the project directory.')
    }
  } else {
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Path must stay strictly inside the project directory.')
    }
  }

  // Check every existing segment, including the base itself. On Windows,
  // lstat().isSymbolicLink() also catches directory junctions/reparse links.
  let current = base
  if (existsSync(current)) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('Symbolic-link project roots are not allowed.')
  }
  if (rel) {
    for (const segment of rel.split(sep)) {
      current = resolve(current, segment)
      if (!existsSync(current)) continue
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in project paths.')
    }
  }

  // Resolve both ends when possible as a second check against platform-specific
  // reparse behavior that may not surface as a conventional symbolic link.
  if (existsSync(base) && existsSync(target)) {
    const realBase = realpathSync.native(base)
    const realTarget = realpathSync.native(target)
    const realRel = relative(realBase, realTarget)
    if (allowRoot) {
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        throw new Error('Resolved path escapes the project directory.')
      }
    } else {
      if (!realRel || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        throw new Error('Resolved path escapes the project directory.')
      }
    }
  }

  return target
}
