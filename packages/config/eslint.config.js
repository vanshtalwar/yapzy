import { createEslintConfig } from './eslint.config.base.js';

export default createEslintConfig({ tsconfigRootDir: import.meta.dirname });
