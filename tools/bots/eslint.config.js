import { createEslintConfig } from '@app/config/eslint';

export default createEslintConfig({ tsconfigRootDir: import.meta.dirname });
