// The frame around every signed-in page: the app name, the household, who is
// signed in, a sign-out button, and the navigation (with a mark on Status
// while a mailbox needs someone).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Inbox, LogOut, Mail, ReceiptText, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { SessionUser } from "../../../src/shared/api";
import { api } from "../api";
import { showSignedOut, useMailboxes } from "../queries";
import { anyMailboxProblem } from "../status";
import { Button, Notice } from "./ui";

function NavItem({ to, active, icon, children }: { to: string; active: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={
        "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium " +
        (active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")
      }
    >
      {/* Text only on a phone, so all the tabs fit across. */}
      <span className="hidden sm:inline-flex">{icon}</span>
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
  const onBillers = pathname === "/billers" || pathname.startsWith("/billers/");
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  // A mark on Status while a mailbox needs someone.
  const mailboxes = useMailboxes();
  const needsYou = mailboxes.data ? anyMailboxProblem(mailboxes.data.mailboxes) : false;

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
          <nav aria-label="Main" className="flex gap-1 overflow-x-auto">
            <NavItem to="/" active={onMail} icon={<Mail aria-hidden className="size-4" />}>
              {/* Shorter on a phone, so all four fit across. */}
              <span className="sm:hidden">Mail</span>
              <span className="hidden sm:inline">Captured mail</span>
            </NavItem>
            <NavItem to="/billers" active={onBillers} icon={<ReceiptText aria-hidden className="size-4" />}>
              Billers
            </NavItem>
            <NavItem to="/status" active={pathname === "/status"} icon={<Activity aria-hidden className="size-4" />}>
              Status
              {needsYou ? (
                <>
                  <span aria-hidden className="size-2 rounded-full bg-warn" />
                  <span className="sr-only">(needs you)</span>
                </>
              ) : null}
            </NavItem>
            <NavItem to="/settings" active={onSettings} icon={<Settings aria-hidden className="size-4" />}>
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
