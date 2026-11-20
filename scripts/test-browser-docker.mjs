// Runs the Electron browser checks in a Linux container under Xvfb, the same way the
// Linux CI job does, without opening windows on the host.
//
//   npm run test:browser:docker                      # full suite, as on CI
//   npm run test:browser:docker -- --review-evidence # one workbench check
//   npm run test:browser:docker -- npm run test:explainer
//   GNOSIS_DOCKER_PLATFORM=linux/amd64 npm run test:browser:docker  # CI's architecture
//   GNOSIS_DOCKER_IMAGE=gnosis-browser-tests-mine npm run test:browser:docker  # a worktree's own image
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const image = process.env.GNOSIS_DOCKER_IMAGE || 'gnosis-browser-tests';
const platform = process.env.GNOSIS_DOCKER_PLATFORM ? ['--platform', process.env.GNOSIS_DOCKER_PLATFORM] : [];
const args = process.argv.slice(2);
// `node scripts/test-browser-docker.mjs -- …` keeps the separator that npm would strip.
if (args[0] === '--') args.shift();
const commands = !args.length
  ? ['npm run test:explainer', 'npm run test:workbench', 'npm run test:diagrams']
  : args[0].startsWith('--')
    ? [`node scripts/test-workbench.mjs ${args.join(' ')}`]
    : [args.join(' ')];
const script = ['set -e', ...commands.map((command) => `xvfb-run -a ${command}`)].join('\n');

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run('docker', ['build', ...platform, '-t', image, '-f', 'tests/docker/Dockerfile', '.']);
// Chromium needs a larger /dev/shm than Docker's 64 MB default, and its sandbox needs
// namespace syscalls that Docker's default seccomp profile blocks.
run('docker', [
  'run',
  '--rm',
  '--init',
  ...platform,
  '--shm-size=2g',
  // Review screenshot modes print PNGs to the log (tests/syntax-scope-browser.ts); pass them through when set.
  ...['GNOSIS_FILE_HEADER_SHOTS', 'GNOSIS_HUNK_HEADER_SHOTS', 'GNOSIS_SYNTAX_SCOPE_SHOT', 'GNOSIS_PARITY_SHOTS', 'GNOSIS_NAV_SHOTS', 'GNOSIS_NOISE_SHOTS', 'GNOSIS_STRUCTURE_BENCH', 'GNOSIS_STRUCTURE_WORKERS', 'GNOSIS_FEEDBACK_INLINE_SHOTS', 'GNOSIS_PR_PEOPLE_SHOTS'].flatMap((name) =>
    process.env[name] ? ['-e', `${name}=${process.env[name]}`] : []
  ),
  '--security-opt',
  'seccomp=unconfined',
  image,
  'bash',
  '-c',
  script,
]);
