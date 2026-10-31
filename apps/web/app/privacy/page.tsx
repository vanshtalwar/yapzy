import { type Metadata } from 'next';

import { LegalPage } from '../../components/legal/legal-page.tsx';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="31 October 2026">
      <p>RandomChat is anonymous by design. This is what we process and why.</p>
      <h2>What we store</h2>
      <ul>
        <li>
          A random device identifier and your IP address, only as one-way keyed hashes, so bans and
          rate limits work. We never store the raw values.
        </li>
        <li>Chat metadata: when a chat started and ended, its mode and shared interests.</li>
        <li>That you confirmed you are 18+ and which version of the terms you accepted.</li>
      </ul>
      <h2>What we do not store</h2>
      <ul>
        <li>
          Messages and video are not stored, except: the last messages of a chat are held in memory
          for one hour so a report can include them.
        </li>
        <li>No account, name, e-mail address or phone number is required.</li>
      </ul>
      <h2>Safety</h2>
      <ul>
        <li>Video frames may be sampled for automated safety checks.</li>
        <li>Content you report, or that our systems flag, is retained as evidence for review.</li>
      </ul>
      <h2>Third parties</h2>
      <p>
        Cloudflare Turnstile checks that you are human when you start a session. Video calls may be
        relayed through our servers when a direct connection is not possible.
      </p>
    </LegalPage>
  );
}
