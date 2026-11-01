// The page for one captured email: reads the email's address from the page
// URL, fetches it, and shows it with CaptureDetailView, with its tags to add
// and take off (CaptureTagEditor). Under the details:
// its biller, or, when no biller matches, buttons to start a biller from the
// sender or add the sender to one the household already has.

import { ArrowLeft, Plus, ReceiptText } from "lucide-react";
import { useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { CaptureDetailResponse } from "../../../src/shared/api";
import { addSenderPathFrom, newBillerPathFrom } from "../billers";
import { Button, buttonClasses, ErrorState, LoadingState } from "../components/ui";
import { CaptureDetailView } from "../mail/CaptureDetailView";
import { CaptureTagEditor } from "../mail/CaptureTagEditor";
import { useBillers, useCapture } from "../queries";

const ACTION = "px-3 py-1.5";

/** A list of the household's billers and an Add button, which opens that biller with the sender added. */
function AddToExistingBiller({ detail }: { detail: CaptureDetailResponse }) {
  const billers = useBillers();
  const navigate = useNavigate();
  const selectId = useId();
  const [chosen, setChosen] = useState("");
  const list = billers.data?.billers ?? [];
  if (list.length === 0) return null;

  const path = chosen === "" ? null : addSenderPathFrom(Number(chosen), detail.capture.from);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label htmlFor={selectId} className="sr-only">
        Biller to add the sender to
      </label>
      <select
        id={selectId}
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
        className="min-w-0 max-w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink"
      >
        <option value="">Or add the sender to...</option>
        {list.map((biller) => (
          <option key={biller.id} value={String(biller.id)}>
            {biller.name}
          </option>
        ))}
      </select>
      <Button variant="secondary" className={ACTION} disabled={path === null} onClick={() => path && void navigate(path)}>
        Add
      </Button>
    </div>
  );
}

function BillerActions({ detail }: { detail: CaptureDetailResponse }) {
  if (detail.biller) {
    return (
      <Link to={`/billers/${detail.biller.id}`} className={buttonClasses("secondary", ACTION)}>
        <ReceiptText aria-hidden className="size-4" />
        Open {detail.biller.name}
      </Link>
    );
  }
  const newBiller = newBillerPathFrom(detail.capture.from);
  if (!newBiller) return null;
  return (
    <>
      <Link to={newBiller} className={buttonClasses("secondary", ACTION)}>
        <Plus aria-hidden className="size-4" />
        Add the sender as a biller
      </Link>
      <AddToExistingBiller detail={detail} />
    </>
  );
}

export function CaptureDetailPage() {
  const { mailbox = "", uidValidity = "", uid = "" } = useParams();
  const capture = useCapture(`${mailbox}/${uidValidity}/${uid}`);

  return (
    <div>
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
        <ArrowLeft aria-hidden className="size-4" />
        Back to captured mail
      </Link>
      {capture.isPending ? <LoadingState label="Loading this email" /> : null}
      {capture.isError ? <ErrorState error={capture.error} onRetry={() => void capture.refetch()} /> : null}
      {capture.data ? (
        <CaptureDetailView
          detail={capture.data}
          tags={<CaptureTagEditor detail={capture.data} />}
          // An email with no biller and no From address has nothing to offer here.
          actions={capture.data.biller || newBillerPathFrom(capture.data.capture.from) ? <BillerActions detail={capture.data} /> : undefined}
        />
      ) : null}
    </div>
  );
}
