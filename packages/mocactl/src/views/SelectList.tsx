import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { fuzzyScore } from '../commands/registry.js';
import { useTheme } from '../theme/context.js';

export interface ListItem<T> {
  key: string;
  label: string;
  detail?: string;
  value: T;
}

interface Props<T> {
  items: ListItem<T>[];
  onSelect: (v: T) => void;
  onCancel: () => void;
  filter: 'always' | 'slash' | 'off';
  keys?: Record<string, (v: T | undefined) => void>;
  emptyText?: string;
  maxRows?: number;
  initialKey?: string;
  title?: string;
}

export function SelectList<T>({
  items,
  onSelect,
  onCancel,
  filter,
  keys = {},
  emptyText = 'nothing here',
  maxRows = 10,
  initialKey,
  title,
}: Props<T>) {
  const { tokens: t } = useTheme();
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(filter === 'always');
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      items.findIndex((i) => i.key === initialKey),
    ),
  );

  const visible = useMemo(() => {
    if (!query) return items;
    return items
      .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.detail ?? ''}`) }))
      .filter((x): x is { item: ListItem<T>; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [items, query]);

  const at = Math.min(cursor, Math.max(0, visible.length - 1));
  const current = visible[at]?.value;

  useInput((input, key) => {
    if (key.escape) {
      if (filtering && filter === 'slash') {
        setFiltering(false);
        setQuery('');
      } else onCancel();
      return;
    }
    // Functional updates: a rapid, un-awaited burst of arrow presses is delivered as several
    // input events before React re-renders, so reading `at` (captured at this render) would
    // apply the same "next" value every time. Reading off the pending cursor value instead
    // makes each keypress advance from the previous one.
    if (key.upArrow) return setCursor((c) => Math.max(0, Math.min(c, visible.length - 1) - 1));
    if (key.downArrow) return setCursor((c) => Math.min(visible.length - 1, c + 1));
    if (key.return) {
      if (current !== undefined) onSelect(current);
      return;
    }
    if (filtering) {
      if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
      setCursor(0);
      return;
    }
    if (filter === 'slash' && input === '/') {
      setFiltering(true);
      return;
    }
    // A letter shortcut is the bare key: Ctrl+C is the App's quit, not a `c` shortcut.
    const handler = key.ctrl ? undefined : keys[input];
    if (handler) handler(current);
  });

  const start = Math.min(
    Math.max(0, at - Math.floor(maxRows / 2)),
    Math.max(0, visible.length - maxRows),
  );
  const rows = visible.slice(start, start + maxRows);

  return (
    <Box flexDirection="column">
      {title ? (
        <Text bold color={t.primary}>
          {title}
        </Text>
      ) : null}
      {filtering ? <Text color={t.accent}>/{query}▌</Text> : null}
      {visible.length === 0 ? <Text color={t.muted}>{emptyText}</Text> : null}
      {rows.map((item, i) => {
        const selected = start + i === at;
        return (
          <Text key={item.key} color={selected ? t.primary : t.text} bold={selected}>
            {selected ? '› ' : '  '}
            {item.label}
            {item.detail ? <Text color={t.muted}> {item.detail}</Text> : null}
          </Text>
        );
      })}
      {visible.length > rows.length ? (
        <Text color={t.muted}> {visible.length - rows.length} more…</Text>
      ) : null}
    </Box>
  );
}
