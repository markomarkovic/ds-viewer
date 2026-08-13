import { expect, test } from 'vitest'
import { classifyName, gather } from './dropzone'

test('classifyName accepts .ds1 case-insensitively', () => {
  expect(classifyName('01082026.ds1')).toBe('accept')
  expect(classifyName('01082026.DS1')).toBe('accept')
})

test('classifyName refuses sibling formats loudly', () => {
  expect(classifyName('a.ds2')).toBe('refuse')
  expect(classifyName('a.ds3')).toBe('refuse')
  expect(classifyName('a.ds4')).toBe('refuse')
})

test('classifyName skips everything else', () => {
  expect(classifyName('DreamSleep 1.0.25EN.exe')).toBe('skip')
  expect(classifyName('notes.txt')).toBe('skip')
  expect(classifyName('.DS_Store')).toBe('skip')
})

test('gather partitions a file list', () => {
  const f = (name: string) => new File([], name)
  const g = gather([f('a.ds1'), f('b.ds3'), f('c.txt'), f('d.ds1')])
  expect(g.accepted.map((x) => x.name)).toEqual(['a.ds1', 'd.ds1'])
  expect(g.refused).toEqual(['b.ds3'])
  expect(g.skippedCount).toBe(1)
})
