// The list of captured mail, newest first, with a search box that filters it
// in the browser. Each row opens that email.

import { Inbox, Link2, Paperclip, Search } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { CaptureListItem } from "../../../src/shared/api";
import { capturePagePath } from "../api";
import { ErrorState, LoadingState, PageTitle } from "../components/ui";
import { formatDateTime, formatListDate, plural, senderDisplay, subjectDisplay } from "../format";
import { captureDate, filterCaptures } from "../mail/captureList";
import { useCaptures, useSettings } from "../queries";

function Count({ icon, count, one, many }: { icon: ReactNode; count: number; one: string; many: string }) {
  return (
    <span className={"inline-flex items-center gap-1" + (count === 0 ? " opacity-60" : "")} title={plural(count, one, many)}>
      {icon}
      {count}
      <span className="sr-only">{count === 1 ? one : many}</span>
    </span>
  );
}

function CaptureRow({ item }: { item: CaptureListItem }) {
  const when = captureDate(item);
  return (
    <li>
      <Link
        to={capturePagePath(item.id)}
        className="block rounded-lg border border-line bg-surface p-3 hover:bg-surface-muted sm:px-4"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate font-medium">{senderDisplay(item.from)}</span>
          <time dateTime={when} title={formatDateTime(when)} className="shrink-0 text-sm text-muted">
            {formatListDate(when)}
          </time>
        </div>
        <p className="mt-0.5 truncate">{subjectDisplay(item.subject)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span className="inline-flex min-w-0 items-center gap-1">
            <Inbox aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{item.mailbox}</span>
          </span>
          <Count icon={<Paperclip aria-hidden className="size-3.5" />} count={item.attachmentCount} one="attachment" many="attachments" />
          <Count icon={<Link2 aria-hidden className="size-3.5" />} count={item.linkCount} one="link" many="links" />
        </div>
      </Link>
    </li>
  );
}

function EmptyState() {
  const settings = useSettings();
  const minutes = settings.data?.capture.everyMinutes;
  const often = minutes ? (minutes === 1 ? "every minute" : `every ${minutes} minutes`) : "every few minutes";
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-muted">
      <Inbox aria-hidden className="mx-auto mb-2 size-8" />
      <p>No mail captured yet. OurHomeInbox reads each mailbox's bills folder {often}.</p>
    </div>
  );
}

export function CaptureListPage() {
  const captures = useCaptures();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const all = captures.data?.captures;
  const shown = useMemo(() => (all ? filterCaptures(all, query) : []), [all, query]);

  return (
    <div>
      <PageTitle>Captured mail</PageTitle>
      {captures.isPending ? <LoadingState label="Loading captured mail" /> : null}
      {captures.isError ? <ErrorState error={captures.error} onRetry={() => void captures.refetch()} /> : null}
      {all && all.length === 0 ? <EmptyState /> : null}
      {all && all.length > 0 ? (
        <>
          <div className="relative mb-3">
            <label htmlFor={searchId} className="sr-only">
              Search captured mail
            </label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by subject, sender or mailbox"
              className="w-full rounded-md border border-line bg-surface py-2 pr-3 pl-9 text-base placeholder:text-muted"
            />
          </div>
          <p role="status" className="mb-3 text-sm text-muted">
            {query.trim() ? `Showing ${shown.length} of ${plural(all.length, "email", "emails")}` : plural(all.length, "email", "emails")}
          </p>
          {shown.length === 0 ? (
            <p className="py-6 text-center text-muted">No captured mail matches "{query.trim()}".</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((item) => (
                <CaptureRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
