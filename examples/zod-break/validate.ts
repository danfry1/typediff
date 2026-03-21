import { type ZodStringCheck } from 'zod'

/**
 * Custom error formatter that handles every possible string check.
 * This uses TypeScript's exhaustive switch pattern — if a new check
 * kind is added without updating this function, tsc will error.
 */
export function formatStringError(check: ZodStringCheck): string {
  switch (check.kind) {
    case 'min':
      return `Must be at least ${check.value} characters`
    case 'max':
      return `Must be at most ${check.value} characters`
    case 'length':
      return `Must be exactly ${check.value} characters`
    case 'email':
      return 'Must be a valid email'
    case 'url':
      return 'Must be a valid URL'
    case 'emoji':
      return 'Must be an emoji'
    case 'uuid':
      return 'Must be a valid UUID'
    case 'cuid':
      return 'Must be a valid CUID'
    case 'cuid2':
      return 'Must be a valid CUID2'
    case 'ulid':
      return 'Must be a valid ULID'
    case 'regex':
      return `Must match pattern ${check.regex}`
    case 'includes':
      return `Must include "${check.value}"`
    case 'startsWith':
      return `Must start with "${check.value}"`
    case 'endsWith':
      return `Must end with "${check.value}"`
    case 'datetime':
      return 'Must be a valid datetime'
    case 'ip':
      return 'Must be a valid IP address'
    case 'trim':
      return 'Will be trimmed'
    case 'toLowerCase':
      return 'Will be lowercased'
    case 'toUpperCase':
      return 'Will be uppercased'
    // Exhaustive check — tsc errors if any case is unhandled
    default: {
      const _exhaustive: never = check
      return `Unknown check: ${(_exhaustive as any).kind}`
    }
  }
}
