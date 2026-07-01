#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerConfig } from './commands/config.js';
import { registerDaemon } from './commands/daemon.js';
import { registerSearch } from './commands/search.js';
import { registerReview } from './commands/review.js';
import { registerDoctor } from './commands/doctor.js';
import { registerTeam } from './commands/team.js';
import { registerUninstall } from './commands/uninstall.js';

const program = new Command();
program
  .name('remembug')
  .description(
    'Remembug — a Stack-Overflow-style knowledge base for Claude Code debugging sessions',
  )
  .version('0.1.10');

registerInit(program);
registerConfig(program);
registerDaemon(program);
registerSearch(program);
registerReview(program);
registerDoctor(program);
registerTeam(program);
registerUninstall(program);

program.parseAsync().catch((e) => {
  console.error('[remembug] error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
