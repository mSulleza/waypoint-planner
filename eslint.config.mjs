import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const banned = (names, message, paths = []) => ({ paths, patterns: [{ group: names, message }] })

const NO_BLUR = 'No blur anywhere (spec §8): cards are flat and only sheets cast a shadow'
const noBlurImports = [
  { name: 'expo-blur', message: NO_BLUR },
  { name: '@react-native-community/blur', message: NO_BLUR },
]
const noFormatMoney = { name: '@waypoint/core', importNames: ['formatMoney'], message: 'Amounts render through <Money> or the chart kit, so the mask applies' }
const noBlurSyntax = [
  { selector: "Property[key.name='backdropFilter']", message: NO_BLUR },
  { selector: "Property[key.name='blur']", message: NO_BLUR },
  { selector: "JSXAttribute[name.name='blurRadius']", message: NO_BLUR },
  { selector: 'Literal[value=/blur\\(/]', message: NO_BLUR },
  { selector: 'TemplateElement[value.raw=/blur\\(/]', message: NO_BLUR },
]
const STATUS = '/^(positive|caution|negative)(Fill)?$/'
const STATUS_ALONE = 'Status colours reach screens only through StatusText and Banner, which add an icon and a word'
const noStatusColours = [
  { selector: `MemberExpression[object.name=/^(colors|COLORS)$/][property.name=${STATUS}]`, message: STATUS_ALONE },
  { selector: `MemberExpression[object.property.name=/^(colors|light|dark)$/][property.name=${STATUS}]`, message: STATUS_ALONE },
  { selector: `VariableDeclarator[init.name='colors'] > ObjectPattern > Property[key.name=${STATUS}]`, message: STATUS_ALONE },
]
const noFormatMoneyMember = { selector: "MemberExpression[property.name='formatMoney']", message: noFormatMoney.message }

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.expo/**', '**/expo-env.d.ts', 'apps/app/ios/**', 'apps/app/android/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', banned(['react', 'react/*', 'react-native', 'react-native/*', 'expo', 'expo-*', '@expo/*', '@supabase/*'], 'core stays portable: no React, Expo or Supabase')],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'core makes no network calls' }],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'core never reads the clock; today is an input' },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'core never reads the clock; today is an input' },
      ],
    },
  },
  {
    files: ['apps/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [...noBlurImports, noFormatMoney] }],
      'no-restricted-syntax': ['error', ...noBlurSyntax, ...noStatusColours, noFormatMoneyMember],
    },
  },
  {
    files: ['apps/app/src/ui/**'],
    rules: { 'no-restricted-syntax': ['error', ...noBlurSyntax, noFormatMoneyMember] },
  },
  {
    files: ['apps/app/src/ui/Money.tsx', 'apps/app/src/ui/chart/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: noBlurImports }],
      'no-restricted-syntax': ['error', ...noBlurSyntax],
    },
  },
  {
    files: ['apps/app/src/**/*.model.ts', 'apps/app/src/ui/tokens.ts'],
    rules: {
      'no-restricted-imports': ['error', banned(['react', 'react/*', 'react-native', 'react-native/*', 'expo', 'expo-*', '@expo/*'], 'view models and tokens stay pure', [...noBlurImports, noFormatMoney])],
    },
  },
)
