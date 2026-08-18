import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/generated.ts');

const ref = process.env['SUPABASE_PROJECT_REF'];
if (!ref) {
  console.error(
    'Missing SUPABASE_PROJECT_REF env var.\n' +
      'Set it in .env or pass it directly:\n' +
      '  SUPABASE_PROJECT_REF=<ref> pnpm db:gen'
  );
  process.exit(1);
}

const schemas = 'st_platform,st_users,st_infra';

try {
  const raw = execSync(
    `npx supabase gen types typescript --project-id ${ref} --schema ${schemas}`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const header = [
    '// AUTO-GENERATED — DO NOT EDIT',
    '// Run `pnpm db:gen` to regenerate',
    `// Generated at: ${new Date().toISOString()}`,
    '',
  ].join('\n');

  writeFileSync(OUT_PATH, header + raw, 'utf-8');
  console.log(`✔ Generated ${OUT_PATH}`);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    'Failed to generate types. Ensure the Supabase CLI is installed and you are authenticated.\n' +
      `Error: ${msg}`
  );
  process.exit(1);
}
