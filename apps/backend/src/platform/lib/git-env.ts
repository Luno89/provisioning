export function unpromptedGit(base: NodeJS.ProcessEnv, config: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const { SSH_ASKPASS: _ssh, GIT_ASKPASS: _git, GIT_CONFIG_COUNT: _count, ...inherited } = base;
  const entries = Object.entries({ 'credential.helper': '', 'core.askPass': '', ...config });
  return {
    ...inherited,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(entries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
}
