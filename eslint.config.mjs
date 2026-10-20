import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default [
	...(await generateEslintConfig({
		enableTypescript: true,
	})),
	{
		// Tests import the compiled module from dist/, which is generated and
		// gitignored: linting must not depend on a previous build.
		files: ['tests/**/*.mjs'],
		rules: {
			'n/no-missing-import': 'off',
			'n/no-unpublished-import': 'off',
		},
	},
]
