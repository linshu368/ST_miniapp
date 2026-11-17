#!/usr/bin/env node
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = 'ce38c0c0-88cd-407a-9c04-06124cd42e97';

function validCohort(cohort, experimentId) {
  if (!cohort || typeof cohort !== 'object' || Array.isArray(cohort)) return false;
  return (
    typeof experimentId === 'string' &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(experimentId) &&
    cohort.experimentId === experimentId &&
    Number.isSafeInteger(cohort.supabase) &&
    cohort.supabase > 0 &&
    Number.isSafeInteger(cohort.stream) &&
    cohort.stream > 0 &&
    cohort.supabase !== cohort.stream &&
    Object.keys(cohort).sort().join(',') === 'experimentId,stream,supabase'
  );
}

function configuredCohortMatches(raw, expected) {
  if (!raw || raw.length > 512) return false;
  try {
    const configured = JSON.parse(raw);
    return (
      validCohort(configured, expected.experimentId) &&
      configured.supabase === expected.supabase &&
      configured.stream === expected.stream
    );
  } catch {
    return false;
  }
}

/** This mirrors the deployed assignment without copying any credential to its output. */
export function inspectCohort(variables, cohort) {
  const experimentId = variables.DRAMA_STREAM_EXPERIMENT_ID;
  const key = variables.DRAMA_STREAM_EXPERIMENT_KEY;
  if (!experimentId || !key || key.length < 32) throw new Error('experiment_config_unreadable');
  if (!validCohort(cohort, experimentId)) {
    throw new Error('cohort_requires_current_experiment_and_two_different_telegram_ids');
  }
  const manifest = JSON.parse(variables.DRAMA_STREAM_MANIFEST);
  if (manifest.environment !== 'production' || manifest.videos.length !== 30) {
    throw new Error('production_manifest_invalid');
  }
  const hashBucket = (prefix, id) =>
    createHmac('sha256', key)
      .update(`${prefix}:production:${experimentId}:${id}`)
      .digest()
      .readUInt32BE(0) % 10000;
  const accounts = ['supabase', 'stream'].map((desiredGroup) => ({
    alias: desiredGroup === 'supabase' ? 'A' : 'B',
    desiredGroup,
    naturalGroup: hashBucket('bucket', cohort[desiredGroup]) < 5000 ? 'stream' : 'supabase',
    enrolled:
      hashBucket('enrollment', cohort[desiredGroup]) <
      Number(variables.DRAMA_STREAM_ENROLLMENT_BPS),
  }));
  return {
    environment: 'production',
    experimentId,
    enabled: variables.DRAMA_STREAM_ENABLED === 'true' && variables.DRAMA_CDN_ENABLED !== 'true',
    accounts,
    targetingRequired: accounts.some((a) => a.naturalGroup !== a.desiredGroup),
    configuredCohortMatches: configuredCohortMatches(
      variables.DRAMA_STREAM_SAMPLING_COHORT,
      cohort
    ),
    note: 'Read-only hash check. A configured override still requires a supporting deployment and actual playback verification.',
  };
}

async function main() {
  const [input, destination = `${homedir()}/.config/miniapp-ios-sampler/cohort-proposal.json`] =
    process.argv.slice(2);
  if (!input || input === '--help') {
    console.log(
      'Usage: node scripts/drama-stream-cohort.mjs /absolute/private/cohort.json [proposal-output.json]'
    );
    console.log(
      'Input keys: experimentId, supabase (Telegram ID), stream (Telegram ID). Read-only Railway inspection; never publishes.'
    );
    return;
  }
  const cohort = JSON.parse(await readFile(resolve(input), 'utf8'));
  let raw;
  try {
    raw = execFileSync(
      'railway',
      [
        'variable',
        'list',
        '--project',
        project,
        '--environment',
        'production',
        '--service',
        'stminiapp',
        '--json',
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch {
    throw new Error('railway_read_failed_credentials_not_printed');
  }
  const result = inspectCohort(JSON.parse(raw), cohort);
  const output = resolve(destination);
  if (output === resolve(input)) throw new Error('proposal_must_not_overwrite_input');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  // Open with exclusive creation: never truncate another run's review packet.
  await writeFile(
    output,
    `${JSON.stringify(
      { variable: 'DRAMA_STREAM_SAMPLING_COHORT', proposedValue: cohort, inspection: result },
      null,
      2
    )}\n`,
    { mode: 0o600, flag: 'wx' }
  );
  await chmod(output, 0o600);
  console.log(JSON.stringify({ ...result, proposalFile: output }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof SyntaxError ? 'invalid_json' : error.message);
    process.exitCode = 1;
  });
}
