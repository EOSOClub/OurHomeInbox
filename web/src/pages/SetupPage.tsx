// First-time setup: creates the household and its first account, then signs
// that account in. Only shown while no account exists.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { MIN_PASSWORD_LENGTH } from "../../../src/shared/api";
import { api } from "../api";
import { AuthLayout } from "../components/AuthLayout";
import { Button, Card, Notice, TextField } from "../components/ui";
import { queryKeys } from "../queries";

interface SetupForm {
  householdName: string;
  name: string;
  email: string;
  password: string;
  confirm: string;
}

type SetupErrors = Partial<Record<keyof SetupForm, string>>;

export function validateSetup(form: SetupForm): SetupErrors {
  const errors: SetupErrors = {};
  if (!form.householdName.trim()) errors.householdName = "Enter a name for your household.";
  if (!form.name.trim()) errors.name = "Enter your name.";
  if (!form.email.trim()) errors.email = "Enter your email address.";
  if (form.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (form.confirm !== form.password) errors.confirm = "The two passwords do not match.";
  return errors;
}

export function SetupPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SetupForm>({ householdName: "", name: "", email: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<SetupErrors>({});
  const setup = useMutation({
    mutationFn: api.setup,
    onSuccess: (session) => queryClient.setQueryData(queryKeys.session, session),
  });

  const field = (key: keyof SetupForm) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
    error: errors[key],
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validateSetup(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setup.mutate({
      householdName: form.householdName.trim(),
      name: form.name.trim(),
      email: form.email.trim(),
      password: form.password,
    });
  }

  return (
    <AuthLayout>
      <Card>
        <h1 className="text-xl font-semibold">Set up OurHomeInbox</h1>
        <p className="mt-1 text-muted">
          This creates your household and the first account. You can add more people later.
        </p>
        <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <TextField label="Household name" autoComplete="off" required {...field("householdName")} />
          <TextField label="Your name" autoComplete="name" required {...field("name")} />
          <TextField label="Email" type="email" autoComplete="email" required {...field("email")} />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            required
            {...field("password")}
          />
          <TextField label="Confirm password" type="password" autoComplete="new-password" required {...field("confirm")} />
          {setup.isError ? (
            <Notice tone="error" live>
              {setup.error.message}
            </Notice>
          ) : null}
          <Button type="submit" variant="primary" busy={setup.isPending}>
            Create household
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}
