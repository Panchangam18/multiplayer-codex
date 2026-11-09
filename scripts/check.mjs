import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const directory of ['src', 'renderer', 'scripts', 'test']) {
  for (const name of readdirSync(directory).filter(name => /\.m?js$/.test(name))) {
    execFileSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
  }
}
console.log('JavaScript syntax checks passed.');
