import { PassThrough } from 'node:stream'
import { setTimeout as tick } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { linePrompt } from '../src/prompt'

const PASSWORD = 'Existing pw "1" \\ é'

// A terminal as readline sees one: keys arrive one by one and raw mode is switched by the reader.
function fakeTerminal() {
  const modes: boolean[] = []
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(mode: boolean) {
      modes.push(mode)
      return input
    },
  })
  let shown = ''
  const output = new PassThrough().on('data', (chunk: Buffer) => (shown += chunk.toString()))
  const type = async (keys: string) => {
    for (const key of keys) {
      input.write(key)
      await tick(1)
    }
  }
  return { input, output, modes, shown: () => shown, type }
}

describe('the login prompt', () => {
  it('reads piped answers that arrive together, without echoing anything', async () => {
    const input = new PassThrough()
    let shown = ''
    const output = new PassThrough().on('data', (chunk: Buffer) => (shown += chunk.toString()))
    const prompt = linePrompt(input, output)
    input.end(`agent@example.test\n${PASSWORD}\n`)
    expect(await prompt.ask('Email: ')).toBe('agent@example.test')
    expect(await prompt.secret('Password: ')).toBe(PASSWORD)
    await expect(prompt.ask('More: ')).rejects.toThrow('The input ended before an answer was given.')
    prompt.close()
    expect(shown).toBe('Email: Password: More: ')
  })

  it('answers a question asked after piped input ended from the lines still queued', async () => {
    const input = new PassThrough()
    let shown = ''
    const output = new PassThrough().on('data', (chunk: Buffer) => (shown += chunk.toString()))
    const prompt = linePrompt(input, output)
    input.end(`agent@example.test\n${PASSWORD}\nREPLACE\n`)
    expect(await prompt.ask('Email: ')).toBe('agent@example.test')
    expect(await prompt.secret('Password: ')).toBe(PASSWORD)
    // A server call in between: by then readline has read the end of the input and closed.
    await tick(20)
    expect(await prompt.ask('Type REPLACE: ')).toBe('REPLACE')
    await expect(prompt.ask('More: ')).rejects.toThrow('The input ended before an answer was given.')
    prompt.close()
    expect(shown).toBe('Email: Password: Type REPLACE: More: ')
  })

  it('echoes the address on a terminal but never the password, and leaves raw mode when it closes', async () => {
    const term = fakeTerminal()
    const prompt = linePrompt(term.input, term.output)
    const email = prompt.ask('Email: ')
    await term.type('agent@example.test\r')
    expect(await email).toBe('agent@example.test')
    expect(term.shown()).toContain('agent@example.test')
    const before = term.shown().length
    const password = prompt.secret('Password: ')
    // A typo erased with backspace, as a person types.
    await term.type(`${PASSWORD}!\x7f\r`)
    expect(await password).toBe(PASSWORD)
    const during = term.shown().slice(before)
    expect(during).toBe('Password: \n')
    prompt.close()
    expect(term.modes.at(0)).toBe(true)
    expect(term.modes.at(-1)).toBe(false)
  })

  it('stops on Ctrl-C at the password without showing what was typed', async () => {
    const term = fakeTerminal()
    const prompt = linePrompt(term.input, term.output)
    const password = prompt.secret('Password: ')
    const refused = expect(password).rejects.toThrow('The input ended before an answer was given.')
    await term.type('half-typ\x03')
    await refused
    expect(term.shown()).toBe('Password: \n')
    expect(term.modes.at(-1)).toBe(false)
  })
})
