'use client';

import { SearchIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type ReactNode, useEffect, useState } from 'react';

import { cn } from '../../lib/cn.ts';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  run: () => void;
}

/**
 * ⌘K / Ctrl+K palette: type to filter commands; `fromQuery` can turn the raw input into
 * commands (e.g. "open visitor <uuid>").
 */
export function CommandPalette({
  commands,
  fromQuery,
  placeholder = 'Search or jump to…',
}: {
  commands: Command[];
  fromQuery?: (query: string) => Command[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const results = [
    ...(fromQuery?.(query.trim()) ?? []),
    ...commands.filter((command) => command.label.toLowerCase().includes(needle)),
  ];
  const run = (command: Command | undefined) => {
    if (command === undefined) return;
    setOpen(false);
    setQuery('');
    command.run();
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setActive(0);
      }}
    >
      <DialogPrimitive.Trigger className="inline-flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <SearchIcon className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="rounded border px-1.5 text-[10px]">⌘K</kbd>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[15%] left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b px-3">
            <SearchIcon className="size-4 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={query}
              placeholder={placeholder}
              aria-label="Search"
              className="h-12 flex-1 bg-transparent text-sm outline-none"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown')
                  setActive((i) => Math.min(i + 1, results.length - 1));
                else if (event.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
                else if (event.key === 'Enter') run(results[active]);
                else return;
                event.preventDefault();
              }}
            />
          </div>
          <ul role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-1">
            {results.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">No results</li>
            )}
            {results.map((command, index) => (
              <li
                key={command.id}
                role="option"
                aria-selected={index === active}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm [&_svg]:size-4',
                  index === active && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => {
                  setActive(index);
                }}
                onClick={() => {
                  run(command);
                }}
              >
                {command.icon}
                <span className="flex-1">{command.label}</span>
                {command.hint !== undefined && (
                  <span className="text-xs text-muted-foreground">{command.hint}</span>
                )}
              </li>
            ))}
          </ul>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
