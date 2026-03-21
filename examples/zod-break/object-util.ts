import { type objectUtil } from 'zod'

/**
 * Uses addQuestionMarks with explicit second type parameter R
 * to control which keys are required. In 3.23, R was removed —
 * this explicit usage causes a compile error.
 */
type Config = {
  host: string
  port: number
  debug?: boolean
}

// Force only 'host' to be required, making 'port' optional too
// In 3.22: works — R overrides which keys are required
// In 3.23: error — addQuestionMarks only takes 1 type parameter
type CustomRequired = objectUtil.addQuestionMarks<Config, 'host'>

const config: CustomRequired = {
  host: 'localhost',
}

console.log(config)
