import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
export default [js.configs.recommended,{files:['**/*.ts','**/*.tsx'],languageOptions:{parser,parserOptions:{project:false}},plugins:{'@typescript-eslint':ts},rules:{'no-unused-vars':'off','@typescript-eslint/no-unused-vars':['warn',{argsIgnorePattern':'^_'}]}}];
