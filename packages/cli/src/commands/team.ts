import type { Command } from 'commander';

/** `remembug team` — placeholder for the v0.2 sync server. */
export function registerTeam(program: Command): void {
  program
    .command('team')
    .description('(coming in v0.2) Configure self-hosted team sync.')
    .action(() => {
      console.log(`Remembug team sync is not yet implemented.

v0.1 is solo-mode only — all knowledge stays in ~/.remembug/remembug.db.
v0.2 will ship a self-hosted sync server; see docs/self-hosting-team.md
for the design and tracking issue.
`);
    });
}
