// The household's billers, by name. Each row opens that biller to change or
// delete it.

import { Mail, Plus, ReceiptText } from "lucide-react";
import { Link } from "react-router";
import type { Biller } from "../../../src/shared/api";
import { KIND_LABELS, sendersSummary } from "../billers";
import { buttonClasses, ErrorState, LoadingState, PageTitle } from "../components/ui";
import { plural } from "../format";
import { useBillers } from "../queries";

function BillerRow({ biller }: { biller: Biller }) {
  return (
    <li>
      <Link to={`/billers/${biller.id}`} className="block rounded-lg border border-line bg-surface p-3 hover:bg-surface-muted sm:px-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate font-medium">{biller.name}</span>
          <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted">
            {KIND_LABELS[biller.kind]}
          </span>
        </div>
        <p className="mt-1 flex min-w-0 items-center gap-1 text-sm text-muted">
          <Mail aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            {biller.senders.length ? sendersSummary(biller.senders) : "No email addresses yet"}
          </span>
        </p>
      </Link>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-muted">
      <ReceiptText aria-hidden className="mx-auto mb-2 size-8" />
      <p>No billers yet.</p>
      <p className="mt-1">
        Add the companies your bills come from, like your power company or a streaming service. You can also add one
        from any captured email.
      </p>
    </div>
  );
}

export function BillersPage() {
  const billers = useBillers();
  const all = billers.data?.billers;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-3">
        <PageTitle description="Who your bills come from, and the email addresses they are sent from.">Billers</PageTitle>
        {/* mb-4: on a phone the button wraps under the title and needs the same gap below it. */}
        <Link to="/billers/new" className={buttonClasses("primary", "mb-4 shrink-0")}>
          <Plus aria-hidden className="size-4" />
          Add a biller
        </Link>
      </div>
      {billers.isPending ? <LoadingState label="Loading billers" /> : null}
      {billers.isError ? <ErrorState error={billers.error} onRetry={() => void billers.refetch()} /> : null}
      {all && all.length === 0 ? <EmptyState /> : null}
      {all && all.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-muted">{plural(all.length, "biller", "billers")}</p>
          <ul className="flex flex-col gap-2">
            {all.map((biller) => (
              <BillerRow key={biller.id} biller={biller} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
