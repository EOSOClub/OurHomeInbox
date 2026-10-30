// The frame around every signed-in page: the app name, the household, who is
// signed in, a sign-out button, and the navigation.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Inbox, LogOut, Mail, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { SessionUser } from "../../../src/shared/api";
import { api } from "../api";
import { showSignedOut } from "../queries";
import { Button, Notice } from "./ui";

function NavItem({ to, active, icon, children }: { to: string; active: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={
        "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium " +
        (active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")
      }
    >
      {icon}
      {children}
    </Link>
  );
}

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: () => {
      showSignedOut(queryClient);
      void navigate("/");
    },
  });

  const onMail = pathname === "/" || pathname.startsWith("/mail/");

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-5xl px-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Inbox aria-hidden className="size-6 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="font-semibold leading-tight">OurHomeInbox</p>
                <p className="truncate text-sm text-muted">{user.household.name}</p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm text-muted">
                <span className="sr-only">Signed in as </span>
                {user.name}
              </span>
              <Button variant="quiet" className="px-2 py-1" busy={signOut.isPending} onClick={() => signOut.mutate()}>
                {signOut.isPending ? null : <LogOut aria-hidden className="size-4" />}
                Sign out
              </Button>
            </div>
          </div>
          <nav aria-label="Main" className="flex gap-1">
            <NavItem to="/" active={onMail} icon={<Mail aria-hidden className="size-4" />}>
              Captured mail
            </NavItem>
            <NavItem to="/settings" active={pathname === "/settings"} icon={<Settings aria-hidden className="size-4" />}>
              Settings
            </NavItem>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {signOut.isError ? (
          <Notice tone="error" live className="mb-4">
            Could not sign out: {signOut.error.message}
          </Notice>
        ) : null}
        {children}
      </main>
    </div>
  );
}
