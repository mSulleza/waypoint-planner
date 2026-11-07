import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

export interface Prompt {
  ask(question: string): Promise<string>
  // An answer that is never echoed on a terminal, such as a password.
  secret(question: string): Promise<string>
  say(line: string): void
}

export interface Input extends NodeJS.ReadableStream {
  isTTY?: boolean
}

// Lines are queued as they arrive, so piped input works as well as a terminal; readline echoes on a terminal, so muting its output hides a secret.
export function linePrompt(input: Input, output: NodeJS.WritableStream): Prompt & { close(): void } {
  const terminal = input.isTTY === true
  let muted = false
  const echo = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) output.write(chunk)
      done()
    },
  })
  const rl = createInterface({ input, output: echo, terminal, historySize: 0 })
  let closed = false
  rl.on('close', () => (closed = true))
  const lines = rl[Symbol.asyncIterator]()
  const next = async () => {
    const line = await lines.next()
    if (line.done) throw new Error('The input ended before an answer was given.')
    return line.value
  }
  return {
    ask(question) {
      // Piped input can end with answers still queued, and a closed readline refuses to prompt.
      if (closed) output.write(question)
      else {
        rl.setPrompt(question)
        rl.prompt()
      }
      return next()
    },
    async secret(question) {
      output.write(question)
      rl.setPrompt('')
      muted = true
      try {
        return await next()
      } finally {
        muted = false
        // The Enter that readline echoed went to the muted output.
        if (terminal) output.write('\n')
      }
    },
    say: (line) => void output.write(`${line}\n`),
    close: () => rl.close(),
  }
}
