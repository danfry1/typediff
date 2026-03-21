const frames = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F']

export function createSpinner() {
  let interval: ReturnType<typeof setInterval> | null = null
  let frameIndex = 0

  return {
    start(message: string) {
      if (!process.stderr.isTTY) return
      this.stop()
      frameIndex = 0
      interval = setInterval(() => {
        process.stderr.write(`\r  ${frames[frameIndex++ % frames.length]} ${message}`)
      }, 80)
    },
    stop() {
      if (interval) {
        clearInterval(interval)
        interval = null
        process.stderr.write('\r\x1b[K') // clear line
      }
    },
  }
}
