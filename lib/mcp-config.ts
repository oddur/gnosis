import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_FILENAME = 'gnosis-mcp-config.json';

export function writeMcpConfig(githubToken: string): string {
  const configPath = path.join(os.tmpdir(), CONFIG_FILENAME);
  const config = {
    mcpServers: {
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return configPath;
}

export function cleanupMcpConfig(configPath: string): void {
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch {
    // best-effort cleanup
  }
}
