import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
	{
		files: ['server/**/*.ts'],
		languageOptions: { parser },
		plugins: { '@typescript-eslint': tseslint },
		rules: {
			...tseslint.configs.recommended.rules,
		},
	},
];
