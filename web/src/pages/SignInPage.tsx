// Sign in with email and password. A wrong password shows the server's own
// message.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { AuthLayout } from "../components/AuthLayout";
import { Button, Card, Notice, TextField } from "../components/ui";
import { queryKeys } from "../queries";

export function SignInPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: api.signIn,
    onSuccess: (session) => queryClient.setQueryData(queryKeys.session, session),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    signIn.mutate({ email: email.trim(), password });
  }

  return (
    <AuthLayout>
      <Card>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit}>
          <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {signIn.isError ? (
            <Notice tone="error" live>
              {signIn.error.message}
            </Notice>
          ) : null}
          <Button type="submit" variant="primary" busy={signIn.isPending}>
            Sign in
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}
