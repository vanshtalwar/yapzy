import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@app/ui';
import { ShieldAlertIcon } from 'lucide-react';
import Link from 'next/link';

function describeExpiry(expiresAt: string | null): string {
  if (expiresAt === null) return 'This restriction does not expire.';
  const until = new Date(expiresAt).toLocaleString(undefined, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  return `You can use RandomChat again after ${until}.`;
}

/** Shown to hard-banned visitors. Deliberately calm: no details about who reported what. */
export function BlockedScreen({ expiresAt }: { expiresAt: string | null }) {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader className="items-center text-center">
        <ShieldAlertIcon className="size-10 text-destructive" aria-hidden />
        <CardTitle className="text-xl">You can’t chat right now</CardTitle>
        <CardDescription>
          Access from this device was restricted for breaking our Community Guidelines.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm">{describeExpiry(expiresAt)}</p>
        <Button asChild variant="outline">
          <Link href="/guidelines">Read the Community Guidelines</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
