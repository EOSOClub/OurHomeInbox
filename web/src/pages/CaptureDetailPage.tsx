// The page for one captured email: reads the email's address from the page
// URL, fetches it, and shows it with CaptureDetailView, with a button to start
// a biller from its sender.

import { ArrowLeft, Plus } from "lucide-react";
import { Link, useParams } from "react-router";
import { newBillerPathFrom } from "../billers";
import { buttonClasses, ErrorState, LoadingState } from "../components/ui";
import { CaptureDetailView } from "../mail/CaptureDetailView";
import { useCapture } from "../queries";

export function CaptureDetailPage() {
  const { mailbox = "", uidValidity = "", uid = "" } = useParams();
  const capture = useCapture(`${mailbox}/${uidValidity}/${uid}`);
  const newBiller = capture.data ? newBillerPathFrom(capture.data.capture.from) : null;

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
          actions={
            newBiller ? (
              <Link to={newBiller} className={buttonClasses("secondary", "px-3 py-1.5")}>
                <Plus aria-hidden className="size-4" />
                Add the sender as a biller
              </Link>
            ) : undefined
          }
        />
      ) : null}
    </div>
  );
}
