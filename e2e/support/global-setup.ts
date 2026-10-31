import { startStack } from './stack.ts';

export default async function globalSetup(): Promise<void> {
  await startStack();
}
