import { type Metadata } from 'next';
import Link from 'next/link';

import { LegalPage } from '../../components/legal/legal-page.tsx';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="31 October 2026">
      <p>
        These terms govern your use of RandomChat. By starting a chat you accept them, our{' '}
        <Link href="/guidelines">Community Guidelines</Link> and our{' '}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
      <h2>Who can use RandomChat</h2>
      <ul>
        <li>You must be at least 18 years old.</li>
        <li>You must not use RandomChat where it is prohibited by law.</li>
      </ul>
      <h2>Your conduct</h2>
      <p>
        You are responsible for what you say and show. Breaking the Community Guidelines can lead to
        your chats being ended, temporary or permanent bans, and — where the law requires it —
        reports to the authorities.
      </p>
      <h2>Moderation and evidence</h2>
      <ul>
        <li>Other users can report you; reports are reviewed by people and automated systems.</li>
        <li>Video frames may be sampled automatically to detect abuse.</li>
        <li>
          Content attached to a report or flagged by our safety systems is retained as evidence.
        </li>
      </ul>
      <h2>No warranty</h2>
      <p>
        RandomChat is provided as is. We cannot control what strangers say or show and are not
        responsible for it. You can end any chat at any time.
      </p>
    </LegalPage>
  );
}
