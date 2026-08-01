import js from "@eslint/js";
import ts from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  { ignores: ["**/dist/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser,
      parserOptions: { project: false },
      globals: {
        console: "readonly",
        process: "readonly",
        NodeJS: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        Response: "readonly",
        TextEncoder: "readonly",
        localStorage: "readonly",
        RequestInit: "readonly",
        File: "readonly",
        FileReader: "readonly",
        Blob: "readonly",
        AbortSignal: "readonly",
        crypto: "readonly",
        navigator: "readonly",
        location: "readonly",
        document: "readonly",
        window: "readonly",
        indexedDB: "readonly",
        IDBDatabase: "readonly",
        HTMLInputElement: "readonly",
        HTMLElement: "readonly",
        HTMLButtonElement: "readonly",
        KeyboardEvent: "readonly",
        Node: "readonly",
      },
    },
    plugins: { "@typescript-eslint": ts },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
