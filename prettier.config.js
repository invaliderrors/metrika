/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
  // Code fences in docs/ are hand-written illustrations, not source: formatting
  // them adds noise and, for JSONC, produces examples that no longer parse as
  // JSON (e.g. a dangling trailing comma). Leave embedded code blocks as authored.
  embeddedLanguageFormatting: 'off',
};
