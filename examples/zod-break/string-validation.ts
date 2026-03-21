import { type StringValidation } from 'zod'

/**
 * Maps each string validation type to a human-readable label.
 * Exhaustive handling — breaks when new validations are added.
 */
export function getValidationLabel(validation: StringValidation): string {
  if (typeof validation === 'object') {
    if ('includes' in validation) return `Includes "${validation.includes}"`
    if ('startsWith' in validation) return `Starts with "${validation.startsWith}"`
    if ('endsWith' in validation) return `Ends with "${validation.endsWith}"`
    const _exhaustiveObj: never = validation
    return `Unknown: ${JSON.stringify(_exhaustiveObj)}`
  }

  switch (validation) {
    case 'email':
      return 'Email Address'
    case 'url':
      return 'URL'
    case 'emoji':
      return 'Emoji'
    case 'uuid':
      return 'UUID'
    case 'cuid':
      return 'CUID'
    case 'cuid2':
      return 'CUID2'
    case 'ulid':
      return 'ULID'
    case 'datetime':
      return 'Datetime'
    case 'ip':
      return 'IP Address'
    case 'regex':
      return 'Regex Pattern'
    // Exhaustive check
    default: {
      const _exhaustive: never = validation
      return `Unknown: ${_exhaustive}`
    }
  }
}
