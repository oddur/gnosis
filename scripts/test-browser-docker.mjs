// Runs the Electron browser checks in a Linux container under Xvfb, the same way the
// Linux CI job does, without opening windows on the host.
//
//   npm run test:browser:docker                      # full suite, as on CI
//   npm run test:browser:docker -- --review-evidence # one workbench check
//   npm run test:browser:docker -- npm run test:explainer
//   GNOSIS_DOCKER_PLATFORM=linux/amd64 npm run test:browser:docker  # CI's architecture
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const image = 'gnosis-browser-tests';
const platform = process.env.GNOSIS_DOCKER_PLATFORM ? ['--platform', process.env.GNOSIS_DOCKER_PLATFORM] : [];
const args = process.argv.slice(2);
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
  '--security-opt',
  'seccomp=unconfined',
  image,
  'bash',
  '-c',
  script,
]);
