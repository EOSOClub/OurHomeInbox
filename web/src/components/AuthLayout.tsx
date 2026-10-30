// The simple centred layout for the screens before sign-in: setup, sign-in,
// and the first loading of the app.

import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <Inbox aria-hidden className="size-6 text-accent" />
        OurHomeInbox
      </div>
      {children}
    </main>
  );
}
