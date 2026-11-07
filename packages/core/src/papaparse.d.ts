// The part of papaparse 5.7 that csv.ts calls. @types/papaparse pulls in Node's types, which core keeps out; a package that compiles csv.ts lists this file in its tsconfig.
declare module 'papaparse' {
  export interface ParseError {
    type: 'Quotes' | 'Delimiter' | 'FieldMismatch'
    code: 'MissingQuotes' | 'UndetectableDelimiter' | 'TooFewFields' | 'TooManyFields' | 'InvalidQuotes'
    message: string
    row?: number
  }

  export interface ParseResult {
    data: string[][]
    errors: ParseError[]
    meta: { delimiter: string; linebreak: string; aborted: boolean; truncated: boolean }
  }

  export interface ParseConfig {
    delimiter?: string
    skipEmptyLines?: boolean | 'greedy'
  }

  const Papa: { parse(input: string, config?: ParseConfig): ParseResult }
  export default Papa
}
