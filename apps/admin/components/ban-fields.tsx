'use client';

import { type AdminRole, MODERATOR_MAX_HARD_BAN_HOURS } from '@app/shared';
import { FilterChips } from '@app/ui';

import { BAN_DURATIONS } from '../lib/labels.ts';

export interface BanChoice {
  type: 'HARD' | 'SHADOW';
  durationHours: number | null;
}

/** Ban type + duration presets; hard bans over 30 days are ADMIN-only (RBAC, Part 9). */
export function BanFields({
  role,
  value,
  onChange,
}: {
  role: AdminRole;
  value: BanChoice;
  onChange: (value: BanChoice) => void;
}) {
  const allowed = (hours: number | null) =>
    value.type === 'SHADOW' ||
    role === 'ADMIN' ||
    (hours !== null && hours <= MODERATOR_MAX_HARD_BAN_HOURS);
  const durations = BAN_DURATIONS.filter((preset) => allowed(preset.hours));
  return (
    <div className="grid gap-3">
      <FilterChips
        label="Type"
        options={[
          { value: 'SHADOW', label: 'Shadow ban' },
          { value: 'HARD', label: 'Hard ban' },
        ]}
        value={value.type}
        onChange={(type) => {
          const next = type ?? 'SHADOW';
          const keep =
            next === 'SHADOW' ||
            role === 'ADMIN' ||
            (value.durationHours !== null && value.durationHours <= MODERATOR_MAX_HARD_BAN_HOURS);
          onChange({ type: next, durationHours: keep ? value.durationHours : 24 });
        }}
      />
      <FilterChips
        label="Duration"
        options={durations.map((preset) => ({ value: String(preset.hours), label: preset.label }))}
        value={String(value.durationHours)}
        onChange={(hours) => {
          onChange({
            ...value,
            durationHours: hours === null || hours === 'null' ? null : Number(hours),
          });
        }}
      />
    </div>
  );
}
