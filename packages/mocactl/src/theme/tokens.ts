import chalk from 'chalk';

// Spec §5.4: every colour goes through these tokens; no component uses a literal colour.
export interface ThemeTokens {
  primary?: string;
  accent?: string;
  text?: string;
  muted?: string;
  border?: string;
  error?: string;
  warning?: string;
  success?: string;
  info?: string;
  diffAdd?: string;
  diffRemove?: string;
  code?: string;
  /** The startup banner's logo: pure TrueColor red in both palettes, by the banner's spec. */
  logo?: string;
}

export type ThemeName = 'system' | 'dark';
export const THEME_NAMES: readonly ThemeName[] = ['system', 'dark'];

export interface Theme {
  name: ThemeName;
  tokens: ThemeTokens;
  noColor: boolean;
  reducedMotion: boolean;
}

// The terminal's own 16-colour palette and default foreground: native in light and dark terminals.
export const SYSTEM_TOKENS: ThemeTokens = {
  primary: 'blue',
  accent: 'magenta',
  text: undefined,
  muted: 'gray',
  border: 'gray',
  error: 'red',
  warning: 'yellow',
  success: 'green',
  info: 'cyan',
  diffAdd: 'green',
  diffRemove: 'red',
  code: 'yellow',
  logo: '#ff0000',
};

export const DARK_TOKENS: ThemeTokens = {
  primary: '#7aa2f7',
  accent: '#bb9af7',
  text: '#c0caf5',
  muted: '#565f89',
  border: '#3b4261',
  error: '#f7768e',
  warning: '#e0af68',
  success: '#9ece6a',
  info: '#7dcfff',
  diffAdd: '#9ece6a',
  diffRemove: '#f7768e',
  code: '#e0af68',
  logo: '#ff0000',
};

export function resolveTheme(
  name: ThemeName,
  env: NodeJS.ProcessEnv,
  reducedMotion: boolean,
): Theme {
  const noColor = typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '';
  return {
    name,
    tokens: noColor ? {} : name === 'dark' ? DARK_TOKENS : SYSTEM_TOKENS,
    noColor,
    reducedMotion,
  };
}

export function toChalk(color: string | undefined): (s: string) => string {
  if (!color) return (s) => s;
  if (color.startsWith('#')) return chalk.hex(color);
  const fn = (chalk as unknown as Record<string, unknown>)[color];
  return typeof fn === 'function' ? (fn as (s: string) => string).bind(chalk) : (s) => s;
}
