import { type Metadata } from 'next';

import { LegalPage } from '../../components/legal/legal-page.tsx';

export const metadata: Metadata = { title: 'Community Guidelines' };

export default function GuidelinesPage() {
  return (
    <LegalPage title="Community Guidelines" updated="31 October 2026">
      <p>
        RandomChat works when everyone treats strangers with respect. These rules apply to every
        chat.
      </p>
      <h2>Not allowed</h2>
      <ul>
        <li>
          Anyone under 18. If you meet someone who seems to be a minor, leave and report them.
        </li>
        <li>Nudity, sexual content or sexual requests.</li>
        <li>Harassment, threats, bullying or hate based on who someone is.</li>
        <li>Violence, self-harm content or encouraging self-harm.</li>
        <li>Spam, scams, advertising or asking people to move to other services.</li>
        <li>Sharing someone else’s personal information.</li>
      </ul>
      <h2>Stay safe</h2>
      <ul>
        <li>Don’t share your full name, address, school, workplace or passwords.</li>
        <li>You can skip or stop any chat at any time.</li>
      </ul>
      <h2>Enforcement</h2>
      <p>
        Reports are reviewed by people and automated systems. Video may be sampled for safety, and
        reported content is kept as evidence. Breaking these rules can lead to temporary or
        permanent bans.
      </p>
    </LegalPage>
  );
}
