const fs = require('fs');

const isWin = process.platform === 'win32';

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

function findGitBash() {
  for (const p of GIT_BASH_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('git-bash not found (checked Program Files paths)');
}

function resolveShell(tag) {
  switch (tag) {
    case 'powershell':
      // No -NonInteractive: it makes Read-Host throw instead of waiting, and
      // blocks can now receive input while running.
      return isWin
        ? { shellPath: 'powershell.exe', buildArgs: (code) => ['-NoProfile', '-Command', code] }
        : { shellPath: 'pwsh', buildArgs: (code) => ['-NoProfile', '-Command', code] };

    case 'cmd':
      if (!isWin) throw new Error('cmd blocks only run on Windows');
      // cmd.exe /c re-parses the whole command line itself; Node's default arg
      // quoting double-quotes it and breaks paths that already contain quotes
      // (e.g. "C:\Program Files\...\x.exe"), so we disable Node's own quoting
      // via windowsVerbatimArguments. But cmd.exe also strips the first and
      // last character of the /c argument whenever both are a double-quote,
      // regardless of whether they're actually a matching outer pair — which
      // mangles a command that itself starts and ends with a quoted path. The
      // documented workaround is to wrap the whole command in one more pair
      // of quotes so that strip cancels out and leaves the command untouched.
      return { shellPath: 'cmd.exe', buildArgs: (code) => ['/d', '/c', `"${code}"`], verbatim: true };

    case 'bash':
      return {
        shellPath: isWin ? findGitBash() : '/bin/bash',
        buildArgs: (code) => ['-c', code],
      };

    case 'gitbash':
      if (!isWin) throw new Error('use the "bash" tag on macOS/Linux');
      return { shellPath: findGitBash(), buildArgs: (code) => ['-c', code] };

    default:
      throw new Error(`Unknown shell tag: ${tag}`);
  }
}

module.exports = { resolveShell, isWin };
