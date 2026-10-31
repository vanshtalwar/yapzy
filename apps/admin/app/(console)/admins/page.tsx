'use client';

import { ADMIN_ROLES, type AdminRole, adminUserListSchema, okSchema } from '@app/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FilterChips,
  Input,
  Label,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@app/ui';
import { useId, useState } from 'react';

import { api, ApiError } from '../../../lib/api.ts';
import { formatTime } from '../../../lib/labels.ts';
import { useSession } from '../../../lib/session.tsx';
import { useApi } from '../../../lib/use-api.ts';

/** Admin accounts (ADMIN only): create, disable, reset two-factor. */
export default function AdminsPage() {
  const { me } = useSession();
  const { data, reload } = useApi('/admins', adminUserListSchema);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AdminRole>('MODERATOR');
  const ids = { email: useId(), password: useId() };

  const run = async (path: string, body: unknown, done: string) => {
    try {
      await api.post(path, okSchema, body);
      toast(done);
      await reload();
    } catch (cause) {
      toast(cause instanceof ApiError ? cause.message : 'Failed');
    }
  };

  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">Admin users</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add an admin</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-3 md:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void run('/admins', { email, password, role }, 'Admin created').then(() => {
                setEmail('');
                setPassword('');
              });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor={ids.email}>Email</Label>
              <Input
                id={ids.email}
                type="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={ids.password}>Initial password (≥ 12)</Label>
              <Input
                id={ids.password}
                type="password"
                minLength={12}
                required
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <FilterChips
                label="Role"
                options={ADMIN_ROLES.map((value) => ({
                  value,
                  label: value === 'ADMIN' ? 'Admin' : 'Moderator',
                }))}
                value={role}
                onChange={(value) => {
                  setRole(value ?? 'MODERATOR');
                }}
              />
              <Button type="submit">Create</Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {data === null ? (
        <Spinner label="Loading" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>2FA</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((admin) => (
              <TableRow key={admin.id}>
                <TableCell className="text-sm">
                  {admin.email}{' '}
                  {admin.disabledAt !== null && <Badge variant="muted">disabled</Badge>}
                </TableCell>
                <TableCell className="text-xs">{admin.role}</TableCell>
                <TableCell className="text-xs">{admin.totpEnabled ? 'on' : 'off'}</TableCell>
                <TableCell className="text-xs">
                  {admin.lastLoginAt === null ? 'never' : formatTime(admin.lastLoginAt)}
                </TableCell>
                <TableCell className="flex justify-end gap-1">
                  {admin.totpEnabled && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void run(`/admins/${admin.id}/reset-totp`, {}, 'Two-factor reset')
                      }
                    >
                      Reset 2FA
                    </Button>
                  )}
                  {admin.disabledAt === null && admin.id !== me?.id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void run(`/admins/${admin.id}/disable`, {}, 'Admin disabled')}
                    >
                      Disable
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
