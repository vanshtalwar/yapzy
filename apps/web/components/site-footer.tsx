import Link from 'next/link';

const LINKS = [
  { href: '/guidelines', label: 'Community Guidelines' },
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
];

export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-5xl px-4 py-6 text-xs text-muted-foreground">
      <nav aria-label="Legal" className="flex flex-wrap justify-center gap-x-4 gap-y-2">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-foreground hover:underline">
            {link.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}
