// Hero layout inspired by 21st.dev "Minimal Centered Hero" (ln-dev7): eyebrow label, large
// tracking-tight headline, subline, pill CTA. Design only (metadata), written in-house.
import { Badge, Card, CardContent } from '@app/ui';
import { ShieldCheckIcon } from 'lucide-react';

import { StartPanel } from '../components/landing/start-panel.tsx';
import { SiteFooter } from '../components/site-footer.tsx';
import { SiteHeader } from '../components/site-header.tsx';

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center gap-10 px-4 py-10 lg:flex-row lg:items-start lg:gap-16 lg:py-20">
        <section className="flex max-w-xl flex-col gap-5 text-center lg:pt-6 lg:text-left">
          <Badge variant="secondary" className="self-center lg:self-start">
            Anonymous · Free · 18+
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Talk to someone new.
          </h1>
          <p className="text-base text-muted-foreground sm:text-lg">
            RandomChat pairs you with a random stranger for a one-to-one chat — no account, no
            names. Add interests to meet people who like what you like.
          </p>
          <Card className="bg-muted/50 text-left">
            <CardContent className="flex gap-3 pt-5 text-sm">
              <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <p>
                <span className="font-medium">Be kind and stay safe.</span> Chats are anonymous, but
                reports are reviewed and bans are enforced. Never share personal details like your
                full name, address or passwords.
              </p>
            </CardContent>
          </Card>
        </section>
        <div className="w-full max-w-md">
          <StartPanel />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
