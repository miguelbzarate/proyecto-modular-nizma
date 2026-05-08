module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["plugin:@typescript-eslint/recommended", "prettier"],
  env: { node: true, es2022: true },
  ignorePatterns: ["dist", "node_modules", "*.js"],
  rules: {
    // Permite `_algo` para descartes deliberados (p. ej. al desestructurar `kind`).
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
  },
};
