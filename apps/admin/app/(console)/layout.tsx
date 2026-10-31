'use client';

import { AppShell, Button, type Command, CommandPalette, navItemClass, Spinner } from '@app/ui';
import {
  ActivityIcon,
  BanIcon,
  FlagIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  SettingsIcon,
  UserSearchIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';

import { useSession } from '../../lib/session.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const { me, loading, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && me === null) router.replace('/login');
  }, [loading, me, router]);

  // Production: the API refuses everything but enrolment until two-factor auth is on.
  const mustEnrol = me !== null && me.totpRequired && !me.totpEnabled;
  useEffect(() => {
    if (mustEnrol && pathname !== '/settings') router.replace('/settings');
  }, [mustEnrol, pathname, router]);

  if (me === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Loading" />
      </div>
    );
  }

  const admin = me.role === 'ADMIN';
  const links = [
    { href: '/', label: 'Dashboard', icon: <LayoutDashboardIcon aria-hidden /> },
    { href: '/reports', label: 'Reports', icon: <FlagIcon aria-hidden /> },
    { href: '/bans', label: 'Bans', icon: <BanIcon aria-hidden /> },
    { href: '/events', label: 'Moderation events', icon: <ActivityIcon aria-hidden /> },
    ...(admin
      ? [
          { href: '/audit', label: 'Audit log', icon: <HistoryIcon aria-hidden /> },
          { href: '/admins', label: 'Admin users', icon: <UsersIcon aria-hidden /> },
        ]
      : []),
    { href: '/settings', label: 'Settings', icon: <SettingsIcon aria-hidden /> },
  ];
  const commands: Command[] = links.map((link) => ({
    id: link.href,
    label: link.label,
    icon: link.icon,
    run: () => {
      router.push(link.href);
    },
  }));
  const fromQuery = (query: string): Command[] =>
    UUID.test(query)
      ? [
          {
            id: `visitor-${query}`,
            label: `Open visitor ${query.slice(0, 8)}…`,
            icon: <UserSearchIcon aria-hidden />,
            run: () => {
              router.push(`/visitors/${query}`);
            },
          },
          {
            id: `report-${query}`,
            label: `Open report ${query.slice(0, 8)}…`,
            icon: <FlagIcon aria-hidden />,
            run: () => {
              router.push(`/reports/${query}`);
            },
          },
        ]
      : [];

  return (
    <AppShell
      brand="RandomChat Admin"
      nav={(close) => (
        <>
          <div className="mb-2">
            <CommandPalette
              commands={commands}
              fromQuery={fromQuery}
              placeholder="Page, visitor id or report id…"
            />
          </div>
          {links.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={navItemClass(active)}
                aria-current={active ? 'page' : undefined}
                onClick={close}
              >
                {link.icon}
                {link.label}
              </Link>
            );
          })}
        </>
      )}
      footer={
        <div className="grid gap-2 border-t pt-3 text-xs text-muted-foreground">
          <span className="truncate">
            {me.email} · {me.role === 'ADMIN' ? 'Admin' : 'Moderator'}
          </span>
          <Button size="sm" variant="ghost" className="justify-start" onClick={() => void logout()}>
            <LogOutIcon aria-hidden /> Sign out
          </Button>
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
