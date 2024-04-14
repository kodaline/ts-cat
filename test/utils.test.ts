import { expect, it } from 'vitest'
import { catPaths, sleep, zodJson } from '@utils'

const isGithubAction = process.env.GITHUB_ACTIONS === 'true'

it.runIf(isGithubAction)('test cat paths', () => {
	expect(catPaths).toMatchObject({
		basePath: 'src',
		baseUrl: 'http://localhost:1865/',
		pluginsPath: 'src/plugins',
		assetsPath: 'src/assets',
		assetsUrl: 'http://localhost:1865/assets',
	})
})

it('test sleep', async () => {
	const start = Date.now()
	await sleep(100)
	expect(Date.now() - start).greaterThanOrEqual(95)
	expect(Date.now() - start).lessThanOrEqual(105)
})

it('test zod json type', () => {
	const json = { a: 1, b: '2' }

	expect(zodJson.parse(json)).toMatchObject(json)

	expect(zodJson.parse([1, 2, 3])).toMatchObject([1, 2, 3])

	expect(zodJson.parse('hello')).toBe('hello')

	expect(zodJson.parse(6)).toBe(6)

	expect(zodJson.parse(null)).toBe(null)

	expect(zodJson.parse(true)).toBe(true)
})
