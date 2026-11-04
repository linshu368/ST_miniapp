import type { CommandSpec } from '../command';
import { accountCommands } from './account';
import { characterCommands } from './characters';
import { configCommands } from './config';
import { contentCommands } from './content';
import { toolCommands } from './tools';

export const COMMANDS: CommandSpec[] = [
  ...accountCommands,
  ...configCommands,
  ...characterCommands,
  ...contentCommands,
  ...toolCommands,
];
