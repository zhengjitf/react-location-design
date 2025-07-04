import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

import { compileStartOutputFactory } from '../../src/compilers'

const compileStartOutput = compileStartOutputFactory('react')

async function getFilenames() {
  return await readdir(path.resolve(import.meta.dirname, './test-files'))
}

describe('envOnly functions compile correctly', async () => {
  const filenames = await getFilenames()

  describe.each(filenames)('should handle "%s"', async (filename) => {
    const file = await readFile(
      path.resolve(import.meta.dirname, `./test-files/${filename}`),
    )
    const code = file.toString()

    test.each(['client', 'server'] as const)(
      `should compile for ${filename} %s`,
      async (env) => {
        const compiledResult = compileStartOutput({
          env,
          code,
          filename,
          dce: false,
        })

        await expect(compiledResult.code).toMatchFileSnapshot(
          `./snapshots/${env}/${filename}`,
        )
      },
    )
  })
  test('should error if implementation not provided', () => {
    expect(() => {
      compileStartOutput({
        env: 'client',
        code: `
        import { clientOnly } from '@tanstack/react-start'
        const fn = clientOnly()`,
        filename: 'no-fn.ts',
        dce: false,
      })
    }).toThrowError()
    expect(() => {
      compileStartOutput({
        env: 'server',
        code: `
        import { serverOnly } from '@tanstack/react-start'
        const fn = serverOnly()`,
        filename: 'no-fn.ts',
        dce: false,
      })
    }).toThrowError()
  })
})
