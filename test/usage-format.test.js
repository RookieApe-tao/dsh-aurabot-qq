import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    const fmtTokens = ')
const end = source.indexOf('    /**', start)
const format = runInNewContext('(() => {' + source.slice(start, end) + '; return fmtTokens })()')
test('Token 简写：零、小数位、K/M/B 以及舍入跨单位', () => {
  for (const [n, expected] of [
    [0,'0'], [999,'999'], [1000,'1K'], [1234,'1.23K'], [1200,'1.2K'],
    [999999,'1M'], [1000000,'1M'], [474782167,'474.78M'],
    [999999999,'1B'], [1000000000,'1B'], [1234567890,'1.23B'],
  ]) assert.equal(format(n), expected, String(n))
})
