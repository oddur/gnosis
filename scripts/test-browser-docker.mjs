// Runs the Electron browser checks in a Linux container under Xvfb, the same way the
// Linux CI job does, without opening windows on the host.
//
//   npm run test:browser:docker                      # full suite, as on CI
//   npm run test:browser:docker -- --review-evidence # one workbench check
//   npm run test:browser:docker -- npm run test:explainer
//   GNOSIS_DOCKER_PLATFORM=linux/amd64 npm run test:browser:docker  # CI's architecture
//   GNOSIS_DOCKER_IMAGE=gnosis-browser-tests-mine npm run test:browser:docker  # a worktree's own image
//   CI=true npm run test:browser:docker -- --diff-gaps    # timing report-only, as on CI
//
// The Linux Mergiraf for the image is cached in ${XDG_CACHE_HOME:-~/.cache}/gnosis/mergiraf/<version>-linux-<arch>;
// set GNOSIS_MERGIRAF_CACHE to use another directory instead of …/gnosis/mergiraf.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.GNOSIS_DOCKER_IMAGE || 'gnosis-browser-tests';
const args = process.argv.slice(2);
// `node scripts/test-browser-docker.mjs -- …` keeps the separator that npm would strip.
if (args[0] === '--') args.shift();
const commands = !args.length
  ? ['npm run test:explainer', 'npm run test:workbench', 'npm run test:diagrams']
  : args[0].startsWith('--')
    ? [`node scripts/test-workbench.mjs ${args.join(' ')}`]
    : [args.join(' ')];
const script = ['set -e', ...commands.map((command) => `xvfb-run -a ${command}`)].join('\n');

const run = (command, commandArgs, env = process.env) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// Check Docker before anything is downloaded.
const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Arch}}'], { encoding: 'utf8' });
if (daemon.error || daemon.status !== 0)
  fail("Docker isn't running. Start Docker Desktop (or the Docker daemon) and run this again.");
// The image gets Mergiraf through a named build context, which needs BuildKit.
if (process.env.DOCKER_BUILDKIT === '0' || spawnSync('docker', ['buildx', 'version']).status !== 0)
  fail(
    'This build needs BuildKit (docker buildx) for --build-context. Install the buildx plugin or unset DOCKER_BUILDKIT=0.'
  );

// Decide the architecture once and pass it to every docker command, so the prepared Mergiraf always matches the image.
const requested = process.env.GNOSIS_DOCKER_PLATFORM || process.env.DOCKER_DEFAULT_PLATFORM;
if (requested && !requested.startsWith('linux/')) fail(`Unsupported Docker platform: ${requested}`);
const dockerArch = requested ? requested.split('/')[1] : daemon.stdout.trim();
const mergirafArch = { amd64: 'x64', arm64: 'arm64' }[dockerArch];
if (!mergirafArch) fail(`Unsupported Docker architecture for Mergiraf: ${dockerArch}`);
const platform = ['--platform', `linux/${dockerArch}`];

// Download the Linux Mergiraf on the host into a cache shared by all worktrees. It is fetched once per version and
// architecture, and the build does not need codeberg.org after that.
const mergirafVersion = JSON.parse(readFileSync(path.join(root, 'resources/mergiraf/manifest.json'), 'utf8')).version;
const cache = path.join(
  process.env.GNOSIS_MERGIRAF_CACHE ||
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'gnosis/mergiraf'),
  `${mergirafVersion}-linux-${dockerArch}`
);
run(process.execPath, [path.join(root, 'scripts/prepare-mergiraf.mjs')], {
  ...process.env,
  GNOSIS_TARGET_PLATFORM: 'linux',
  GNOSIS_TARGET_ARCH: mergirafArch,
  GNOSIS_MERGIRAF_DIR: cache,
});

run('docker', [
  'build',
  ...platform,
  '--build-context',
  `mergiraf=${cache}`,
  '-t',
  image,
  '-f',
  path.join(root, 'tests/docker/Dockerfile'),
  root,
]);
// Chromium needs a larger /dev/shm than Docker's 64 MB default, and its sandbox needs
// namespace syscalls that Docker's default seccomp profile blocks.
run('docker', [
  'run',
  '--rm',
  '--init',
  ...platform,
  '--shm-size=2g',
  // Review screenshot modes print PNGs to the log (tests/syntax-scope-browser.ts); pass them through when set.
  // So do the perf settings (tests/perf-budget.ts): the container does not set CI, so timing is enforced there unless
  // CI or GNOSIS_PERF=0 is passed in. `npm run test:perf` passes GNOSIS_PERF=1.
  ...['GNOSIS_FILE_HEADER_SHOTS', 'GNOSIS_HUNK_HEADER_SHOTS', 'GNOSIS_SYNTAX_SCOPE_SHOT', 'GNOSIS_PARITY_SHOTS', 'GNOSIS_NAV_SHOTS', 'GNOSIS_NOISE_SHOTS', 'GNOSIS_STRUCTURE_BENCH', 'GNOSIS_STRUCTURE_WORKERS', 'GNOSIS_FEEDBACK_INLINE_SHOTS', 'GNOSIS_PR_PEOPLE_SHOTS', 'CI', 'GNOSIS_PERF', 'GNOSIS_PERF_STRICT', 'GNOSIS_PERF_BUDGET_SCALE', 'GNOSIS_INTERACTION_CPU_SLOWDOWN', 'GNOSIS_TYPING_CPU_SLOWDOWN', 'GNOSIS_LONG_TASK_BUDGET', 'GNOSIS_INTERACTION_ONLY', 'GNOSIS_INTERACTION_PROFILE', 'GNOSIS_MOVES_SHOTS'].flatMap((name) =>
    process.env[name] ? ['-e', `${name}=${process.env[name]}`] : []
  ),
  '--security-opt',
  'seccomp=unconfined',
  image,
  'bash',
  '-c',
  script,
]);
