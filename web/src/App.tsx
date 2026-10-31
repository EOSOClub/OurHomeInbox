// Decides what to show from the session: first-time setup when no account
// exists yet, sign-in when nobody is signed in, otherwise the app and its
// pages.

import { Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { AuthLayout } from "./components/AuthLayout";
import { ErrorState, LoadingState } from "./components/ui";
import { EditBillerPage, NewBillerPage } from "./pages/BillerEditPage";
import { BillersPage } from "./pages/BillersPage";
import { CaptureDetailPage } from "./pages/CaptureDetailPage";
import { CaptureListPage } from "./pages/CaptureListPage";
import { EditMailboxPage, NewMailboxPage } from "./pages/MailboxEditPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { SignInPage } from "./pages/SignInPage";
import { useSession } from "./queries";

export function App() {
  const session = useSession();

  if (session.isPending) {
    return (
      <AuthLayout>
        <LoadingState label="Opening OurHomeInbox" />
      </AuthLayout>
    );
  }
  if (session.isError) {
    return (
      <AuthLayout>
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </AuthLayout>
    );
  }

  const { user, setupNeeded } = session.data;
  if (setupNeeded) return <SetupPage />;
  if (!user) return <SignInPage />;

  return (
    <AppShell user={user}>
      <Routes>
        <Route path="/" element={<CaptureListPage />} />
        <Route path="/mail/:mailbox/:uidValidity/:uid" element={<CaptureDetailPage />} />
        <Route path="/billers" element={<BillersPage />} />
        <Route path="/billers/new" element={<NewBillerPage />} />
        <Route path="/billers/:id" element={<EditBillerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/mailboxes/new" element={<NewMailboxPage />} />
        <Route path="/settings/mailboxes/:id" element={<EditMailboxPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
