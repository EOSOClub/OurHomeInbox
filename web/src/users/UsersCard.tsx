// Settings' Users section: everyone in the household who can sign in. Every
// user can see and change everything in OurHomeInbox (managing the household's
// money is a shared effort); an admin can also add a user, change one's name,
// email or admin, give someone who forgot their password a new one, and
// remove a user. One form is open at a time, in place of the row it is about.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { HouseholdUser } from "../../../src/shared/api";
import { MIN_PASSWORD_LENGTH } from "../../../src/shared/api";
import { api } from "../api";
import { Button, Card, ErrorState, LoadingState, Notice, TextField } from "../components/ui";
import { refreshAfterUserChange, useUsers } from "../queries";

/** Which form is open, if any. */
type Open = { kind: "add" } | { kind: "edit" | "password" | "remove"; id: number } | null;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function addedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/** The admin tick, used by both the add and edit forms. */
function AdminTick({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="inline-flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
      <span>
        <span className="font-medium">Admin</span>
        <span className="block text-muted">Can add, change and remove users.</span>
      </span>
    </label>
  );
}

function nameAndEmailErrors(name: string, email: string): { name?: string; email?: string } {
  const found: { name?: string; email?: string } = {};
  if (!name.trim()) found.name = "Enter their name.";
  if (!EMAIL.test(email.trim())) found.email = "Enter a valid email address, like name@example.com.";
  return found;
}

function AddUserForm({ onDone, onAdded }: { onDone: () => void; onAdded: (user: HouseholdUser) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const add = useMutation({
    mutationFn: api.addUser,
    onSuccess: (user) => {
      refreshAfterUserChange(queryClient);
      onAdded(user);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: typeof errors = nameAndEmailErrors(name, email);
    if (password.length < MIN_PASSWORD_LENGTH) found.password = `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
    setErrors(found);
    if (Object.keys(found).length === 0) add.mutate({ name: name.trim(), email: email.trim(), password, isAdmin });
  }

  return (
    <form aria-label="Add a user" className="mt-4 flex flex-col gap-4 rounded-lg border border-line p-3 sm:p-4" onSubmit={submit} noValidate>
      <h3 className="font-semibold">Add a user</h3>
      <TextField label="Name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
      <TextField label="Email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} hint="They sign in with it." />
      <TextField
        label="First password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Tell them; they can change it under Settings.`}
      />
      <AdminTick checked={isAdmin} onChange={setIsAdmin} />
      {add.isError ? (
        <Notice tone="error" live>
          {add.error.message}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={add.isPending}>
          Add user
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditUserForm({ user, onDone, onSaved }: { user: HouseholdUser; onDone: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const save = useMutation({
    mutationFn: () => api.updateUser(user.id, { name: name.trim(), email: email.trim(), isAdmin }),
    onSuccess: (saved) => {
      refreshAfterUserChange(queryClient);
      onSaved(`Saved ${saved.name}.`);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = nameAndEmailErrors(name, email);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  }

  return (
    <form aria-label={`Change ${user.name}`} className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField label="Name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
      <TextField
        label="Email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
        hint={user.you ? "You sign in with it." : "They sign in with it."}
      />
      <AdminTick checked={isAdmin} onChange={setIsAdmin} />
      {user.you && user.isAdmin && !isAdmin ? (
        <p className="text-sm text-warn">You will no longer be able to add, change or remove users.</p>
      ) : null}
      {save.isError ? (
        <Notice tone="error" live>
          {save.error.message}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NewPasswordForm({ user, onDone, onSaved }: { user: HouseholdUser; onDone: () => void; onSaved: (message: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.setUserPassword(user.id, { password }),
    onSuccess: () => onSaved(`${user.name} has a new password and was signed out everywhere. Tell them the new one.`),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = password.length < MIN_PASSWORD_LENGTH ? `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.` : null;
    setError(found);
    if (!found) save.mutate();
  }

  return (
    <form aria-label={`New password for ${user.name}`} className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        label={`New password for ${user.name}`}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={error}
        hint={`For when they forgot theirs. At least ${MIN_PASSWORD_LENGTH} characters; they are signed out everywhere and can change it under Settings.`}
      />
      {save.isError ? (
        <Notice tone="error" live>
          {save.error.message}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Set password
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RemoveUser({ user, onDone, onRemoved }: { user: HouseholdUser; onDone: () => void; onRemoved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeUser(user.id),
    onSuccess: () => {
      refreshAfterUserChange(queryClient);
      onRemoved(`Removed ${user.name}.`);
    },
  });
  return (
    <div role="group" aria-label={`Remove ${user.name}`} className="flex flex-col gap-3">
      <p className="text-sm">
        Remove <span className="font-medium">{user.name}</span>? They are signed out and can no longer sign in. Emails they marked keep their marks, without
        their name.
      </p>
      {remove.isError ? (
        <Notice tone="error" live>
          {remove.error.message}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
          Remove {user.name}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function UserRow({
  user,
  canManage,
  open,
  setOpen,
  onMessage,
}: {
  user: HouseholdUser;
  canManage: boolean;
  open: Open;
  setOpen: (open: Open) => void;
  onMessage: (message: string) => void;
}) {
  const here = open !== null && open.kind !== "add" && open.id === user.id ? open.kind : null;
  const done = (message: string) => {
    setOpen(null);
    onMessage(message);
  };
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 font-semibold wrap-anywhere">
            {user.name}
            {user.you ? <span className="text-sm font-normal text-muted">(you)</span> : null}
            {user.isAdmin ? (
              <span className="inline-flex items-center gap-1 rounded border border-line bg-surface-muted px-1.5 text-xs font-medium">
                <ShieldCheck aria-hidden className="size-3.5" />
                Admin
              </span>
            ) : null}
          </p>
          <p className="text-sm text-muted wrap-anywhere">{user.email}</p>
          <p className="text-sm text-muted">Added {addedOn(user.createdAt)}</p>
        </div>
        {canManage && here === null ? (
          <div className="flex flex-wrap gap-1">
            {/* Named in full for screen readers; a space inside a hidden span is dropped from the name ("EditSam"). */}
            <Button variant="quiet" className="px-2 py-1" aria-label={`Edit ${user.name}`} onClick={() => setOpen({ kind: "edit", id: user.id })}>
              <Pencil aria-hidden className="size-4" />
              Edit
            </Button>
            {user.you ? null : (
              <>
                <Button
                  variant="quiet"
                  className="px-2 py-1"
                  aria-label={`New password for ${user.name}`}
                  onClick={() => setOpen({ kind: "password", id: user.id })}
                >
                  <KeyRound aria-hidden className="size-4" />
                  New password
                </Button>
                <Button variant="quiet" className="px-2 py-1" aria-label={`Remove ${user.name}`} onClick={() => setOpen({ kind: "remove", id: user.id })}>
                  <Trash2 aria-hidden className="size-4" />
                  Remove
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
      {here === null ? null : (
        <div className="mt-3 rounded-lg border border-line p-3 sm:p-4">
          {here === "edit" ? <EditUserForm user={user} onDone={() => setOpen(null)} onSaved={done} /> : null}
          {here === "password" ? <NewPasswordForm user={user} onDone={() => setOpen(null)} onSaved={done} /> : null}
          {here === "remove" ? <RemoveUser user={user} onDone={() => setOpen(null)} onRemoved={done} /> : null}
        </div>
      )}
    </li>
  );
}

export function UsersCard() {
  const users = useUsers();
  const [open, setOpenState] = useState<Open>(null);
  const [message, setMessage] = useState<string | null>(null);
  const data = users.data;

  function setOpen(next: Open) {
    if (next !== null) setMessage(null);
    setOpenState(next);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Users</h2>
        {data?.canManage && open?.kind !== "add" ? (
          <Button variant="secondary" className="px-3 py-1.5" onClick={() => setOpen({ kind: "add" })}>
            <Plus aria-hidden className="size-4" />
            Add a user
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-muted">
        Everyone here can see and change everything: managing the household's money is a shared effort.
        {data?.canManage ? " As an admin, you can also add, change and remove users." : " An admin adds, changes and removes users."}
      </p>
      {users.isPending ? <LoadingState label="Loading users" /> : null}
      {users.isError ? <ErrorState error={users.error} onRetry={() => void users.refetch()} /> : null}
      {open?.kind === "add" ? (
        <AddUserForm
          onDone={() => setOpen(null)}
          onAdded={(user) => {
            setOpen(null);
            setMessage(`Added ${user.name}. Tell them to sign in with ${user.email} and the password you chose; they can change it under Settings.`);
          }}
        />
      ) : null}
      {/* Always there, so a screen reader hears each new message. */}
      <p role="status" className={message ? "mt-3 text-sm text-muted" : "sr-only"}>
        {message ?? ""}
      </p>
      {data ? (
        <ul className="mt-4 divide-y divide-line border-t border-line pt-4">
          {data.users.map((user) => (
            <UserRow key={user.id} user={user} canManage={data.canManage} open={open} setOpen={setOpen} onMessage={setMessage} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
